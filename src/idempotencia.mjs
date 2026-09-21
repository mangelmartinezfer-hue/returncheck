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
 *   { enCurso: true, ... }        -> PR-2: otra petición lo reclamó y sigue trabajando
 *
 * Nunca lanza. Si la base falla, se devuelve null y la consulta sigue su curso:
 * perder la protección de idempotencia es malo, pero tumbar una consulta que el
 * cliente está pagando es peor. (OJO: esa política vale para esta lectura, que es
 * informativa. La PUERTA de `reclamar` falla cerrado, y ahí el motivo es el
 * contrario: sin puerta no se puede impedir el cobro doble.)
 */
export async function consultar(env, id, huellaActual, ahora = nowISO()) {
  try {
    if (!env || !env.DB || !id) return null;
    const fila = await env.DB
      .prepare("SELECT payment_id, fingerprint, response_json, http_status, transaction_hash, expires_at, status, claimed_at FROM payment_idempotency WHERE payment_id = ?")
      .bind(id).first();
    if (!fila) return null;

    // Caducado: la especificacion dice procesar como nuevo.
    if (fila.expires_at && fila.expires_at <= ahora) return null;

    if (fila.fingerprint !== huellaActual) return { conflicto: true };

    // Una fila escrita antes de PR-2 no tiene `status`. Es una respuesta ya
    // servida, o sea 'done'. No se le inventa otro significado.
    if (fila.status === "in_flight")
      return { enCurso: true, reclamadoEn: fila.claimed_at || null };

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

// ---------------------------------------------------------------------------
// PR-2 — LA PUERTA. BLQ-X402-GATE-01.
//
// `guardar` de aquí arriba NO es una puerta y nunca lo fue: un `INSERT OR
// REPLACE` siempre tiene éxito, así que jamás devuelve el cero que distingue al
// perdedor de una carrera. Y estaba DESPUÉS de /settle, con lo cual dos
// peticiones con el mismo identificador liquidaban las dos.
//
// Lo que sigue lo cierra. Una sola regla, y conviene leerla despacio:
//
//   EL PERMISO LO DA EL MOTOR, NO NOSOTROS.
//
// El número de filas afectadas que devuelve D1 es el único permiso válido. Un
// `catch` que ponga un cero a mano está fabricando un permiso que nadie le dio:
// una excepción significa «no sé si entró», y «no sé» no es «no entró». Por eso
// un fallo aquí devuelve `indeterminado` y el cobro se detiene, en lugar de
// seguir y arriesgarse a liquidar dos veces.
// ---------------------------------------------------------------------------

// Cuánto se espera antes de dar por muerta una reclamación colgada. Tiene que
// ser MAYOR que el plazo de /settle: si no, se podría adelantar a una petición
// que todavía está liquidando, que es justo lo que venimos a impedir.
const VENTANA_RECLAMACION_MS = 120000;

function restarMs(iso, ms) {
  return new Date(new Date(iso).getTime() - Number(ms)).toISOString();
}

/**
 * Reclama el identificador ANTES de verificar, de gastar el motor y de liquidar.
 *
 * Devuelve exactamente uno de:
 *   { dueno: true }            -> la fila es nuestra. Solo aquí se puede liquidar.
 *   { repetido: true, ... }    -> ya había respuesta guardada: se devuelve tal cual.
 *   { conflicto: true }        -> mismo identificador, otra pregunta: 409.
 *   { enCurso: true }          -> otro la tiene y sigue viva: que reintente luego.
 *   { indeterminado: true }    -> no se pudo establecer la puerta. NO se liquida.
 */
export async function reclamar(env, { id, huella: h, ventanaMs = null } = {}, ahora = nowISO()) {
  if (!env || !env.DB || !id || !h) return { indeterminado: true, motivo: "sin_base_o_sin_id" };

  const caduca = masHoras(ahora, env.IDEMPOTENCY_HOURS);
  let res;
  try {
    res = await env.DB.prepare(
      `INSERT INTO payment_idempotency
         (payment_id, fingerprint, response_json, http_status, transaction_hash, created_at, expires_at, status, claimed_at)
       VALUES (?,?,'',0,NULL,?,?,'in_flight',?)
       ON CONFLICT (payment_id) DO NOTHING`
    ).bind(id, h, ahora, caduca, ahora).run();
  } catch (e) {
    return { indeterminado: true, motivo: String((e && e.message) || e) };
  }

  const cambios = Number(res && res.meta && res.meta.changes);
  if (cambios === 1) return { dueno: true };
  if (!Number.isFinite(cambios)) return { indeterminado: true, motivo: "changes_no_obtenido" };

  // cambios === 0, dicho por el motor: la fila ya existía. Hay que mirar cuál es.
  const previo = await consultar(env, id, h, ahora);

  if (previo && previo.conflicto) return { conflicto: true };
  if (previo && previo.repetido) return previo;

  if (previo && previo.enCurso) {
    // Otra petición la tiene. Solo se le quita si lleva colgada más que la
    // ventana, y solo con la MISMA huella: adelantarse a una liquidación viva
    // sería exactamente el fallo que PR-2 viene a cerrar.
    const limite = restarMs(ahora, ventanaMs == null ? (Number(env.IDEMPOTENCY_CLAIM_MS) || VENTANA_RECLAMACION_MS) : ventanaMs);
    if (!previo.reclamadoEn || previo.reclamadoEn > limite) return { enCurso: true };
    try {
      const t = await env.DB.prepare(
        `UPDATE payment_idempotency SET claimed_at = ?
           WHERE payment_id = ? AND fingerprint = ? AND status = 'in_flight' AND claimed_at <= ?`
      ).bind(ahora, id, h, limite).run();
      return Number(t && t.meta && t.meta.changes) === 1 ? { dueno: true } : { enCurso: true };
    } catch (e) {
      return { indeterminado: true, motivo: String((e && e.message) || e) };
    }
  }

  // `consultar` devolvió null con la fila existiendo: está caducada. La
  // especificación dice procesarla como nueva, así que se toma — pero con la
  // condición de caducidad dentro del UPDATE, para que la decida el motor.
  try {
    const t = await env.DB.prepare(
      `UPDATE payment_idempotency
         SET fingerprint = ?, response_json = '', http_status = 0, transaction_hash = NULL,
             created_at = ?, expires_at = ?, status = 'in_flight', claimed_at = ?
       WHERE payment_id = ? AND expires_at <= ?`
    ).bind(h, ahora, caduca, ahora, id, ahora).run();
    return Number(t && t.meta && t.meta.changes) === 1 ? { dueno: true } : { indeterminado: true, motivo: "fila_ilegible" };
  } catch (e) {
    return { indeterminado: true, motivo: String((e && e.message) || e) };
  }
}

/**
 * Suelta una reclamación NUESTRA. Solo se llama cuando consta que no se movió
 * dinero: verificación fallida, error del motor, o una liquidación que ni
 * siquiera llegó a salir. Si hay la menor duda de que el facilitador pudo
 * ejecutar la transferencia, la reclamación se queda donde está.
 */
export async function liberar(env, id) {
  try {
    if (!env || !env.DB || !id) return false;
    const r = await env.DB
      .prepare("DELETE FROM payment_idempotency WHERE payment_id = ? AND status = 'in_flight'")
      .bind(id).run();
    return Number(r && r.meta && r.meta.changes) === 1;
  } catch (_) { return false; }
}

/** Cierra la reclamación con la respuesta ya servida. Solo toca la fila si sigue siendo nuestra. */
export async function finalizar(env, { id, cuerpo, estado = 200, transaccion = null }, ahora = nowISO()) {
  try {
    if (!env || !env.DB || !id) return false;
    const r = await env.DB.prepare(
      `UPDATE payment_idempotency
         SET response_json = ?, http_status = ?, transaction_hash = ?, status = 'done',
             created_at = ?, expires_at = ?
       WHERE payment_id = ? AND status = 'in_flight'`
    ).bind(
      typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      estado, transaccion, ahora, masHoras(ahora, env.IDEMPOTENCY_HOURS), id
    ).run();
    return Number(r && r.meta && r.meta.changes) === 1;
  } catch (_) { return false; }
}

/** Barrido de caducados. Como el del registro: prometer un plazo y no barrer es peor que no prometerlo. */
export async function purgarCaducados(env, ahora = nowISO()) {
  try {
    const r = await env.DB.prepare("DELETE FROM payment_idempotency WHERE expires_at <= ?").bind(ahora).run();
    return { rows_affected: (r.meta && r.meta.changes) || 0 };
  } catch (_) { return { rows_affected: 0 }; }
}
