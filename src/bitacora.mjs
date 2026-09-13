// ---------------------------------------------------------------------------
// PR-1g — LA BITACORA: UNA LINEA POR INTENTO.
//
// EL AGUJERO QUE CIERRA. `request_id` sale en TODA respuesta desde PR-1b, pero
// solo queda GUARDADO cuando el motor llega a cerrar una respuesta, porque la
// unica fila que lo lleva es la de `answer_log` y esa la escribe `closeOut` en
// engine.mjs. Justo los desenlaces en los que alguien reclama —un 402, un 409,
// un 422, un 500, un reintento servido de la idempotencia— no pasan por ahi.
// Hasta hoy, en todos ellos, le dabamos al cliente un identificador que despues
// no se podia buscar en ninguna parte: el codigo no emitia ni una sola linea de
// registro. Esto la emite.
//
// TRES COSAS DISTINTAS, Y NO HAY QUE MEZCLARLAS NUNCA:
//
//   1. EL CODIGO EMITE UN PAYLOAD ESTRUCTURADO de catorce campos. Esto es lo
//      unico que depende de nosotros, y es verificable localmente: lo verifican
//      las pruebas de test/bitacora.test.mjs, que comprueban que se llama una
//      sola vez, con un solo argumento, que ese argumento es un OBJETO —no una
//      cadena— y que sus claves son exactamente las catorce.
//   2. CLOUDFLARE AÑADE LO SUYO al registro: marca de tiempo, identificadores de
//      la invocacion, resultado, y lo que decida añadir. Eso no lo controlamos y
//      no se duplica aqui; nuestros catorce campos son los que Cloudflare no
//      puede saber.
//   3. QUE ESE REGISTRO SE CONSERVE, DURANTE CUANTO TIEMPO, QUE LOS CATORCE
//      CAMPOS QUEDEN INDEXADOS Y QUE SE PUEDA BUSCAR POR `request_id`: NO
//      DEMOSTRADO. Es validacion en vivo, posterior al despliegue, y hasta
//      hacerla no se afirma en ningun sitio.
//
// `head_sampling_rate = 1` en wrangler.toml dice que no se descarta ninguna
// invocacion. No dice cuanto se retiene, ni que se pueda buscar por un campo
// nuestro, ni que exista tal campo. De ahi NO se deduce ninguna garantia
// operativa, y este comentario esta aqui para que nadie la deduzca luego.
//
// POR QUE SE EMITE UN OBJETO Y NO UNA CADENA. Cloudflare documenta la diferencia
// y no es cosmetica: `console.log("...")` mete todo el contenido dentro de un
// unico campo `message`, y entonces los catorce campos son texto dentro de texto
// — se pueden leer con los ojos, no filtrar por uno de ellos. `console.log({...})`
// es lo que permite que cada campo se pueda extraer e indexar por separado. Con
// una cadena, `request_id` no seria un campo: seria una subcadena. Aqui se pasa
// el objeto, y eso es lo maximo que el codigo puede hacer por el punto 3.
//
// ESTE MODULO NO IMPORTA NADA, a proposito: se carga antes que cualquier otra
// cosa y no puede arrastrar un ciclo al arranque del Worker.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LA LISTA BLANCA DE RUTAS.
//
// Se registran los INTENTOS CONTRA EL SERVICIO, que son los que producen una
// reclamacion. No se registran portada, descubrimiento, manifiestos, fichas,
// sitemap, estadisticas, panel ni el 404 de una ruta que no existe: eso es
// trafico de rastreadores y de curiosos, y meterlo en el registro convierte el
// sitio donde se busca una reclamacion en un sitio del que hay que filtrar antes
// de mirar. Misma leccion que W22 con el registro de respuestas.
//
// `/v1/check_return` ESTA AQUI PORQUE ES EL MISMO ENDPOINT, no por parecido de
// nombre: `despachar`, dentro de `fetch` en index.mjs, manda las dos rutas a la
// MISMA funcion `handleCheck` y con los mismos argumentos, en una sola linea.
// Dejarla fuera seria perder los intentos de quien use el nombre largo.
//
// LA RUTA SALE DE ESTA LISTA, NO DE LA PETICION. Lo que se escribe en el campo
// `ruta` es una de estas tres cadenas literales, nunca lo que venga de fuera. Es
// la razon por la que aqui no puede colarse una cadena de consulta: no es que se
// recorte `url.search`, es que no se llega a mirar.
// ---------------------------------------------------------------------------
const RUTAS = new Set(["/v1/check", "/v1/check_return", "/mcp"]);

// Metodos que el router entiende. Uno raro —y `method` puede ser cualquier
// cadena— se apunta como "otro": es un campo de lista cerrada, no un eco.
const METODOS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Estados de liquidacion que existen. Los pone `handleCheckX402` en index.mjs en
// la cabecera X-ReturnCheck-Settlement; lo que no este en esta lista se apunta
// como null, que es "no lo se".
const LIQUIDACIONES = new Set(["confirmed", "pending", "unconfirmed", "not_charged"]);

// Metodos JSON-RPC que servimos, mas dos marcas nuestras: "lote" para un array
// de mensajes y "otro" para un metodo que no reconocemos. El NOMBRE DE LA
// HERRAMIENTA NO SE REGISTRA: lo elige el cliente y seria texto libre suyo
// dentro de nuestro registro. Una herramienta desconocida se ve igual de bien
// como rpc="tools/call" con rpc_codigo=-32602.
const RPC = new Set(["initialize", "ping", "tools/list", "tools/call", "lote", "otro"]);

// La forma de NUESTROS codigos de error: MAYUSCULAS y guiones bajos, 40 como
// mucho. Lo que no case se apunta como null.
//
// ESTA COMPROBACION ESTA AQUI AUNQUE `conRequestId` YA LA HAGA, y la duplicidad
// es intencionada: quien promete que por el registro no pasa texto del cliente es
// ESTE modulo, asi que la garantia tiene que poder cumplirla el solo, sin
// depender de que quien rellene la libreta la haya filtrado antes. Una prueba
// llama a `registrarIntento` con una libreta sucia hecha a mano precisamente
// para comprobarlo.
const ERROR_CODE_SEGURO = /^[A-Z][A-Z_]{0,39}$/;

const CABECERA_REPLAY = "X-ReturnCheck-Replay";
const CABECERA_LIQUIDACION = "X-ReturnCheck-Settlement";

/** Clasifica un metodo JSON-RPC contra la lista cerrada. Nunca devuelve texto ajeno. */
export function clasificarRpc(metodo) {
  if (typeof metodo !== "string") return "otro";
  return RPC.has(metodo) && metodo !== "lote" && metodo !== "otro" ? metodo : "otro";
}

function entero(v) {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

/**
 * ESCRIBE LA LINEA. Exactamente una por intento, y se llama desde UN SOLO SITIO:
 * `fetch` en index.mjs, despues de tener la respuesta construida y sellada, por
 * el mismo motivo por el que `conRequestId` es un envoltorio — los dos
 * desenlaces, el normal y el del `catch`, confluyen antes de llegar aqui, asi
 * que "una vez" es una propiedad de la forma del codigo y no algo que haya que
 * acordarse de cumplir.
 *
 * NUNCA MODIFICA NI IMPIDE LA RESPUESTA. Recibe la respuesta ya hecha, solo le
 * lee cabeceras, y va entera dentro de un `try`. Si el registro falla, la
 * respuesta se sirve igual. Misma regla 1 que el registro de respuestas.
 *
 * LOS CATORCE CAMPOS SE CONSTRUYEN UNO A UNO, y no hay ningun `...` en toda la
 * funcion. Es deliberado: un objeto desparramado es como entra manaña un campo
 * que nadie ha mirado, y por este registro no puede pasar nada del cliente. Lo
 * que NO se escribe, dicho para que se note si alguien lo añade: cuerpo de la
 * peticion, page_text, page_html, firma, sobre de pago, payment-identifier,
 * claves de API, Authorization, tokens, URL con credenciales, mensajes de error
 * y cualquier otro texto libre de quien llama.
 *
 * `check_id` TAMPOCO ESTA, y no por descuido: sacarlo obligaria a releer y
 * reserializar el cuerpo en el camino feliz, que es justo lo que `conRequestId`
 * evita. El cruce ya existe sin el:
 *
 *     request_id de la linea  ->  answer_log.request_id  ->  check_id
 *
 * Devuelve true si se emitio, false si no. Solo lo miran las pruebas.
 */
export function registrarIntento({ metodo, pathname, respuesta, requestId, ms, apunte } = {}) {
  try {
    // LA PUERTA VA LA PRIMERA, antes de construir nada y antes de cualquier
    // console.log: si la ruta no esta autorizada, aqui no se escribe una linea.
    if (typeof pathname !== "string" || !RUTAS.has(pathname)) return false;

    const cab = respuesta && respuesta.headers ? respuesta.headers : null;
    const liquidacion = cab ? cab.get(CABECERA_LIQUIDACION) : null;
    const a = apunte && typeof apunte === "object" ? apunte : {};

    const linea = {
      msg: "rc.intento",
      v: 1,
      request_id: typeof requestId === "string" ? requestId : null,
      at: new Date().toISOString(),
      metodo: METODOS.has(metodo) ? metodo : "otro",
      ruta: pathname,
      estado: respuesta && Number.isInteger(respuesta.status) ? respuesta.status : null,
      ms: entero(ms),
      replay: !!(cab && cab.get(CABECERA_REPLAY) === "true"),
      liquidacion: LIQUIDACIONES.has(liquidacion) ? liquidacion : null,
      error_code: typeof a.error_code === "string" && ERROR_CODE_SEGURO.test(a.error_code)
        ? a.error_code : null,
      rpc: RPC.has(a.rpc) ? a.rpc : null,
      rpc_n: Number.isInteger(a.rpc_n) && a.rpc_n >= 0 ? a.rpc_n : null,
      rpc_codigo: Number.isInteger(a.rpc_codigo) ? a.rpc_codigo : null,
    };

    // EL OBJETO, NO SU SERIALIZACION. Ver la cabecera: una cadena convierte los
    // catorce campos en texto dentro de `message`, y un objeto es lo que permite
    // que cada uno se pueda extraer por separado. UN SOLO ARGUMENTO, ademas: un
    // segundo argumento se anexa al mensaje y desharia lo mismo.
    console.log(linea);
    return true;
  } catch (_) {
    return false;                 // el registro nunca rompe una respuesta
  }
}
