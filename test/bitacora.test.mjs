// PR-1g — LA BITACORA: QUE EL IDENTIFICADOR QUEDE ESCRITO EN ALGUN SITIO.
//
// EL AGUJERO QUE CIERRA. `request_id` sale en TODA respuesta desde PR-1b, pero
// solo quedaba GUARDADO cuando el motor cerraba una respuesta, porque la unica
// fila que lo lleva es la de `answer_log`. Justo los desenlaces en los que
// alguien reclama —402, 409, 422, 500, reintento— no pasan por ahi, y el codigo
// no emitia ni una sola linea de registro: le daban al cliente un identificador
// que despues no se podia buscar en ninguna parte.
//
// LO QUE VIGILAN ESTAS PRUEBAS, por orden de lo que costaria equivocarse:
//   1. que no se escriba NADA del cliente en el registro — es lo unico de aqui
//      que, mal hecho, seria una fuga y no una molestia;
//   2. que sea EXACTAMENTE UNA linea por intento, ni cero ni dos;
//   3. que los desenlaces sin fila —402, 409, 500, reintento— la tengan;
//   4. que las rutas que no son intentos NO ensucien el registro;
//   5. que un fallo del registro no pueda tocar la respuesta.
//
// LO QUE ESTAS PRUEBAS NO DEMUESTRAN, y no lo pueden demostrar: que Cloudflare
// conserve estas lineas, cuanto tiempo, ni que se puedan buscar por
// `request_id`. Eso es validacion posterior al despliegue. Aqui solo se
// demuestra que el codigo las EMITE.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { meterEnSobre } from "../src/x402.mjs";
import { huella } from "../src/idempotencia.mjs";
import { validateRequest } from "../src/contract.mjs";
import { REQUEST_ID_HEADER } from "../src/util.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RED    = "eip155:8453";
const TX     = "0xdeadbeefcafe0000000000000000000000000000000000000000000000000099";
const PAGADOR = "0x857bEEF0000000000000000000000000000000aa";
const NONCE  = "0x4748f83dd8b3f1ad933f056181b085e3d1b006556fc909feb23f9350f6f4d5c6";

// LOS CATORCE. Esta lista ES el contrato de la linea.
const CAMPOS = ["at", "error_code", "estado", "liquidacion", "metodo", "ms", "msg",
                "replay", "request_id", "rpc", "rpc_codigo", "rpc_n", "ruta", "v"];

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example",
  PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00",
  FREE_TRIAL_ENABLED: "false",
  X402_ENABLED: "true",
  X402_NETWORK: RED,
  X402_PAY_TO: PAY_TO,
  X402_ASSET: ASSET,
  X402_ASSET_NAME: "USD Coin",
  X402_ASSET_VERSION: "2",
  X402_FACILITATOR: "https://facilitador.example",
  ANSWER_LOG: "true",
};

// TESTIGOS. Cadenas que solo pueden venir del cliente. Si alguna aparece en una
// linea, el registro esta filtrando, y esta suite tiene que ponerse roja.
const TESTIGO_POLITICA = "ZZTESTIGOPOLITICAZZ";
const TESTIGO_CLAVE    = "rc_live_ZZTESTIGOCLAVEZZ";
const POLIZA = "Northstar Retail accepts returns of standard merchandise within 30 calendar days " +
               "after delivery. Items must be unopened. " + TESTIGO_POLITICA;

const PETICION = {
  product_url: "https://eval.example/p/RC25-01", buyer_country: "US",
  item_condition: "unopened", reason: "changed_mind",
  purchase_date: "2026-08-01", delivery_date: "2026-08-05", as_of: "2026-08-20",
  page_text: POLIZA,
};

function ia(verdict = "YES") {
  const det = verdict !== "UNKNOWN";
  return { run: async () => ({ response: JSON.stringify({
    verdict, confidence: 0.9,
    answer_human: det ? "Yes. Within the 30-day window." : "Unknown.",
    reason: det ? null : "The policy text does not resolve this case.",
    merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
    policy: det ? { return_category: "MerchantReturnFiniteReturnWindow", merchant_return_days: 30,
                    window_basis: "delivery_date", return_method: [], return_fees: null, refund_type: null } : null,
    evidence: det ? { source_url: PETICION.product_url, clause_id: null,
                      exact_clause: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery." } : null,
  }) }) };
}

function db({ idemFila = null, saldo = 5 } = {}) {
  const cliente = { api_key: "rc_live_test", email: null, balance_usd: saldo,
                    status: "active", calls_charged: 0, calls_free: 0 };
  const g = { run: async () => ({ meta: { changes: 1 } }), first: async () => null,
              all: async () => ({ results: [] }) };
  return {
    prepare: (sql) => ({
      bind: () => ({ ...g,
        first: async () => {
          if (/FROM clients/.test(sql)) return cliente;
          if (idemFila && /FROM payment_idempotency/.test(sql)) return idemFila;
          return null;
        },
      }),
      ...g,
    }),
  };
}

/** Una base que no conoce a nadie: cualquier clave sale como desconocida (401). */
function dbSinCliente() {
  const g = { run: async () => ({ meta: { changes: 0 } }), first: async () => null,
              all: async () => ({ results: [] }) };
  return { prepare: () => ({ bind: () => ({ ...g }), ...g }) };
}

const sobrePago = (extensions = undefined) => {
  const payload = { signature: "0x" + TESTIGO_CLAVE.slice(-12), authorization: {
    from: PAGADOR, to: PAY_TO, value: "20000",
    validAfter: "0", validBefore: "1893456000", nonce: NONCE } };
  if (extensions) payload.extensions = extensions;
  return {
    x402Version: 2,
    accepted: { scheme: "exact", network: RED, amount: "20000", asset: ASSET,
                payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
    payload,
  };
};

function conFacilitador(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/verify"))
      return { ok: true, status: 200, json: async () => ({ isValid: true, payer: PAGADOR }) };
    return { ok: true, status: 200,
             json: async () => ({ success: true, transaction: TX, network: RED, payer: PAGADOR }) };
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------
// EL ESPIA. Sustituye console.log, recoge lo emitido y SIEMPRE lo restituye.
// Devuelve { respuesta, lineas, crudas }: `crudas` son las cadenas tal cual, que
// es sobre lo que se buscan los testigos —si algo se filtrara dentro de un campo
// anidado, buscarlo sobre el objeto analizado podria no verlo.
// ---------------------------------------------------------------------------
async function espiando(fn, { revienta = false } = {}) {
  const original = console.log;
  const crudas = [];
  console.log = (...args) => {
    crudas.push(args.map(String).join(" "));
    if (revienta) throw new Error("el registro ha reventado a proposito");
  };
  let respuesta;
  try { respuesta = await fn(); }
  finally { console.log = original; }
  const lineas = crudas.map((c) => { try { return JSON.parse(c); } catch (_) { return null; } })
                       .filter((o) => o && o.msg === "rc.intento");
  return { respuesta, lineas, crudas };
}

const post = (ruta, cuerpo, env = ENV, headers = {}) =>
  worker.fetch(new Request("https://rc.example" + ruta, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  }), env);

const get = (ruta, env = ENV) => worker.fetch(new Request("https://rc.example" + ruta), env);

const pagoHttp = (env, sobre = sobrePago(), peticion = PETICION) =>
  worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": meterEnSobre(sobre) },
    body: JSON.stringify(peticion),
  }), env);

// ---------------------------------------------------------------------------
// 1. EXACTAMENTE UNA LINEA POR INTENTO
// ---------------------------------------------------------------------------

test("PR-1g: exactamente UNA linea por intento, en catorce desenlaces", async () => {
  // La propiedad no se prueba con un caso: se prueba recorriendo los desenlaces
  // que de verdad existen, incluidos los cuatro que NO dejan fila en answer_log,
  // que son la razon de ser de todo esto.
  const casos = [
    ["402 educado (x402 apagado)",   () => post("/v1/check", PETICION, { ...ENV, X402_ENABLED: "false", DB: db() })],
    ["402 reto de pago",             () => post("/v1/check", PETICION, { ...ENV, DB: db() })],
    ["400 cuerpo no JSON",           () => post("/v1/check", "{roto", { ...ENV, DB: db() }, { authorization: "Bearer rc_live_test" })],
    ["400 entrada invalida",         () => post("/v1/check", { buyer_country: "US" }, { ...ENV, DB: db() }, { authorization: "Bearer rc_live_test" })],
    ["401 clave desconocida",        () => post("/v1/check", PETICION, { ...ENV, DB: dbSinCliente() }, { authorization: "Bearer rc_live_desconocida" })],
    ["200 exito con clave",          () => post("/v1/check", PETICION, { ...ENV, DB: db(), AI: ia("YES") }, { authorization: "Bearer rc_live_test" })],
    ["200 exito pagado",             () => conFacilitador(() => pagoHttp({ ...ENV, DB: db(), AI: ia("YES") }))],
    ["alias /v1/check_return",       () => post("/v1/check_return", PETICION, { ...ENV, DB: db(), AI: ia("YES") }, { authorization: "Bearer rc_live_test" })],
    ["mcp 400 parse error",          () => post("/mcp", "{roto", ENV)],
    ["mcp 200 method not found",     () => post("/mcp", { jsonrpc: "2.0", id: 1, method: "no/existe" }, ENV)],
    ["mcp 200 ping",                 () => post("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, ENV)],
    ["mcp 200 tools/list",           () => post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, ENV)],
    ["mcp lote de tres",             () => post("/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" },
                                                         { jsonrpc: "2.0", id: 2, method: "tools/list" },
                                                         { jsonrpc: "2.0", id: 3, method: "no/existe" }], ENV)],
    ["mcp OPTIONS (preflight)",      () => worker.fetch(new Request("https://rc.example/mcp", { method: "OPTIONS" }), ENV)],
  ];

  let vistos = 0;
  for (const [nombre, correr] of casos) {
    const { respuesta, lineas } = await espiando(correr);
    assert.equal(lineas.length, 1, nombre + ": tiene que emitir UNA linea, no " + lineas.length);
    assert.equal(lineas[0].request_id, respuesta.headers.get(REQUEST_ID_HEADER),
      nombre + ": la linea y la cabecera servida tienen que llevar el MISMO identificador");
    vistos++;
  }
  assert.equal(vistos, casos.length, "los catorce desenlaces se han ejercitado");
});

test("PR-1g: DOS lineas para el mismo intento harian fallar la prueba", async () => {
  // El control de la prueba de arriba. Si `assert.equal(lineas.length, 1)` fuera
  // un `assert.ok(lineas.length >= 1)`, un emisor llamado dos veces pasaria
  // desapercibido. Aqui se emite una linea de mas a proposito y se comprueba que
  // el conteo la ve.
  const { lineas } = await espiando(async () => {
    const r = await post("/v1/check", PETICION, { ...ENV, DB: db() });
    console.log(JSON.stringify({ msg: "rc.intento", v: 1, request_id: "rc_req_duplicada" }));
    return r;
  });
  assert.equal(lineas.length, 2, "el espia cuenta las dos, luego el conteo discrimina");
  assert.notEqual(lineas.length, 1, "y por tanto la asercion de la prueba anterior se pondria roja");
});

test("PR-1g: los desenlaces SIN fila en answer_log si dejan linea", async () => {
  // 409, 402 y 500: los tres devuelven identificador y ninguno escribe fila. Son
  // exactamente los que hasta hoy no se podian buscar en ningun sitio.
  const ID_PAGO = "pay_0123456789abcdef0123456789abcdef";

  // 409: mismo identificador de pago con otra huella.
  const envConflicto = { ...ENV, AI: ia("YES"), DB: db({ idemFila: {
    payment_id: ID_PAGO, fingerprint: "una-huella-que-no-es-la-de-esta-peticion",
    response_json: "{}", http_status: 200, transaction_hash: null,
    expires_at: "2099-01-01T00:00:00.000Z" } }) };
  const c409 = await espiando(() => conFacilitador(() =>
    pagoHttp(envConflicto, sobrePago({ "payment-identifier": ID_PAGO }))));
  assert.equal(c409.respuesta.status, 409);
  assert.equal(c409.lineas.length, 1);
  assert.equal(c409.lineas[0].estado, 409);
  assert.equal(c409.lineas[0].error_code, "CONFLICT", "y se sabe POR QUE, sin leer el cuerpo");

  // 402: reto de pago.
  const c402 = await espiando(() => post("/v1/check", PETICION, { ...ENV, DB: db() }));
  assert.equal(c402.respuesta.status, 402);
  assert.equal(c402.lineas.length, 1);
  assert.equal(c402.lineas[0].estado, 402);

  // 500: el catch del router. Se provoca de verdad, con un env que revienta.
  const envQueRevienta = new Proxy({ ...ENV }, {
    get(obj, prop) { if (prop === "DB") throw new Error("boom"); return obj[prop]; },
  });
  const c500 = await espiando(() => post("/v1/check", PETICION, envQueRevienta,
                                         { authorization: "Bearer rc_live_test" }));
  assert.equal(c500.respuesta.status, 500);
  assert.equal(c500.lineas.length, 1, "el 500 es el que mas falta hacia");
  assert.equal(c500.lineas[0].estado, 500);
  assert.equal(c500.lineas[0].error_code, "INTERNAL");
  assert.equal(c500.lineas[0].request_id, c500.respuesta.headers.get(REQUEST_ID_HEADER));
});

// ---------------------------------------------------------------------------
// 2. EL REINTENTO — LA CORRELACION QUE SUSTITUYE A payment_idempotency.request_id
// ---------------------------------------------------------------------------

test("PR-1g: el replay deja linea NUEVA, con identificador nuevo y replay:true", async () => {
  // Un reintento servido de la idempotencia no escribe NADA: ni fila de
  // respuesta ni fila de idempotencia. La linea de bitacora es toda la
  // correlacion que tiene, y por eso se decidio no crear una columna
  // `payment_idempotency.request_id`: una sola columna no podria representar los
  // identificadores de varios reintentos del mismo pago, y esta linea si.
  const ID_PAGO = "pay_fedcba9876543210fedcba9876543210";
  const h = await huella({ aceptado: sobrePago().accepted, metodo: "POST", ruta: "/v1/check",
                           cuerpo: validateRequest(PETICION).value });
  const guardada = JSON.stringify({ verdict: "YES", meta: { check_id: "CHECK-DEL-PRIMER-INTENTO" } });
  const env = { ...ENV, AI: ia("YES"), DB: db({ idemFila: {
    payment_id: ID_PAGO, fingerprint: h, response_json: guardada,
    http_status: 200, transaction_hash: TX, expires_at: "2099-01-01T00:00:00.000Z" } }) };

  const uno = await espiando(() => conFacilitador(() =>
    pagoHttp(env, sobrePago({ "payment-identifier": ID_PAGO }))));
  const dos = await espiando(() => conFacilitador(() =>
    pagoHttp(env, sobrePago({ "payment-identifier": ID_PAGO }))));

  for (const [nombre, c] of [["primer reintento", uno], ["segundo reintento", dos]]) {
    assert.equal(c.respuesta.status, 200, nombre);
    assert.equal(c.respuesta.headers.get("X-ReturnCheck-Replay"), "true", nombre);
    assert.equal(c.lineas.length, 1, nombre + ": una linea");
    assert.equal(c.lineas[0].replay, true, nombre + ": marcado como reintento");
  }
  assert.notEqual(uno.lineas[0].request_id, dos.lineas[0].request_id,
    "dos reintentos del MISMO pago dejan DOS lineas con identificadores distintos");
  assert.equal(uno.lineas[0].request_id, uno.respuesta.headers.get(REQUEST_ID_HEADER));
  assert.equal(dos.lineas[0].request_id, dos.respuesta.headers.get(REQUEST_ID_HEADER));
});

// ---------------------------------------------------------------------------
// 3. LA FORMA DE LA LINEA
// ---------------------------------------------------------------------------

test("PR-1g: la linea tiene EXACTAMENTE los catorce campos", async () => {
  // Es lo que impide que mañana entre un campo libre sin que nadie lo mire.
  const { lineas } = await espiando(() => conFacilitador(() =>
    pagoHttp({ ...ENV, DB: db(), AI: ia("YES") })));
  assert.equal(lineas.length, 1);
  assert.deepEqual(Object.keys(lineas[0]).sort(), CAMPOS);
  assert.equal(lineas[0].msg, "rc.intento");
  assert.equal(lineas[0].v, 1);
  assert.equal(lineas[0].ruta, "/v1/check");
  assert.equal(lineas[0].metodo, "POST");
  assert.match(lineas[0].at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.ok(Number.isInteger(lineas[0].ms) && lineas[0].ms >= 0, "duracion entera no negativa");
  assert.equal(lineas[0].liquidacion, "confirmed");
  assert.equal(lineas[0].replay, false);
  assert.equal(lineas[0].error_code, null, "un exito no tiene codigo de error");
});

test("PR-1g: por MCP se apuntan metodo, tamaño de lote y codigo, sin nombre de herramienta", async () => {
  const uno = await espiando(() => post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, ENV));
  assert.equal(uno.lineas[0].rpc, "tools/list");
  assert.equal(uno.lineas[0].rpc_n, 1);
  assert.equal(uno.lineas[0].rpc_codigo, null);

  const err = await espiando(() => post("/mcp", { jsonrpc: "2.0", id: 1, method: "no/existe" }, ENV));
  assert.equal(err.lineas[0].rpc, "otro", "un metodo que no servimos no se copia: se clasifica");
  assert.equal(err.lineas[0].rpc_codigo, -32601);

  const parse = await espiando(() => post("/mcp", "{roto", ENV));
  assert.equal(parse.lineas[0].rpc, null, "sin mensaje que clasificar, null es la verdad");
  assert.equal(parse.lineas[0].rpc_codigo, -32700);

  const lote = await espiando(() => post("/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" },
                                                  { jsonrpc: "2.0", id: 2, method: "no/existe" }], ENV));
  assert.equal(lote.lineas[0].rpc, "lote");
  assert.equal(lote.lineas[0].rpc_n, 2);
  assert.equal(lote.lineas[0].rpc_codigo, -32601, "el codigo del primer error del lote");

  // Una herramienta desconocida se ve por el codigo, NO por su nombre: ese nombre
  // lo elige quien llama y no entra en el registro.
  const herramienta = await espiando(() => post("/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ZZHERRAMIENTAZZ", arguments: {} } }, ENV));
  assert.equal(herramienta.lineas[0].rpc, "tools/call");
  assert.equal(herramienta.lineas[0].rpc_codigo, -32602);
  assert.equal(herramienta.crudas.join("").includes("ZZHERRAMIENTAZZ"), false,
    "el nombre de la herramienta NO puede aparecer en el registro");
});

test("PR-1g: los valores fuera de las listas cerradas salen como null, no como el valor", async () => {
  const { registrarIntento } = await import("../src/bitacora.mjs");
  const respuesta = new Response("{}", { status: 200, headers: {
    "X-ReturnCheck-Settlement": "un-estado-inventado",
    "X-ReturnCheck-Replay": "quizas",
  } });
  const { crudas } = await espiando(async () => {
    registrarIntento({
      metodo: "TELEPORT", pathname: "/v1/check", respuesta, requestId: "rc_req_x",
      ms: -5,
      apunte: { error_code: "no son mayusculas", rpc: "metodo/inventado", rpc_n: "tres", rpc_codigo: "cero" },
    });
    return respuesta;
  });
  const l = JSON.parse(crudas[0]);
  assert.equal(l.liquidacion, null, "un estado de liquidacion inventado no se copia");
  assert.equal(l.replay, false, "`quizas` no es `true`");
  assert.equal(l.metodo, "otro", "un metodo raro se clasifica, no se copia");
  assert.equal(l.error_code, null, "un codigo que no tiene la forma de los nuestros no se copia");
  assert.equal(l.rpc, null);
  assert.equal(l.rpc_n, null);
  assert.equal(l.rpc_codigo, null);
  assert.equal(l.ms, 0, "una duracion negativa no existe");
  assert.deepEqual(Object.keys(l).sort(), CAMPOS, "y siguen siendo los catorce");
});

// ---------------------------------------------------------------------------
// 4. LO QUE NO PUEDE SALIR — es lo unico de aqui que seria una fuga
// ---------------------------------------------------------------------------

test("PR-1g SECRETOS: ningun testigo del cliente aparece en el registro", async () => {
  const ID_PAGO = "pay_ZZTESTIGOIDEMPOTENCIAZZ000000";
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const { crudas, respuesta } = await espiando(() => conFacilitador(() =>
    worker.fetch(new Request("https://rc.example/v1/check?k=ZZTESTIGOQUERYZZ", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": meterEnSobre(sobrePago({ "payment-identifier": ID_PAGO })),
        authorization: "Bearer " + TESTIGO_CLAVE,
      },
      body: JSON.stringify(PETICION),
    }), env)));

  assert.equal(respuesta.status, 200, "la llamada ha ocurrido de verdad, no se prueba sobre vacio");
  const todo = crudas.join("\n");
  assert.ok(todo.length > 0, "y ha emitido algo, para que lo de abajo no pase por vacio");

  const prohibidos = {
    "el texto de la politica que mando el cliente": TESTIGO_POLITICA,
    "la clave de API":                              TESTIGO_CLAVE,
    "el identificador de pago":                     "ZZTESTIGOIDEMPOTENCIAZZ",
    "la cadena de consulta":                        "ZZTESTIGOQUERYZZ",
    "la cabecera de autorizacion":                  "Bearer",
    "el sobre de pago":                             "PAYMENT-SIGNATURE",
    "la firma":                                     NONCE,
    "la direccion del pagador":                     PAGADOR,
    "la url del producto":                          PETICION.product_url,
  };
  for (const [que, testigo] of Object.entries(prohibidos))
    assert.equal(todo.includes(testigo), false, "el registro NO puede llevar " + que);

  // Y el control: la linea si lleva lo que tiene que llevar.
  const l = JSON.parse(crudas[0]);
  assert.equal(l.request_id, respuesta.headers.get(REQUEST_ID_HEADER));
  assert.equal(l.ruta, "/v1/check", "la ruta es la de la lista blanca, no la URL pedida");
});

test("PR-1g: un mensaje de error del motor no se copia al registro", async () => {
  // `error_code` es un codigo de lista cerrada. El MENSAJE nunca entra: puede
  // llevar un trozo de lo que mando el cliente.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const { crudas, respuesta } = await espiando(() =>
    post("/v1/check", { ...PETICION, page_text: "ZZDEMASIADOCORTOZZ" }, env,
         { authorization: "Bearer rc_live_test" }));
  assert.ok(respuesta.status >= 400);
  const todo = crudas.join("\n");
  assert.equal(todo.includes("ZZDEMASIADOCORTOZZ"), false);
  assert.equal(todo.includes("Could not read"), false, "ni el mensaje del motor");
  const l = JSON.parse(crudas[0]);
  assert.match(l.error_code, /^[A-Z][A-Z_]*$/, "solo el codigo, y con forma de codigo");
});

// ---------------------------------------------------------------------------
// 5. LA PUERTA Y LA REGLA 1
// ---------------------------------------------------------------------------

test("PR-1g PUERTA: las rutas que no son intentos NO emiten", async () => {
  const fuera = [
    ["portada",          () => get("/")],
    ["discovery",        () => get("/discovery.json")],
    ["openapi",          () => get("/openapi.json")],
    ["llms.txt",         () => get("/llms.txt")],
    ["fichas",           () => get("/cards")],
    ["sitemap",          () => get("/sitemap.xml")],
    ["robots",           () => get("/robots.txt")],
    ["404 general",      () => get("/no-existe-esta-ruta")],
    ["404 de admin",     () => get("/admin/corpus")],
  ];
  for (const [nombre, correr] of fuera) {
    const { lineas } = await espiando(correr);
    assert.equal(lineas.length, 0, nombre + ": no es un intento contra el servicio");
  }

  // El control, para que lo de arriba no pase por vacio: la misma mecanica SI
  // emite en una ruta de la lista.
  const dentro = await espiando(() => post("/v1/check", PETICION, { ...ENV, DB: db() }));
  assert.equal(dentro.lineas.length, 1);
});

test("PR-1g REGLA 1: si el registro revienta, la respuesta se sirve intacta", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };

  // Dos llamadas identicas: una con el registro sano y otra con un `console.log`
  // que lanza. Se comparan las dos respuestas quitando los DOS identificadores
  // que son nuevos en cada invocacion por diseño —`check_id` y `corpus_id`—; todo
  // lo demas tiene que salir igual.
  const sano = await espiando(() => conFacilitador(() => pagoHttp(env)));
  const roto = await espiando(() => conFacilitador(() => pagoHttp(env)), { revienta: true });

  assert.equal(roto.respuesta.status, sano.respuesta.status, "mismo estado");
  assert.equal(roto.respuesta.status, 200);
  assert.match(roto.respuesta.headers.get(REQUEST_ID_HEADER), /^rc_req_/, "con su cabecera");
  assert.equal(roto.respuesta.headers.get("X-ReturnCheck-Settlement"), "confirmed",
    "y con las cabeceras de la liquidacion intactas");
  assert.equal(roto.respuesta.headers.get("X-ReturnCheck-Cost"),
               sano.respuesta.headers.get("X-ReturnCheck-Cost"));

  // `meta` se compara aparte y solo por sus CLAVES: dentro van identificadores
  // nuevos en cada invocacion (check_id, corpus_id) y tres medidas de tiempo
  // (response_ms, ai_ms, fetch_ms) que dependen de la carga de la maquina. Exigir
  // que coincidan seria una prueba fragil, y una prueba fragil se acaba
  // desactivando. Lo que aqui importa —el veredicto, la politica, la evidencia y
  // el comercio— si se compara entero.
  const cRoto = await roto.respuesta.json();
  const cSano = await sano.respuesta.json();
  const metaRoto = cRoto.meta, metaSano = cSano.meta;
  delete cRoto.meta; delete cSano.meta;

  assert.deepEqual(cRoto, cSano,
    "el mismo cuerpo: el registro no ha tocado nada de lo que se sirve");
  assert.deepEqual(Object.keys(metaRoto).sort(), Object.keys(metaSano).sort(),
    "y `meta` conserva su forma, aunque sus valores sean de cada llamada");
  assert.ok(metaRoto.check_id, "con su check_id, que es lo que el cliente cita");

  assert.equal(roto.crudas.length, 1, "se intento escribir, y el fallo se trago aqui dentro");
  assert.equal(sano.lineas.length, 1, "el control: con el registro sano si sale la linea");
});
