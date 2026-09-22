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
//   sin id                     ->  se rechaza antes de trabajar o liquidar
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
 * formato. Desde PR-2 el llamador lo trata como obligatorio: sin una identidad
 * estable no existe una puerta capaz de impedir dos liquidaciones concurrentes.
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

const MARCADOR_PENDIENTE = "__RETURNCHECK_PENDING__";
// El peor camino normal suma los plazos de verificacion, motor y /settle. La
// perdedora espera hasta un minuto para poder devolver lo mismo que la ganadora;
// si no termina, responde 409 y un replay posterior recupera el resultado.
const ESPERA_POR_DEFECTO_MS = 60000;
const INTERVALO_POR_DEFECTO_MS = 250;
// Mayor que el timeout de /settle (25 s). Mientras esta ventana siga viva, una
// segunda peticion espera o recibe 409: no se entrega la respuesta antes de
// saber si la propietaria pudo liquidarla. Pasada la ventana, `settling` se
// trata como recuperacion incierta y nunca provoca un segundo /settle.
const RECUPERACION_SETTLING_MS = 120000;

function nuevoIntento() {
  return crypto.randomUUID();
}

async function leerFila(env, id) {
  return await env.DB
    .prepare(
      `SELECT payment_id, fingerprint, response_json, http_status,
              transaction_hash, expires_at, gate_state, attempt_id,
              settlement_state, updated_at
         FROM payment_idempotency
        WHERE payment_id = ?`
    )
    .bind(id)
    .first();
}

function interpretarFila(fila, huellaActual, ahora) {
  if (!fila) return null;
  const estado = fila.gate_state || "completed"; // filas anteriores a schema-005

  // Una fila deja de ser reciclable en cuanto /settle pudo haber salido. Esto
  // incluye confirmado, pendiente, incierto y rechazado: una respuesta negativa
  // del facilitador tampoco autoriza a competir otra vez con la misma firma.
  // Las filas historicas con transaction_hash son tambien monetarias aunque no
  // tengan settlement_state porque nacieron antes de schema-005.
  const estadoMonetario = estado === "settling" || !!fila.transaction_hash ||
    ["confirmed", "pending", "unconfirmed", "rejected"].includes(fila.settlement_state);

  if (!estadoMonetario && fila.expires_at && fila.expires_at <= ahora) return null;
  if (fila.fingerprint !== huellaActual) return { conflicto: true };

  if (estado === "completed" && fila.settlement_state === "rejected") {
    return { rechazado: true };
  }

  if (estado === "completed") {
    return {
      repetido: true,
      cuerpo: fila.response_json,
      estado: fila.http_status || 200,
      transaccion: fila.transaction_hash || null,
      estadoLiquidacion: fila.settlement_state || "replay",
    };
  }

  if (estado === "settling") {
    const actualizado = Date.parse(fila.updated_at || "");
    const instante = Date.parse(ahora);
    const abandonado = Number.isFinite(actualizado) && Number.isFinite(instante) &&
      instante - actualizado >= RECUPERACION_SETTLING_MS;
    if (abandonado && fila.response_json && fila.response_json !== MARCADOR_PENDIENTE) {
      return {
        repetido: true,
        cuerpo: fila.response_json,
        estado: fila.http_status || 200,
        transaccion: fila.transaction_hash || null,
        // Política A: si el proceso cayó después de preparar /settle, se entrega
        // el resultado como incierto y jamás se inicia una segunda liquidación.
        estadoLiquidacion: "unconfirmed",
      };
    }
    return { enCurso: true };
  }

  return { enCurso: true };
}

/**
 * Puerta atómica de PR-2.
 *
 * Solo `meta.changes === 1` concede permiso. Cero significa que otra invocación
 * ya ocupa el identificador; una excepción o una respuesta sin `changes` es un
 * fallo de infraestructura y nunca se disfraza de perdedora.
 */
export async function reclamar(env, { id, huella: h }, ahora = nowISO(), attemptId = nuevoIntento()) {
  if (!env || !env.DB || !id || !h)
    return { error: true, motivo: "Payment gate is not available." };

  try {
    const r = await env.DB.prepare(
      `INSERT INTO payment_idempotency
         (payment_id, fingerprint, response_json, http_status, transaction_hash,
          created_at, expires_at, gate_state, attempt_id, settlement_state, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(payment_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         response_json = excluded.response_json,
         http_status = excluded.http_status,
         transaction_hash = excluded.transaction_hash,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         gate_state = excluded.gate_state,
         attempt_id = excluded.attempt_id,
         settlement_state = excluded.settlement_state,
         updated_at = excluded.updated_at
       WHERE payment_idempotency.expires_at <= excluded.created_at
         AND (
           COALESCE(payment_idempotency.gate_state, 'completed') = 'claimed'
           OR (
             COALESCE(payment_idempotency.gate_state, 'completed') = 'completed'
             AND payment_idempotency.transaction_hash IS NULL
             AND COALESCE(payment_idempotency.settlement_state, 'not_charged') = 'not_charged'
           )
         )`
    ).bind(
      id, h, MARCADOR_PENDIENTE, 0, null,
      ahora, masHoras(ahora, env.IDEMPOTENCY_HOURS),
      "claimed", attemptId, null, ahora
    ).run();

    const cambios = r && r.meta && r.meta.changes;
    if (cambios === 1) return { propietaria: true, attemptId };
    if (cambios !== 0)
      return { error: true, motivo: "Payment gate returned no authoritative row count." };

    const fila = await leerFila(env, id);
    return interpretarFila(fila, h, ahora) || {
      error: true,
      motivo: "Payment gate lost its authoritative row.",
    };
  } catch (_) {
    return { error: true, motivo: "Payment gate is not available." };
  }
}

/** Espera breve para que la perdedora pueda devolver exactamente lo que sirvió la ganadora. */
export async function esperarResultado(
  env, id, h,
  opciones = {}
) {
  const solicitado = opciones.maxMs ?? Number(env && env.PAYMENT_GATE_WAIT_MS);
  const maxMs = Number.isFinite(solicitado) && solicitado >= 0
    ? Math.min(solicitado, 60000)
    : ESPERA_POR_DEFECTO_MS;
  const intervaloMs = opciones.intervaloMs ?? INTERVALO_POR_DEFECTO_MS;
  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, intervaloMs));
    try {
      const estado = interpretarFila(await leerFila(env, id), h, nowISO());
      if (!estado) return { enCurso: true };
      if (!estado.enCurso) return estado;
    } catch (_) {
      return { error: true, motivo: "Payment gate is not available." };
    }
  }
  return { enCurso: true };
}

/** Persiste el resultado ANTES de /settle y deja constancia de que puede estar en vuelo. */
export async function prepararLiquidacion(
  env, { id, huella: h, attemptId, cuerpo, estado = 200 }, ahora = nowISO()
) {
  try {
    const r = await env.DB.prepare(
      `UPDATE payment_idempotency
          SET gate_state = 'settling', response_json = ?, http_status = ?,
              settlement_state = 'unconfirmed', updated_at = ?
        WHERE payment_id = ? AND fingerprint = ? AND attempt_id = ?
          AND gate_state = 'claimed'`
    ).bind(
      typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      estado, ahora, id, h, attemptId
    ).run();
    return !!(r && r.meta && r.meta.changes === 1);
  } catch (_) { return false; }
}

/** Cierra la puerta con la respuesta servida. Solo la propietaria puede hacerlo. */
export async function completar(
  env,
  { id, huella: h, attemptId, cuerpo, estado = 200, transaccion = null,
    estadoLiquidacion = "not_charged" },
  ahora = nowISO()
) {
  try {
    const r = await env.DB.prepare(
      `UPDATE payment_idempotency
          SET gate_state = 'completed', response_json = ?, http_status = ?,
              transaction_hash = ?, settlement_state = ?, updated_at = ?
        WHERE payment_id = ? AND fingerprint = ? AND attempt_id = ?
          AND gate_state IN ('claimed','settling')`
    ).bind(
      typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      estado, transaccion, estadoLiquidacion, ahora, id, h, attemptId
    ).run();
    return !!(r && r.meta && r.meta.changes === 1);
  } catch (_) { return false; }
}

/** Libera únicamente un intento que sabemos que no produjo una liquidación. */
export async function liberar(env, { id, huella: h, attemptId }) {
  try {
    const r = await env.DB.prepare(
      `DELETE FROM payment_idempotency
        WHERE payment_id = ? AND fingerprint = ? AND attempt_id = ?
          AND gate_state = 'claimed'`
    ).bind(id, h, attemptId).run();
    return !!(r && r.meta && r.meta.changes === 1);
  } catch (_) { return false; }
}

/**
 * ¿Hemos visto ya este identificador?
 *
 * Devuelve:
 *   null                          -> no lo hemos visto (o caducó): procesar normal
 *   { repetido: true, ... }       -> misma huella: devolver lo guardado sin cobrar
 *   { conflicto: true }           -> mismo id, otra petición: 409
 *
 * Nunca lanza. Es un auxiliar historico de lectura y NO concede permiso
 * monetario. El camino pagado usa `reclamar`, que ante cualquier fallo de base
 * se detiene: perder la puerta no puede convertirse en permiso para /settle.
 */
export async function consultar(env, id, huellaActual, ahora = nowISO()) {
  try {
    if (!env || !env.DB || !id) return null;
    return interpretarFila(await leerFila(env, id), huellaActual, ahora);
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
    const r = await env.DB.prepare(
      `INSERT INTO payment_idempotency
         (payment_id, fingerprint, response_json, http_status, transaction_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(payment_id) DO NOTHING`
    ).bind(
      id, h,
      typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      estado, transaccion, ahora,
      masHoras(ahora, env.IDEMPOTENCY_HOURS)
    ).run();
    return !!(r && r.meta && r.meta.changes === 1);
  } catch (_) { return false; }
}

/** Barrido de caducados. Como el del registro: prometer un plazo y no barrer es peor que no prometerlo. */
export async function purgarCaducados(env, ahora = nowISO()) {
  try {
    const r = await env.DB.prepare(
      `DELETE FROM payment_idempotency
        WHERE expires_at <= ?
          AND (
            COALESCE(gate_state, 'completed') = 'claimed'
            OR (
              COALESCE(gate_state, 'completed') = 'completed'
              AND transaction_hash IS NULL
              AND COALESCE(settlement_state, 'not_charged') = 'not_charged'
            )
          )`
    ).bind(ahora).run();
    return { rows_affected: (r.meta && r.meta.changes) || 0 };
  } catch (_) { return { rows_affected: 0 }; }
}
