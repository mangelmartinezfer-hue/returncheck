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
