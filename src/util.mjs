// Utilidades compartidas.

// W19 — La versión del código vive aquí, no en index.mjs, porque ahora la
// necesitan dos sitios: la ruta que la publica y el registro de respuestas, que
// sin ella no puede decir QUÉ build dio una respuesta concreta. Es el dato que
// convierte "respondimos mal" en "respondimos mal con este código, y lo
// arreglamos en este otro".
//
// PR-1c — Y AHORA YA NO SE ESCRIBE A MANO. Aquí había una cadena literal, y una
// cadena literal solo dice la verdad si alguien se acuerda de cambiarla. No se
// acordó: el commit de W57 (9a6d4e7) tocó código y NO actualizó esta constante,
// que se quedó anunciando W56. W57 no llegó a desplegarse, así que ese desajuste
// no llegó a servirse — pero de haberse desplegado, el servicio habría anunciado
// un build que no era el suyo, y desde fuera no habría forma de saberlo. El
// mecanismo no lo impedía; que no ocurriera fue suerte.
//
// Ahora se deriva del commit y de su fecha (ver `derivarBuild` en
// build-reglas.mjs). Se reexporta desde aquí para no mover a sus consumidores.
//
// SIN EL FICHERO GENERADO ESTO NO CARGA. `build-info.mjs` importa el sello de
// forma ESTÁTICA, así que si falta, el módulo no llega a evaluarse y el Worker no
// arranca — no degrada a "unknown". `"unknown"` es otra cosa: es lo que sale
// cuando el sello SÍ existe pero sus campos son nulos, que es el caso de haberlo
// generado fuera de un repositorio git. Ver la cabecera de build-info.mjs.
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
// RESPUESTA del motor y solo existe si el motor llegó a contestar: lo asigna
// `closeOut` en engine.mjs, al final del todo. Cuando algo se cae —un 402, un
// 409, un 500— no hay `check_id` que citar, y hasta hoy el cliente se quedaba sin
// NADA con lo que volver a nosotros. `request_id` existe SIEMPRE, desde la
// primera línea del router, y por eso es el que se puede pedir en una
// reclamación.
//
// EL PREFIJO NO ES DECORACIÓN: `rc_req_` es lo que hace que un identificador
// pegado por un tercero en un correo se pueda buscar sin sacar además todos los
// UUID del mundo. DÓNDE se busca: en la columna `answer_log.request_id` cuando el
// motor llegó a contestar, y en la línea que emite `registrarIntento`
// (bitacora.mjs) en los demás casos. Que esas líneas se conserven y se puedan
// consultar en Cloudflare NO está demostrado todavía: eso es validación posterior
// al despliegue, y hasta hacerla no se afirma.
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
 *   · `{ x402Version, error: "texto", …}` el reto de pago (`retoDePago`, x402.mjs)
 *
 * En el primero el identificador va DENTRO de `error`, que es donde el cliente
 * lo va a buscar. En el segundo `error` es una cadena y meterle un campo dentro
 * sería corromper el reto, así que va en la raíz. Nunca se toca `accepts` ni
 * `resource`: el contrato con el agente y con el facilitador se queda como está.
 *
 * Y NO SE TOCA EL SOBRE `PAYMENT-REQUIRED`, que construye `reto402` en
 * index.mjs sobre `r.reto` y no pasa por aquí. Esa era la regla de W32 —en el
 * sobre no se mete nada que el facilitador no espere— y sigue en pie.
 *
 * PR-1e — Y TAMPOCO SE TOCA UNA RESPUESTA JSON-RPC. Ver `esRespuestaJsonRpc`
 * aquí abajo: ese cuerpo ya trae el identificador donde su protocolo lo guarda,
 * y añadírselo otra vez creaba un campo que JSON-RPC no contempla.
 *
 * Nunca lanza: si el cuerpo no se puede releer o no era JSON, se devuelve la
 * respuesta con la cabecera puesta. Perder el campo del cuerpo es malo; tumbar
 * una respuesta buena por intentar añadirlo sería peor.
 *
 * `apunte` es un objeto OPCIONAL que se rellena de paso, nunca se lee: recoge
 * `error_code` para la bitácora (ver `registrarIntento` en bitacora.mjs). Se
 * aprovecha que aquí ya se analiza el cuerpo de los errores, para no volver a
 * leerlo después. Si no se pasa, esta función se comporta igual que antes.
 */
export async function conRequestId(resp, requestId, apunte = null) {
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

    anotarErrorCode(apunte, cuerpo);

    // PR-1e — UNA SOLA FORMA POR PROTOCOLO. Un error JSON-RPC sale de aquí tal y
    // como lo construyó `rpcError` en mcp.mjs, con el identificador en
    // `error.data` y en ningún sitio más.
    if (esRespuestaJsonRpc(cuerpo))
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

/**
 * PR-1e — ¿ES ESTE CUERPO UNA RESPUESTA DE ERROR JSON-RPC 2.0?
 *
 * POR QUÉ HACE FALTA. El error de PARSEO del MCP es el único error JSON-RPC que
 * sale con código HTTP >= 400 (los demás salen con 200), así que era el único
 * que llegaba a la rama de arriba. Allí `cuerpo.error` es un objeto, y el
 * envoltorio le metía un `request_id` al lado de `data`. Resultado: el MISMO
 * identificador en dos sitios y, peor, un campo que la especificación JSON-RPC
 * 2.0 no contempla — el objeto de error admite `code`, `message` y `data`.
 *
 * POR QUÉ SE EXIGE LA FORMA ENTERA Y NO SOLO `jsonrpc`. Clasificar por tener una
 * propiedad suelta es cómo se acaba tratando como JSON-RPC un cuerpo que no lo
 * es, y entonces un error NUESTRO se quedaría sin identificador en el cuerpo sin
 * que nadie se entere. Se piden las seis condiciones de una respuesta de error
 * del protocolo:
 *
 *   · `jsonrpc` es exactamente la cadena "2.0"  (no "truthy", no 2.0 numérico)
 *   · el miembro `id` está PRESENTE, aunque valga null (lo vale en el parse error)
 *   · NO hay `result`: `result` y `error` se excluyen mutuamente
 *   · `error` es un objeto, no un array
 *   · `error.code` es un NÚMERO — aquí es donde se separa solo del contrato de
 *     ReturnCheck, cuyo `code` es una CADENA ("INVALID_INPUT", "CONFLICT"...)
 *   · `error.message` es una cadena
 *
 * El contrato de error de ReturnCheck no cumple ninguna de las tres primeras, de
 * modo que sigue recibiendo su `error.request_id` como siempre. Hay prueba que
 * lo fija por los dos lados.
 */
function esRespuestaJsonRpc(cuerpo) {
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return false;
  if (cuerpo.jsonrpc !== "2.0") return false;
  if (!("id" in cuerpo)) return false;
  if ("result" in cuerpo) return false;
  const e = cuerpo.error;
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  return typeof e.code === "number" && typeof e.message === "string";
}

/**
 * PR-1g — EL CÓDIGO DE ERROR, PARA LA BITÁCORA, SIN TEXTO DEL CLIENTE.
 *
 * Solo se apunta un `code` que tenga la forma de los nuestros: MAYÚSCULAS y
 * guiones bajos, 40 caracteres como mucho. No es decoración: es lo que garantiza
 * que por este campo no pueda colarse una frase, una URL ni un secreto aunque
 * alguien, algún día, ponga en `code` algo que no sea una constante nuestra. Lo
 * que no case, se apunta como `null`, que es "no lo sé" y no una invención.
 *
 * El `code` de JSON-RPC es un número y por eso no casa: esa información viaja en
 * `rpc_codigo`, que la pone mcp.mjs.
 */
const ERROR_CODE_SEGURO = /^[A-Z][A-Z_]{0,39}$/;

function anotarErrorCode(apunte, cuerpo) {
  if (!apunte || typeof apunte !== "object") return;
  const code = cuerpo && cuerpo.error && typeof cuerpo.error === "object" && !Array.isArray(cuerpo.error)
    ? cuerpo.error.code
    : null;
  if (typeof code === "string" && ERROR_CODE_SEGURO.test(code)) apunte.error_code = code;
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
