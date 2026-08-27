// W31 — IDEMPOTENCIA: que un reintento no cobre dos veces.
//
// EL PROBLEMA, y no es teórico. Un agente paga, nosotros respondemos, y la
// respuesta se pierde por el camino — un corte de red, un tiempo de espera
// agotado, un contenedor que se reinicia. El agente no sabe si le llegó; lo único
// razonable que puede hacer es reintentar. Y un agente reintenta solo, sin
// pensárselo, a la velocidad que le dé la gana.
//
// Sin protección, ese reintento es un segundo cobro por la misma pregunta. A 0,02 $
// parece poca cosa. No lo es: es que el cliente no puede confiar en reintentar, y
// un cliente que no puede reintentar acaba escribiendo código a la defensiva
// alrededor nuestro — o se va.
//
// Y hay un motivo más frío: Atinamos y compañía prueban servicios de pago y
// PUBLICAN lo que observan. Cobrar dos veces por un reintento no es un fallo
// interno que se arregla en silencio: es una nota en un expediente público que no
// controlamos.
//
// LA SOLUCIÓN YA ESTÁ EN EL ESTÁNDAR y no hay que inventarla — extensión
// Payment-Identifier de x402. El cliente manda un identificador; nosotros
// guardamos la respuesta atada a él.
//
// LA REGLA, tal como la fija la especificación:
//
//   mismo id + misma huella   ->  se devuelve lo guardado, SIN cobrar otra vez
//   mismo id + huella DISTINTA ->  409 Conflict
//   id caducado                ->  se procesa como nuevo
//   sin id                     ->  se procesa normal, sin guardar nada
//
// POR QUÉ EL 409 ES LO IMPORTANTE, más que la caché: sin él, un cliente podría
// pagar UNA vez y reutilizar ese identificador para preguntar por mil productos
// distintos. La huella lo impide, y por eso incluye el CUERPO de la petición: en
// nuestro caso la pregunta ES la operación. La especificación pide un
// «application-level operation identifier when available»; aquí lo que está
// disponible es la pregunta entera.
//
// SOLO SE GUARDAN LAS RESPUESTAS QUE SE SIRVIERON. Un fallo no se cachea: si
// cacheáramos el error, el reintento —que es justo lo que el cliente debe hacer
// cuando algo falla— quedaría bloqueado para siempre por su propio identificador.

import { nowISO } from "./util.mjs";
import { sha256full } from "./corpus.mjs";

// 16-128 caracteres, alfanuméricos con guiones y guiones bajos. Lo fija la
// extensión; se valida porque este valor acaba siendo una clave de base de datos.
const ID_RE = /^[a-zA-Z0-9_-]{16,128}$/;

const HORAS_POR_DEFECTO = 24;

/**
 * Saca el identificador del pago. Devuelve null si no viene o si no cumple el
 * formato — un identificador inválido se ignora, no se rechaza la petición: el
 * cliente pierde la protección, no el servicio.
 */
export function leerIdentificador(pago) {
  try {
    const ext = pago && pago.payload && pago.payload.extensions;
    const id = ext && ext["payment-identifier"];
    if (typeof id !== "string") return null;
    return ID_RE.test(id) ? id : null;
  } catch (_) { return null; }
}

/**
 * Serialización canónica: las claves ORDENADAS, recursivamente.
 *
 * Sin esto la huella sería inútil. `JSON.stringify` respeta el orden en que se
 * insertaron las claves, y ese orden depende del cliente: la misma petición
 * mandada dos veces por dos bibliotecas distintas daría dos huellas distintas, y
 * el reintento legítimo se leería como un conflicto.
 */
export function canonico(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonico).join(",") + "]";
  const claves = Object.keys(v).sort();
  return "{" + claves.map((k) => JSON.stringify(k) + ":" + canonico(v[k])).join(",") + "}";
}

/**
 * La huella de la petición. Lo que la especificación pide, más el cuerpo.
 *
 * Los campos de dinero (scheme, network, asset, amount, payTo) van dentro porque
 * un identificador no puede servir para pagar otra cosa. La ruta y el método,
 * porque no puede servir para otra operación. Y el cuerpo, porque en ReturnCheck
 * la pregunta ES la operación: sin él, un pago compraría respuestas ilimitadas.
 */
export async function huella({ aceptado = {}, metodo = "POST", ruta = "/", cuerpo = null } = {}) {
  return await sha256full(canonico({
    scheme: aceptado.scheme || null,
    network: aceptado.network || null,
    asset: (aceptado.asset || "").toLowerCase() || null,
    amount: String(aceptado.amount ?? ""),
    payTo: (aceptado.payTo || "").toLowerCase() || null,
    metodo: String(metodo).toUpperCase(),
    ruta,
    cuerpo,
  }));
}

function masHoras(iso, horas) {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + Number(horas || HORAS_POR_DEFECTO));
  return d.toISOString();
}

/**
 * ¿Hemos visto ya este identificador?
 *
 * Devuelve:
 *   null                          -> no lo hemos visto (o caducó): procesar normal
 *   { repetido: true, ... }       -> misma huella: devolver lo guardado sin cobrar
 *   { conflicto: true }           -> mismo id, otra petición: 409
 *
 * Nunca lanza. Si la base falla, se devuelve null y la consulta sigue su curso:
 * perder la protección de idempotencia es malo, pero tumbar una consulta que el
 * cliente está pagando es peor.
 */
export async function consultar(env, id, huellaActual, ahora = nowISO()) {
  try {
    if (!env || !env.DB || !id) return null;
    const fila = await env.DB
      .prepare("SELECT payment_id, fingerprint, response_json, http_status, transaction_hash, expires_at FROM payment_idempotency WHERE payment_id = ?")
      .bind(id).first();
    if (!fila) return null;

    // Caducado: la especificacion dice procesar como nuevo.
    if (fila.expires_at && fila.expires_at <= ahora) return null;

    if (fila.fingerprint !== huellaActual) return { conflicto: true };

    return {
      repetido: true,
      cuerpo: fila.response_json,
      estado: fila.http_status || 200,
      transaccion: fila.transaction_hash || null,
    };
  } catch (_) { return null; }
}

/**
 * Guarda una respuesta YA SERVIDA. Nunca lanza.
 *
 * Se llama solo cuando la respuesta salió bien. Un fallo no se guarda a propósito:
 * cachear el error dejaría al cliente sin poder reintentar, que es justo lo que
 * debe hacer cuando algo falla.
 */
export async function guardar(env, { id, huella: h, cuerpo, estado = 200, transaccion = null }, ahora = nowISO()) {
  try {
    if (!env || !env.DB || !id || !h) return false;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO payment_idempotency
         (payment_id, fingerprint, response_json, http_status, transaction_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      id, h,
      typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      estado, transaccion, ahora,
      masHoras(ahora, env.IDEMPOTENCY_HOURS)
    ).run();
    return true;
  } catch (_) { return false; }
}

/** Barrido de caducados. Como el del registro: prometer un plazo y no barrer es peor que no prometerlo. */
export async function purgarCaducados(env, ahora = nowISO()) {
  try {
    const r = await env.DB.prepare("DELETE FROM payment_idempotency WHERE expires_at <= ?").bind(ahora).run();
    return { rows_affected: (r.meta && r.meta.changes) || 0 };
  } catch (_) { return { rows_affected: 0 }; }
}
