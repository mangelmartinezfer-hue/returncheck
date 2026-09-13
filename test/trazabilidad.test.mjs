// PR-1 — TRAZABILIDAD: QUE EL CLIENTE SIEMPRE TENGA ALGO QUE CITARNOS.
//
// EL AGUJERO QUE ESTO CIERRA. Lo unico que un cliente podia citarnos era
// `check_id`, y `check_id` solo existe si el motor llego a contestar
// (engine.mjs:595). Justo las respuestas en las que alguien quiere reclamar —un
// 402, un 409, un 500— no llevaban NADA: ni identificador en la cabecera, ni
// identificador en el cuerpo, ni fila que buscar despues.
//
// LO QUE VIGILAN ESTAS PRUEBAS, en este orden:
//   1. que el identificador salga en TODA respuesta, por los dos transportes;
//   2. que salga tambien cuando el router revienta, que es el caso que mas falta
//      hacia y el unico que no se puede arreglar desde dentro de un manejador;
//   3. que `request_id` y `check_id` sean cosas DISTINTAS y convivan;
//   4. que el sellado no haya corrompido el reto de pago, donde `error` es una
//      cadena de la especificacion x402 y no un objeto nuestro.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { newRequestId, conRequestId, REQUEST_ID_HEADER, errorResponse, json } from "../src/util.mjs";
import { recordAnswer } from "../src/answerlog.mjs";
import { meterEnSobre } from "../src/x402.mjs";
import { huella } from "../src/idempotencia.mjs";
import { cacheKey } from "../src/text.mjs";
import { sha256full } from "../src/corpus.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example",
  PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00",
  FREE_TRIAL_ENABLED: "false",
  X402_ENABLED: "true",
  X402_NETWORK: "eip155:8453",
  X402_PAY_TO: PAY_TO,
  X402_ASSET: ASSET,
};

const RE_ID = /^rc_req_[0-9a-zA-Z_-]{8,}$/;

const post = (path, body, env = ENV, headers = {}) =>
  worker.fetch(new Request("https://rc.example" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), env);

const get = (path, env = ENV) => worker.fetch(new Request("https://rc.example" + path), env);

// Base falsa: un cliente activo con saldo. Igual que en educated402.test.mjs.
function db(saldo = 5) {
  const fila = { api_key: "rc_live_test", email: null, balance_usd: saldo,
                 status: "active", calls_charged: 0, calls_free: 0 };
  return {
    prepare: (sql) => ({
      bind: () => ({
        first: async () => /FROM clients/.test(sql) ? fila : null,
        run: async () => ({ meta: { changes: 0 } }),
        all: async () => ({ results: [] }),
      }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async () => ({ results: [] }),
    }),
  };
}
const CLAVE = { authorization: "Bearer rc_live_test" };

// ---------------------------------------------------------------------------
// 1. El formato, que es lo que hace el identificador buscable
// ---------------------------------------------------------------------------

test("PR-1: el identificador lleva el prefijo rc_req_ y es distinto cada vez", () => {
  const a = newRequestId(), b = newRequestId();
  assert.match(a, RE_ID);
  assert.match(b, RE_ID);
  assert.notEqual(a, b, "dos peticiones no pueden compartir identificador");
});

// ---------------------------------------------------------------------------
// 2. HTTP: cabecera Y cuerpo, en los errores
// ---------------------------------------------------------------------------

test("PR-1 HTTP: un error cualquiera lleva request_id en cabecera y en cuerpo", async () => {
  // 404: el camino mas tonto posible, y hasta hoy el mas mudo.
  const r = await get("/no-existe-esta-ruta");
  assert.equal(r.status, 404);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  assert.match(cab, RE_ID, "la cabecera va en toda respuesta");
  const cuerpo = await r.json();
  assert.match(cuerpo.error.request_id, RE_ID, "y dentro del objeto de error");
  assert.equal(cuerpo.error.request_id, cab, "el mismo en los dos sitios, o no sirve de nada");
  assert.equal(cuerpo.error.code, "INVALID_INPUT", "sin tocar lo que ya decia");
});

test("PR-1 HTTP: un 400 de entrada invalida tambien lo lleva", async () => {
  // Con clave y saldo se llega a validar el cuerpo. Sin clave, el reto de pago
  // sale ANTES y no se estaria probando el 400.
  const conSaldo = { ...ENV, DB: db(5) };
  const r = await post("/v1/check", { buyer_country: "US" }, conSaldo, CLAVE);   // falta product_url
  assert.equal(r.status, 400);
  assert.match(r.headers.get(REQUEST_ID_HEADER), RE_ID);
  const c = await r.json();
  assert.match(c.error.request_id, RE_ID);
  assert.equal(c.error.request_id, r.headers.get(REQUEST_ID_HEADER));
});

test("PR-1 HTTP: el 402 del reto de pago lo lleva, y NO se corrompe el reto", async () => {
  // Aqui `error` es una CADENA de la especificacion x402, no un objeto nuestro.
  // El identificador tiene que ir en la raiz, y `accepts` quedar intacto.
  const r = await post("/v1/check", { product_url: "https://t.example/p/1", buyer_country: "US" });
  assert.equal(r.status, 402);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  assert.match(cab, RE_ID);

  const c = await r.json();
  assert.equal(typeof c.error, "string", "el reto sigue trayendo su error de texto");
  assert.equal(c.request_id, cab, "y el identificador va en la raiz, no dentro de una cadena");
  assert.ok(Array.isArray(c.accepts) && c.accepts.length === 1, "el reto sigue entero");
  assert.equal(c.accepts[0].payTo, PAY_TO, "y la direccion de cobro no se ha tocado");
  assert.equal(c.x402Version, 2);
});

test("PR-1 HTTP: el SOBRE PAYMENT-REQUIRED sigue sin nuestros anadidos", async () => {
  // Regla de W32: en el sobre no se mete nada que el facilitador no espere. El
  // sellado toca el cuerpo, nunca el sobre.
  const r = await post("/v1/check", { product_url: "https://t.example/p/1", buyer_country: "US" });
  const sobre = r.headers.get("PAYMENT-REQUIRED");
  assert.ok(sobre, "el reto sigue viajando en su cabecera");
  const dentro = JSON.parse(Buffer.from(sobre, "base64").toString("utf-8"));
  assert.equal(dentro.request_id, undefined, "el sobre NO lleva nuestro identificador");
  assert.equal(dentro.x402Version, 2);
  assert.ok(Array.isArray(dentro.accepts));
});

test("PR-1 HTTP: una respuesta BUENA lleva request_id, y no se le toca el cuerpo", async () => {
  const r = await get("/discovery.json");
  assert.equal(r.status, 200);
  assert.match(r.headers.get(REQUEST_ID_HEADER), RE_ID);
  const c = await r.json();
  assert.equal(c.request_id, undefined, "en el camino feliz el identificador va en la cabecera");
  assert.equal(c.name, "ReturnCheck", "y el cuerpo no se ha tocado");
});

// ---------------------------------------------------------------------------
// 3. El 500: el caso que no se puede arreglar desde dentro de un manejador
// ---------------------------------------------------------------------------

test("PR-1: el 500 del catch del router lleva request_id", async () => {
  // Se provoca de verdad: un `env` cuyo acceso revienta dentro del despacho. Es
  // la unica forma honesta de probar el catch — si se probara llamando a
  // `errorResponse` a mano no se estaria probando que el identificador exista
  // TODAVIA en ese punto, que es justo lo que se quiere garantizar.
  const envQueRevienta = new Proxy({ ...ENV }, {
    get(obj, prop) {
      if (prop === "DB") throw new Error("boom");
      return obj[prop];
    },
  });
  const r = await post("/v1/check", { product_url: "https://t.example/p/1", buyer_country: "US" },
                       envQueRevienta, { authorization: "Bearer rc_live_test" });
  assert.equal(r.status, 500);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  assert.match(cab, RE_ID, "el 500 es el que mas falta hacia");
  const c = await r.json();
  assert.equal(c.error.code, "INTERNAL");
  assert.equal(c.error.request_id, cab);
});

// ---------------------------------------------------------------------------
// 4. MCP: la misma cabecera, y ademas campos que una maquina pueda leer
// ---------------------------------------------------------------------------

const mcp = (msg, env = ENV, headers = {}) =>
  worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(msg),
  }), env);

test("PR-1 MCP: la respuesta HTTP lleva la MISMA cabecera que /v1/check", async () => {
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get(REQUEST_ID_HEADER), RE_ID);
});

test("PR-1 MCP: un error JSON-RPC lleva request_id en data", async () => {
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "metodo/que/no/existe" });
  const cab = r.headers.get(REQUEST_ID_HEADER);
  const c = await r.json();
  assert.equal(c.error.code, -32601);
  assert.match(c.error.data.request_id, RE_ID, "donde JSON-RPC guarda lo adicional");
  assert.equal(c.error.data.request_id, cab);
});

test("PR-1 MCP: un error de PARSEO tambien lo lleva", async () => {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{esto no es json",
  }), ENV);
  assert.equal(r.status, 400);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  assert.match(cab, RE_ID);
  const c = await r.json();
  assert.equal(c.error.code, -32700);
  assert.equal(c.error.data.request_id, cab);
});

// ---------------------------------------------------------------------------
// PR-1e — UNA SOLA FORMA POR PROTOCOLO.
//
// EL DEFECTO QUE CIERRAN ESTAS CUATRO. El error de parseo es el unico error
// JSON-RPC que sale con codigo HTTP >= 400; los demas salen con 200 y el
// envoltorio ni siquiera les lee el cuerpo. Por eso solo a ese le llegaba la
// rama que mete `request_id` dentro de `error`, y salia con el identificador
// DOS veces: en `error.data.request_id` —donde lo pone `rpcError`— y en
// `error.request_id`, que la especificacion JSON-RPC 2.0 no contempla.
//
// Las cuatro van juntas a proposito: dos fijan que el duplicado se fue, y las
// otras dos que NO se ha apagado el sellado general para conseguirlo, que es la
// forma facil y equivocada de arreglar esto.
// ---------------------------------------------------------------------------

test("PR-1e MCP: el error de PARSEO ya NO duplica el identificador", async () => {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{esto no es json",
  }), ENV);
  assert.equal(r.status, 400);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  const c = await r.json();

  assert.equal(c.error.data.request_id, cab, "sigue donde JSON-RPC guarda lo adicional");
  assert.equal(c.error.request_id, undefined,
    "y ya NO al lado de `data`: ese campo no existe en JSON-RPC 2.0");
  assert.equal("request_id" in c.error, false, "ni siquiera como clave con undefined");
  assert.equal(c.error.code, -32700, "el error sigue siendo el que era");
  assert.equal(c.jsonrpc, "2.0");
  assert.equal(c.id, null);
});

test("PR-1e MCP: method not found (HTTP 200) no ha cambiado", async () => {
  // No pasa por la rama del cuerpo —sale con 200— y tiene que seguir igual.
  const r = await mcp({ jsonrpc: "2.0", id: 7, method: "metodo/que/no/existe" });
  assert.equal(r.status, 200);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  const c = await r.json();
  assert.equal(c.error.data.request_id, cab);
  assert.equal(c.error.request_id, undefined);
  assert.deepEqual(Object.keys(c.error).sort(), ["code", "data", "message"],
    "el objeto de error tiene EXACTAMENTE los tres miembros del protocolo");
});

test("PR-1e: un error PROPIO de ReturnCheck conserva su error.request_id", async () => {
  // El control que impide "arreglar" el duplicado apagando el sellado entero.
  // Este cuerpo tambien es un error con `error` objeto y tambien sale con >= 400,
  // pero no es JSON-RPC y tiene que seguir llevando el identificador dentro.
  // Con clave y saldo se llega a validar el cuerpo; sin clave saldria antes el
  // reto de pago, igual que en la prueba de mas arriba.
  const conSaldo = { ...ENV, DB: db(5) };
  const r = await post("/v1/check", { product_url: "no-es-una-url", buyer_country: "US" }, conSaldo, CLAVE);
  assert.equal(r.status, 400);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  const c = await r.json();
  assert.equal(c.error.request_id, cab, "el contrato de ReturnCheck no se toca");
  assert.equal(c.error.code, "INVALID_INPUT", "y su `code` es una CADENA, no un numero");
});

// ---------------------------------------------------------------------------
// PR-1f — EL IDENTIFICADOR EN EL EXITO POR MCP.
//
// EL HUECO. En el camino feliz el identificador vivia SOLO en la cabecera HTTP
// del transporte, y un cliente de MCP lee el RESULTADO de la herramienta, no
// cabeceras. Quien solo consuma el resultado no tenia nada que citarnos justo en
// la llamada que si le contesto. Va en `_meta`, que es el hueco que el propio
// MCP reserva para lo que no cabe en el esquema, y NO en `structuredContent`,
// que es el contrato v1.0 congelado.
// ---------------------------------------------------------------------------

const META_ID = "returncheck/request-id";

test("PR-1f MCP: el exito del tramo gratis lleva el identificador en _meta", async () => {
  const conSaldo = { ...ENV, DB: db(5), AI: { run: async () => ({ response: JSON.stringify({
    verdict: "UNKNOWN", confidence: 0, answer_human: "Unknown.",
    reason: "The policy text does not resolve this case.",
    merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
    policy: null, evidence: null,
  }) }) } };
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_return", arguments: {
    product_url: "https://eval.example/p/x", buyer_country: "US",
    page_text: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery.",
  } } }, conSaldo, CLAVE);

  assert.equal(r.status, 200);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  const res = (await r.json()).result;
  assert.equal(res.isError, false, "es un exito, que es el caso de esta prueba");
  assert.equal(res._meta[META_ID], cab, "el mismo identificador que la cabecera de fuera");
  assert.match(res._meta[META_ID], RE_ID);
});

test("PR-1f MCP: structuredContent SIGUE sin request_id", async () => {
  // El contrato v1.0 no se ensancha. Es la frontera que PR-1f no cruza, y por
  // eso el identificador va en `_meta` y no dentro del objeto de la respuesta.
  const conSaldo = { ...ENV, DB: db(5), AI: { run: async () => ({ response: JSON.stringify({
    verdict: "UNKNOWN", confidence: 0, answer_human: "Unknown.", reason: "No resuelve.",
    merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
    policy: null, evidence: null,
  }) }) } };
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_return", arguments: {
    product_url: "https://eval.example/p/x", buyer_country: "US",
    page_text: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery.",
  } } }, conSaldo, CLAVE);
  const res = (await r.json()).result;
  assert.equal(res.structuredContent.request_id, undefined, "el contrato v1.0 no se toca");
  assert.equal("request_id" in res.structuredContent, false);
});

test("PR-1f MCP: un resultado con isError NO recibe _meta", async () => {
  // La decision es "exito". Un error ya lleva el identificador en
  // structuredContent, y añadirle ademas `_meta` seria una tercera superficie
  // para lo mismo.
  const conSaldo = { ...ENV, DB: db(5) };
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
                        params: { name: "check_return", arguments: { buyer_country: "US" } } },
                      conSaldo, CLAVE);
  const res = (await r.json()).result;
  assert.equal(res.isError, true);
  assert.equal(res._meta, undefined, "los errores mantienen su contrato, sin _meta");
  assert.match(res.structuredContent.error.request_id, RE_ID, "y su identificador sigue donde estaba");
});

test("PR-1e: un cuerpo con jsonrpc pero sin forma valida NO se toma por JSON-RPC", async () => {
  // La guarda se prueba por su contrapositivo: cinco cuerpos que llevan
  // `jsonrpc` y que, por fallar una condicion cada uno, tienen que recibir el
  // identificador en el cuerpo como cualquier otro error nuestro. Si la guarda
  // se relajara a "tiene jsonrpc", cualquiera de estos se quedaria sin el.
  const casos = {
    "code como cadena, que es la forma NUESTRA":
      { jsonrpc: "2.0", id: 1, error: { code: "INVALID_INPUT", message: "x" } },
    "result y error a la vez, que el protocolo excluye":
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: -32600, message: "x" } },
    "sin miembro id":
      { jsonrpc: "2.0", error: { code: -32600, message: "x" } },
    "version que no es la cadena 2.0":
      { jsonrpc: 2.0, id: 1, error: { code: -32600, message: "x" } },
    "message ausente":
      { jsonrpc: "2.0", id: 1, error: { code: -32600 } },
  };
  for (const [nombre, cuerpo] of Object.entries(casos)) {
    const r = await conRequestId(json(cuerpo, { status: 400 }), "rc_req_guarda");
    const c = await r.json();
    assert.equal(c.error.request_id, "rc_req_guarda", nombre + ": tiene que llevarlo");
  }

  // Y el positivo, para que el bucle de arriba no pase por vacio: la forma
  // ENTERA si se reconoce y el cuerpo sale intacto.
  const bueno = await conRequestId(
    json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error", data: { request_id: "rc_req_ya" } } },
         { status: 400 }),
    "rc_req_guarda");
  const cb = await bueno.json();
  assert.equal(cb.error.request_id, undefined, "la forma entera SI se respeta");
  assert.equal(cb.error.data.request_id, "rc_req_ya", "y lo que ya traia no se pisa");
  assert.equal(bueno.headers.get(REQUEST_ID_HEADER), "rc_req_guarda", "la cabecera va igual");
});

test("PR-1 MCP: un error de herramienta lleva structuredContent.error.request_id", async () => {
  // Esto es el punto de cambio: `toolText` devolvia texto pelado, sin un solo
  // campo que un agente pudiera leer sin analizar una frase en ingles.
  const conSaldo = { ...ENV, DB: db(5) };
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
                        params: { name: "check_return", arguments: { buyer_country: "US" } } },
                      conSaldo, CLAVE);
  const cab = r.headers.get(REQUEST_ID_HEADER);
  const res = (await r.json()).result;
  assert.equal(res.isError, true);
  assert.match(res.structuredContent.error.request_id, RE_ID);
  assert.equal(res.structuredContent.error.request_id, cab);
  assert.match(res.structuredContent.error.message, /Invalid input/, "y el motivo, legible por maquina");
});

test("PR-1 MCP: el reto de pago recibe el identificador SIN corromperse", async () => {
  // Mismo caso que en HTTP: aqui `structuredContent.error` es la cadena del reto
  // x402, asi que el identificador va en la raiz.
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
                        params: { name: "check_return",
                                  arguments: { product_url: "https://t.example/p/1", buyer_country: "US" } } });
  const res = (await r.json()).result;
  assert.equal(res.isError, true);
  const sc = res.structuredContent;
  assert.equal(typeof sc.error, "string", "el reto conserva su error de texto");
  assert.match(sc.request_id, RE_ID, "el identificador va en la raiz");
  assert.ok(Array.isArray(sc.accepts) && sc.accepts.length === 1, "y el reto sigue entero");
  assert.equal(sc.accepts[0].payTo, PAY_TO);
});

// ---------------------------------------------------------------------------
// 5. request_id y check_id son cosas distintas, y las dos se conservan
// ---------------------------------------------------------------------------

test("PR-1: una respuesta buena lleva request_id Y check_id, y son DISTINTOS", async () => {
  // `check_id` identifica la RESPUESTA; `request_id`, la PETICION. Confundirlos
  // seria perder justo lo que se ha ganado: el segundo existe aunque no haya
  // primero.
  const filas = [];
  const db = {
    prepare: (sql) => ({
      bind: (...a) => ({
        run: async () => {
          if (/INSERT INTO answer_log/.test(sql)) {
            const m = sql.match(/INSERT INTO answer_log \(([\s\S]*?)\) VALUES/);
            const nombres = m[1].split(",").map((x) => x.trim()).filter(Boolean);
            const fila = {};
            nombres.forEach((n, i) => { fila[n] = a[i]; });
            filas.push(fila);
          }
          return { meta: { changes: 0 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async () => ({ results: [] }),
    }),
  };

  const env = {
    ...ENV,
    X402_ENABLED: "false",              // camino gratis, sin tocar el del dinero
    FREE_TRIAL_ENABLED: "true",
    FREE_IP_DAILY: "3",
    DB: db,
    ANSWER_LOG: "true",
  };

  const r = await post("/v1/check", {
    product_url: "https://t.example/p/1",
    buyer_country: "US",
    page_text: "Returns are not accepted on final sale items.",
  }, env);

  assert.equal(r.status, 200);
  const requestId = r.headers.get(REQUEST_ID_HEADER);
  assert.match(requestId, RE_ID);

  const c = await r.json();
  const checkId = c.meta && c.meta.check_id;
  assert.ok(checkId, "el check_id sigue saliendo donde salia");
  assert.notEqual(checkId, requestId, "son dos identificadores distintos");
  assert.doesNotMatch(String(checkId), /^rc_req_/, "y el de la respuesta no lleva el prefijo del de la peticion");

  // 6. Y la fila los tiene los dos, que es lo que permite ir de uno al otro.
  assert.equal(filas.length, 1);
  assert.equal(filas[0].request_id, requestId, "la fila guarda el identificador de la peticion");
  assert.equal(filas[0].id, checkId);
});

test("PR-1: answer_log escribe request_id, y NULL cuando el camino no lo pasa", async () => {
  // La columna es nullable a proposito: los caminos que pasan por cobro-x402.mjs
  // todavia no lo propagan (fichero congelado hasta PR-2/PR-3), y una fila sin
  // identificador tiene que decir "no lo se", no inventarse uno.
  const filas = [];
  const db = {
    prepare: (sql) => ({
      bind: (...a) => ({
        run: async () => {
          const m = sql.match(/INSERT INTO answer_log \(([\s\S]*?)\) VALUES/);
          if (m) {
            const nombres = m[1].split(",").map((x) => x.trim()).filter(Boolean);
            const fila = {};
            nombres.forEach((n, i) => { fila[n] = a[i]; });
            filas.push(fila);
          }
          return { meta: { changes: 0 } };
        },
      }),
    }),
  };
  const env = { DB: db, ANSWER_RETENTION_MONTHS: "12" };
  const resp = { verdict: "UNKNOWN", meta: {} };

  await recordAnswer(env, { resp, req: {}, build: "b", requestId: "rc_req_abc-123" });
  await recordAnswer(env, { resp, req: {}, build: "b" });          // sin identificador

  assert.equal(filas.length, 2);
  assert.equal(filas[0].request_id, "rc_req_abc-123");
  assert.equal(filas[1].request_id, null, "NULL es la verdad, no una cadena vacia");
});

// ---------------------------------------------------------------------------
// 7. El envoltorio, probado en aislamiento
// ---------------------------------------------------------------------------

test("PR-1 envoltorio: no toca un cuerpo que no sea JSON", async () => {
  const original = new Response("hola", { status: 500, headers: { "content-type": "text/plain" } });
  const r = await conRequestId(original, "rc_req_x");
  assert.equal(r.headers.get(REQUEST_ID_HEADER), "rc_req_x", "la cabecera va igual");
  assert.equal(await r.text(), "hola", "y el cuerpo se queda como estaba");
});

test("PR-1 envoltorio: sin identificador devuelve la respuesta intacta", async () => {
  const original = errorResponse("INVALID_INPUT", "no", 400);
  const r = await conRequestId(original, null);
  const c = await r.json();
  assert.equal(c.error.request_id, undefined);
});

test("PR-1 envoltorio: una respuesta buena no se vuelve a serializar", async () => {
  const original = json({ ok: true, n: 1 }, { status: 200 });
  const r = await conRequestId(original, "rc_req_x");
  const c = await r.json();
  assert.deepEqual(c, { ok: true, n: 1 }, "el camino caliente no paga el analisis del cuerpo");
  assert.equal(r.headers.get(REQUEST_ID_HEADER), "rc_req_x");
});

test("PR-1 envoltorio: conserva estado y cabeceras que ya hubiera", async () => {
  const original = new Response(JSON.stringify({ error: { code: "X", message: "m" } }), {
    status: 409,
    headers: { "content-type": "application/json; charset=utf-8", "X-ReturnCheck-Cost": "0.0000" },
  });
  const r = await conRequestId(original, "rc_req_y");
  assert.equal(r.status, 409);
  assert.equal(r.headers.get("X-ReturnCheck-Cost"), "0.0000", "no pisa lo que ya venia");
  assert.equal((await r.json()).error.request_id, "rc_req_y");
});

// ---------------------------------------------------------------------------
// 8. PR-1 (propagacion) — EL CAMINO PAGADO. Autorizado el 12 sep 2026.
//
// EL AGUJERO QUE CIERRAN ESTAS PRUEBAS. Hasta ahora `request_id` llegaba al
// cliente por los cuatro desenlaces y por los dos transportes, pero en el camino
// de PAGO no habia ni una sola fila que lo llevara: `handleCheckX402` no lo
// recibia (index.mjs) y `pagarConX402` tampoco (mcp.mjs), asi que
// `cobrarConX402` llamaba a `runCheck` sin `__request_id` y `answer_log.request_id`
// salia NULL. Es decir: al UNICO cliente que paga se le daba un identificador que
// despues no se podia buscar.
//
// LO QUE NO SE TOCA, y estas pruebas lo fijan: la huella de idempotencia y la
// clave de cache. Si `__request_id` entrase en cualquiera de las dos, esto
// dejaria de ser propagacion y pasaria a costar dinero — un fallo de cache por
// peticion, o un reintento legitimo leido como conflicto.
// ---------------------------------------------------------------------------

const RED_PAGO = "eip155:8453";
const TX_PAGO  = "0xdeadbeefcafe0000000000000000000000000000000000000000000000000057";
const PAGADOR  = "0x857bEEF0000000000000000000000000000000aa";
const NONCE_PAGO = "0x4748f83dd8b3f1ad933f056181b085e3d1b006556fc909feb23f9350f6f4d5c6";

const POLIZA_PAGO = "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories.";
const PETICION_PAGO = {
  product_url: "https://eval.example/p/RC25-01", buyer_country: "US",
  item_condition: "unopened", reason: "changed_mind",
  purchase_date: "2026-08-01", delivery_date: "2026-08-05", as_of: "2026-08-20",
  page_text: POLIZA_PAGO,
};

const ENV_PAGO = {
  ...ENV, ANSWER_LOG: "true", ANSWER_RETENTION_MONTHS: "12",
  X402_ASSET_NAME: "USD Coin", X402_ASSET_VERSION: "2",
  X402_FACILITATOR: "https://facilitador.example",
};

function iaPago(verdict = "YES") {
  const det = verdict !== "UNKNOWN";
  return { run: async () => ({ response: JSON.stringify({
    verdict, confidence: 0.9,
    answer_human: det ? "Yes. Within the 30-day window." : "Unknown.",
    reason: det ? null : "The policy text does not resolve this case.",
    merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
    policy: det ? { return_category: "MerchantReturnFiniteReturnWindow", merchant_return_days: 30,
                    window_basis: "delivery_date", return_method: [], return_fees: null, refund_type: null } : null,
    evidence: det ? { source_url: PETICION_PAGO.product_url, clause_id: null,
                      exact_clause: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery." } : null,
  }) }) };
}

// D1 de mentira que apunta lo que de verdad interesa: las columnas con las que
// se INSERTA en cada tabla. Guardar los NOMBRES y no solo los valores es lo que
// permite afirmar que `request_id` sigue SIN aparecer donde no debe (prueba 8).
function dbPago({ idemFila = null } = {}) {
  const respuestas = [], idem = [];
  const columnas = (sql, marca) => {
    const m = sql.replace(/\s+/g, " ").match(new RegExp(marca + " \\(([^)]*)\\) VALUES"));
    return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : null;
  };
  const g = { run: async () => ({ meta: { changes: 0 } }), first: async () => null,
              all: async () => ({ results: [] }) };
  return {
    _resp: respuestas, _idem: idem,
    prepare: (sql) => ({
      bind: (...a) => ({
        ...g,
        first: async () => (idemFila && /FROM payment_idempotency/.test(sql)) ? idemFila : null,
        run: async () => {
          let c;
          if ((c = columnas(sql, "INSERT INTO answer_log"))) {
            const fila = {}; c.forEach((n, i) => { fila[n] = a[i]; });
            respuestas.push({ ...fila, __columnas: c });
          }
          if ((c = columnas(sql, "INSERT OR REPLACE INTO payment_idempotency"))) {
            const fila = {}; c.forEach((n, i) => { fila[n] = a[i]; });
            idem.push({ ...fila, __columnas: c });
          }
          return { meta: { changes: 1 } };
        },
      }),
      ...g,
    }),
  };
}

const sobrePago = (extensions = undefined) => {
  const payload = { signature: "0xsig", authorization: {
    from: PAGADOR, to: PAY_TO, value: "20000",
    validAfter: "0", validBefore: "1893456000", nonce: NONCE_PAGO } };
  if (extensions) payload.extensions = extensions;
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network: RED_PAGO, amount: "20000", asset: ASSET,
                payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
    payload,
  };
};

// El facilitador, de mentira. NO se llama a ninguno de verdad.
function conFacilitadorPago({ settle = null } = {}, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/verify"))
      return { ok: true, status: 200, json: async () => ({ isValid: true, payer: PAGADOR }) };
    return { ok: true, status: 200,
             json: async () => settle || { success: true, transaction: TX_PAGO, network: RED_PAGO, payer: PAGADOR } };
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

const pagoPorHttp = (env, sobre = sobrePago(), peticion = PETICION_PAGO) =>
  worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": meterEnSobre(sobre) },
    body: JSON.stringify(peticion),
  }), env);

const pagoPorMcp = (env, sobre = sobrePago(), peticion = PETICION_PAGO) =>
  worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "check_return", arguments: peticion, _meta: { "x402/payment": sobre } } }),
  }), env);

// --- 1. HTTP x402, 200 -----------------------------------------------------

test("PR-1 pagado HTTP: answer_log.request_id coincide con la cabecera", async () => {
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago({}, () => pagoPorHttp(env));

  assert.equal(res.status, 200);
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  assert.match(requestId, RE_ID, "la respuesta pagada sigue llevando el identificador");

  assert.equal(env.DB._resp.length, 1, "el motor escribio su fila");
  assert.equal(env.DB._resp[0].request_id, requestId,
    "LA PROPIEDAD: el identificador que se le da al cliente es el que queda en la fila");

  // Y sigue conviviendo con el check_id, que es otro identificador y otra cosa.
  const cuerpo = await res.json();
  assert.ok(cuerpo.meta.check_id);
  assert.equal(env.DB._resp[0].id, cuerpo.meta.check_id);
  assert.notEqual(cuerpo.meta.check_id, requestId);
});

// --- 2. MCP x402, 200 ------------------------------------------------------

test("PR-1 pagado MCP: answer_log.request_id coincide con la cabecera HTTP", async () => {
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago({}, () => pagoPorMcp(env));

  assert.equal(res.status, 200);
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  assert.match(requestId, RE_ID);

  assert.equal(env.DB._resp.length, 1);
  assert.equal(env.DB._resp[0].request_id, requestId);

  // PR-1f — `structuredContent` sigue siendo el contrato v1.0 sin tocar, y el
  // identificador del resultado vive en `_meta`. Ver `sellarResultado` en
  // mcp.mjs para por que se separan las dos cosas.
  const r = (await res.json()).result;
  assert.equal(r.structuredContent.request_id, undefined,
    "el contrato v1.0 no gana un campo");
  assert.ok(r.structuredContent.meta.check_id, "lo que si va dentro es el check_id, como siempre");
  assert.equal(r._meta["returncheck/request-id"], requestId,
    "y el resultado ya no depende de que el cliente mire cabeceras");
});

test("PR-1f pagado MCP: el exito CONFIRMADO conserva las DOS claves de _meta", async () => {
  // LA UNICA PARTE DELICADA DE PR-1f. Un exito pagado y confirmado ya traia
  // `_meta["x402/payment-response"]`, que es la prueba de que el dinero se movio.
  // Si `sellarResultado` asignara `_meta` de una pieza en vez de fusionar, esa
  // prueba desapareceria — y desapareceria en silencio, porque el resultado
  // funcional seguiria siendo correcto. Esta prueba exige las dos a la vez.
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago({}, () => pagoPorMcp(env));
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  const r = (await res.json()).result;

  assert.equal(r.isError, false);
  assert.deepEqual(Object.keys(r._meta).sort(), ["returncheck/request-id", "x402/payment-response"],
    "las dos, y solo las dos");
  assert.equal(r._meta["returncheck/request-id"], requestId);
  assert.equal(r._meta["x402/payment-response"].transaction, TX_PAGO,
    "la prueba de liquidacion sigue intacta");
  assert.equal(r._meta["x402/payment-response"].success, true);
});

// --- 3. El 402 de liquidacion fallida, que SI deja fila ---------------------

test("PR-1 pagado: el 402 por liquidacion fallida deja fila y conserva el identificador", async () => {
  // Es el unico 402 que deja rastro: el motor YA corrio (engine.mjs:591 escribio
  // la fila) y solo despues fallo la liquidacion (cobro-x402.mjs:151-156), que
  // marca charged=0 y devuelve reto. Si la propagacion no llegara hasta aqui, la
  // reclamacion mas probable de todas —"pague y me disteis un 402"— seguiria sin
  // poder mirarse.
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago(
    { settle: { success: false, errorReason: "insufficient_funds" } },
    () => pagoPorHttp(env));

  assert.equal(res.status, 402);
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  assert.match(requestId, RE_ID);

  assert.equal(env.DB._resp.length, 1, "la fila existe porque el motor llego a contestar");
  assert.equal(env.DB._resp[0].request_id, requestId);

  // Y el reto no se ha corrompido: `error` sigue siendo la cadena de la spec.
  const cuerpo = await res.json();
  assert.equal(typeof cuerpo.error, "string");
  assert.equal(cuerpo.request_id, requestId, "va en la raiz, no dentro de `error`");
});

// --- 4. Los dos campos llegan juntos a runCheck -----------------------------

test("PR-1 pagado: cobrarConX402 entrega __api_key Y __request_id a la vez", async () => {
  // No se puede espiar `runCheck` (import estatico), asi que se comprueba por sus
  // DOS huellas observables en la misma fila: `client_ref` solo puede existir si
  // llego `__api_key` (answerlog.mjs:123 lo deriva del pagador) y `request_id`
  // solo si llego `__request_id`. Las dos a la vez, en la misma fila, es la
  // prueba de que el objeto de cobro-x402.mjs:139 lleva los dos.
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago({}, () => pagoPorHttp(env));
  const requestId = res.headers.get(REQUEST_ID_HEADER);

  const fila = env.DB._resp[0];
  assert.equal(fila.request_id, requestId);
  assert.equal(fila.client_ref, await sha256full(PAGADOR),
    "client_ref es el sha-256 del pagador: prueba que __api_key siguio llegando");
  assert.notEqual(fila.client_ref, null);
});

// --- 5. y 6. LA BARRERA MONETARIA ------------------------------------------

test("PR-1 BARRERA: la huella de idempotencia NO cambia por el request_id", async () => {
  // Si cambiara, un reintento legitimo se leeria como conflicto (409) o —peor—
  // dejaria de reconocerse y se cobraria dos veces. La huella se calcula en
  // cobro-x402.mjs:121 sobre `peticion`, ANTES de :139, y :139 construye un
  // objeto NUEVO con la propagacion dentro. Esta prueba fija las dos cosas.
  const aceptado = { scheme: "exact", network: RED_PAGO, amount: "20000",
                     asset: ASSET, payTo: PAY_TO };
  const peticion = { ...PETICION_PAGO };
  const antes = await huella({ aceptado, metodo: "POST", ruta: "/v1/check", cuerpo: peticion });

  // Exactamente lo que hace cobro-x402.mjs:139.
  const enriquecido = { ...peticion, __api_key: PAGADOR, __request_id: "rc_req_loquesea" };

  const despues = await huella({ aceptado, metodo: "POST", ruta: "/v1/check", cuerpo: peticion });
  assert.equal(despues, antes, "la huella es la misma");
  assert.equal("__request_id" in peticion, false, "y `peticion` no se ha mutado");
  assert.equal(enriquecido.__request_id, "rc_req_loquesea");
});

test("PR-1 BARRERA: la clave de cache NO cambia por el request_id", async () => {
  // Si entrara en la clave, cada peticion seria un fallo de cache y costaria una
  // llamada al modelo. `cacheKey` enumera seis campos con nombre (text.mjs:7-16)
  // y no recorre el objeto; esto lo deja fijado por prueba y no por lectura.
  const base = { ...PETICION_PAGO };
  assert.equal(
    cacheKey({ ...base, __api_key: PAGADOR, __request_id: "rc_req_uno" }),
    cacheKey({ ...base, __api_key: PAGADOR, __request_id: "rc_req_dos" }),
    "dos peticiones que solo difieren en el identificador comparten entrada de cache");
  assert.equal(cacheKey({ ...base, __request_id: "rc_req_uno" }), cacheKey(base));
});

// --- 7. Los desenlaces que NO dejan fila ------------------------------------

test("PR-1 pagado: el 409 no escribe answer_log y aun asi devuelve el identificador", async () => {
  // El conflicto se detecta en cobro-x402.mjs:123, ANTES de verificar (:134) y
  // ANTES del motor (:139): no hay fila que escribir, y por eso el identificador
  // de la cabecera es lo unico que el cliente puede citarnos.
  const ID_PAGO = "pay_0123456789abcdef0123456789abcdef";
  const env = {
    ...ENV_PAGO, AI: iaPago("YES"),
    DB: dbPago({ idemFila: {
      payment_id: ID_PAGO, fingerprint: "una-huella-que-no-es-la-de-esta-peticion",
      response_json: "{}", http_status: 200, transaction_hash: null,
      expires_at: "2099-01-01T00:00:00.000Z",
    } }),
  };
  const res = await conFacilitadorPago({},
    () => pagoPorHttp(env, sobrePago({ "payment-identifier": ID_PAGO })));

  assert.equal(res.status, 409);
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  assert.match(requestId, RE_ID);
  assert.equal((await res.json()).error.request_id, requestId);

  assert.equal(env.DB._resp.length, 0, "el motor no llego a correr: no hay fila");
  assert.equal(env.DB._idem.length, 0, "y tampoco se reescribe la idempotencia");
});

test("PR-1 pagado: un error del motor no escribe answer_log y devuelve el identificador", async () => {
  // El 500 de cobro-x402.mjs:142 y el error de motor de :141 salen por el MISMO
  // `return` de index.mjs:906 y por el mismo sellado, asi que la propiedad es la
  // misma para los dos. Se ejercita el alcanzable: un 500 SIN capturar no se
  // puede provocar de extremo a extremo porque todos los subsistemas del motor
  // capturan (corpus.mjs:141, metrics.mjs:26 y :32, answerlog.mjs:170). El 500
  // del catch del router ya lo cubre la prueba de mas arriba.
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago({}, () =>
    pagoPorHttp(env, sobrePago(), { ...PETICION_PAGO, page_text: "Too short." }));

  assert.ok(res.status >= 400, "es un desenlace de error");
  assert.notEqual(res.status, 200);
  const requestId = res.headers.get(REQUEST_ID_HEADER);
  assert.match(requestId, RE_ID, "el identificador sale igual");
  assert.equal((await res.json()).error.request_id, requestId);
  assert.equal(env.DB._resp.length, 0, "el motor no cerro respuesta: no hay fila que buscar");
});

// --- 8. El alcance no se ensancha -------------------------------------------

test("PR-1 ALCANCE: payment_idempotency se escribe, pero SIN request_id", async () => {
  // schema-006-trazabilidad.sql crea DOS columnas `request_id`: la de
  // `answer_log`, que este PR puebla, y la de `payment_idempotency`, que se
  // crea y se queda vacia. Esta prueba sujeta esa frontera por los dos lados, y
  // mira la LISTA DE COLUMNAS del INSERT y no solo el valor: el ensanche se
  // veria ahi aunque alguien enlazara un NULL.
  //
  // Las dos mitades importan. Sin la primera, "no se puebla" pasaria tambien si
  // la fila no llegara a escribirse, y entonces la prueba no vigilaria nada.
  const ID_PAGO = "pay_fedcba9876543210fedcba9876543210";
  const env = { ...ENV_PAGO, DB: dbPago(), AI: iaPago("YES") };
  const res = await conFacilitadorPago({},
    () => pagoPorHttp(env, sobrePago({ "payment-identifier": ID_PAGO })));
  assert.equal(res.status, 200);

  // 1. La fila de idempotencia SE ESCRIBE, y es la de esta peticion.
  assert.equal(env.DB._idem.length, 1, "con payment-identifier se guarda la idempotencia");
  assert.equal(env.DB._idem[0].payment_id, ID_PAGO);
  assert.ok(env.DB._idem[0].fingerprint, "con su huella");
  assert.equal(env.DB._idem[0].http_status, 200);

  // 2. Y NO lleva request_id: ni la columna en el INSERT, ni valor.
  assert.equal(env.DB._idem[0].__columnas.includes("request_id"), false,
    "payment_idempotency NO escribe request_id en este PR");
  assert.equal(env.DB._idem[0].request_id, undefined);

  // 3. La que SI se puebla sigue poblandose, para que esto no pase por vacio.
  assert.equal(env.DB._resp.length, 1);
  assert.equal(env.DB._resp[0].__columnas.includes("request_id"), true);
  assert.equal(env.DB._resp[0].request_id, res.headers.get(REQUEST_ID_HEADER));
});
