// Utilidades compartidas.

// W19 — La versión del código vive aquí, no en index.mjs, porque ahora la
// necesitan dos sitios: la ruta que la publica y el registro de respuestas, que
// sin ella no puede decir QUÉ build dio una respuesta concreta. Es el dato que
// convierte "respondimos mal" en "respondimos mal con este código, y lo
// arreglamos en este otro".
//
// PR-1c — Y AHORA YA NO SE ESCRIBE A MANO. Aquí había una cadena literal, y una
// cadena literal solo dice la verdad si alguien se acuerda de cambiarla: el
// commit de W57 (9a6d4e7) no la cambió, y durante seis días este servicio
// anunció un build que no era el suyo. Se deriva del commit y de su fecha
// (`src/build-info.mjs`), y quien no genere el sello obtiene "unknown", que es
// la verdad. Se reexporta desde aquí para no mover a sus cuatro consumidores.
export { BUILD } from "./build-info.mjs";

export function nowISO() {
  return new Date().toISOString();
}
export function todayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Respuestas JSON con cabeceras estándar.
export function json(obj, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Error del contrato (check_return.error.v1). Nunca se cobra.
export function errorResponse(code, message, httpStatus, details) {
  const body = { error: { code, message } };
  if (details) body.error.details = details;
  return json(body, { status: httpStatus });
}

// ---------------------------------------------------------------------------
// PR-1 — EL IDENTIFICADOR DE PETICIÓN.
//
// PARA QUÉ SIRVE, que no es lo mismo que `check_id`. `check_id` identifica una
// RESPUESTA del motor y solo existe si el motor llegó a contestar
// (engine.mjs:595). Cuando algo se cae —un 402, un 409, un 500— no hay
// `check_id` que citar, y hasta hoy el cliente se quedaba sin NADA con lo que
// volver a nosotros. `request_id` existe SIEMPRE, desde la primera línea del
// router, y por eso es el que se puede pedir en una reclamación.
//
// EL PREFIJO NO ES DECORACIÓN: `rc_req_` es lo que hace que un identificador
// pegado por un tercero en un correo se pueda encontrar con un `grep` sobre los
// registros sin sacar además todos los UUID del mundo.
// ---------------------------------------------------------------------------

const REQUEST_ID_PREFIJO = "rc_req_";

export function newRequestId() {
  const u = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    // Mismo respaldo que `uuid()` en answerlog.mjs: sin `crypto` no nos quedamos
    // sin identificador, que es justo lo que este módulo existe para evitar.
    : Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  return REQUEST_ID_PREFIJO + u;
}

export const REQUEST_ID_HEADER = "X-ReturnCheck-Request-Id";

/**
 * SELLA UNA RESPUESTA CON SU `request_id`, Y SE APLICA EN UN SOLO SITIO.
 *
 * POR QUÉ UN ENVOLTORIO Y NO UN PARÁMETRO EN CADA `errorResponse`. La otra
 * opción era pasar el identificador a las ~40 llamadas de `errorResponse` y
 * `json` que hay repartidas por el router. Se ha descartado por la misma razón
 * que cobro-x402.mjs existe: lo que hay que acordarse de poner en cuarenta
 * sitios acaba faltando en uno, y el que falte será precisamente el camino raro
 * por el que alguien llame para reclamar. Aquí pasa TODA respuesta del Worker,
 * incluidas las rutas que se añadan mañana sin leer este comentario.
 *
 * LA CABECERA VA SIEMPRE. El cuerpo se toca SOLO en respuestas de error y solo
 * si es JSON: una respuesta buena no se vuelve a serializar, así que el camino
 * caliente no paga nada por esto.
 *
 * OJO CON `error`, QUE SIGNIFICA DOS COSAS DISTINTAS EN ESTE SERVICIO:
 *
 *   · `{ error: { code, message } }`      el contrato de error (util.mjs)
 *   · `{ x402Version, error: "texto", …}` el reto de pago (x402.mjs:149-158)
 *
 * En el primero el identificador va DENTRO de `error`, que es donde el cliente
 * lo va a buscar. En el segundo `error` es una cadena y meterle un campo dentro
 * sería corromper el reto, así que va en la raíz. Nunca se toca `accepts` ni
 * `resource`: el contrato con el agente y con el facilitador se queda como está.
 *
 * Y NO SE TOCA EL SOBRE `PAYMENT-REQUIRED`, que se construye aparte en
 * index.mjs:853 sobre `r.reto` y no pasa por aquí. Esa era la regla de W32 —en
 * el sobre no se mete nada que el facilitador no espere— y sigue en pie.
 *
 * Nunca lanza: si el cuerpo no se puede releer o no era JSON, se devuelve la
 * respuesta con la cabecera puesta. Perder el campo del cuerpo es malo; tumbar
 * una respuesta buena por intentar añadirlo sería peor.
 */
export async function conRequestId(resp, requestId) {
  try {
    if (!resp || !requestId) return resp;

    const cabeceras = new Headers(resp.headers);
    cabeceras.set(REQUEST_ID_HEADER, requestId);

    const esJson = /application\/json/i.test(resp.headers.get("content-type") || "");
    if (resp.status < 400 || !esJson)
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: cabeceras });

    const texto = await resp.text();
    let cuerpo;
    try { cuerpo = JSON.parse(texto); } catch (_) { cuerpo = null; }
    if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo))
      return new Response(texto, { status: resp.status, statusText: resp.statusText, headers: cabeceras });

    if (cuerpo.error && typeof cuerpo.error === "object" && !Array.isArray(cuerpo.error))
      cuerpo.error.request_id = requestId;
    else
      cuerpo.request_id = requestId;

    return new Response(JSON.stringify(cuerpo), {
      status: resp.status, statusText: resp.statusText, headers: cabeceras,
    });
  } catch (_) {
    return resp;                                  // nunca rompe una respuesta
  }
}

// Clave de API pública para un cliente nuevo.
export function newApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "rc_live_" + hex;
}

// Huella (hash) del texto de la política -> policy_version.
export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

// Normaliza una URL de producto para clave de caché: quita parámetros de tracking y fragmento.
export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    const drop = [...url.searchParams.keys()].filter((k) => /^(utm_|gclid|fbclid|ref|_ga)/i.test(k));
    drop.forEach((k) => url.searchParams.delete(k));
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

// Suma días a una fecha YYYY-MM-DD -> YYYY-MM-DD.
export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
