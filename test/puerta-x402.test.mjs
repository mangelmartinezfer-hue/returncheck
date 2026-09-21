// PR-2 — LA PUERTA ATÓMICA ANTES DE /settle. BLQ-X402-GATE-01.
//
// QUÉ SE ROMPÍA. En `src/cobro-x402.mjs` el orden era: leer idempotencia,
// verificar, gastar el motor, llamar a /settle, y ESCRIBIR la idempotencia
// después, con un `INSERT OR REPLACE`. Entre la lectura y la escritura no había
// nada atómico. Dos peticiones con el mismo identificador de pago pasaban las
// dos la lectura —porque ninguna había escrito todavía—, gastaban el motor las
// dos y llamaban al facilitador LAS DOS. Un cobro doble por una sola pregunta.
//
// Y el `INSERT OR REPLACE` no podía arreglarlo ni queriendo: siempre tiene
// éxito, así que nunca devuelve el cero que distingue al perdedor.
//
// CÓMO SE MIDE AQUÍ. Con SQLite de verdad debajo (`test/dobles/d1-sqlite.mjs`)
// y el esquema real leído de los .sql, no con un `Map` que devuelva los números
// que a uno le convengan. Y el facilitador de mentira TARDA en /verify: así la
// segunda petición entra mientras la primera está dentro, que es exactamente el
// hueco por el que se colaba el cobro doble. Con el código anterior estas
// pruebas verían dos llamadas a /settle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cobrarConX402 } from "../src/cobro-x402.mjs";
import { reclamar, liberar, finalizar, huella } from "../src/idempotencia.mjs";
import { baseReal, filaIdem, cuantasIdem } from "./dobles/d1-sqlite.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RED    = "eip155:8453";
const TX     = "0xdeadbeefcafe0000000000000000000000000000000000000000000000000002";
const PAYER  = "0x857bEEF0000000000000000000000000000000aa";
const ID     = "pay_0123456789abcdef0123456789abcdef";

const POLIZA = "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories.";

const PETICION = {
  product_url: "https://eval.example/p/RC25-01",
  buyer_country: "US", item_condition: "unopened", reason: "changed_mind",
  purchase_date: "2026-08-01", delivery_date: "2026-08-05", as_of: "2026-08-20",
  page_text: POLIZA,
};

const ACEPTADO = { scheme: "exact", network: RED, amount: "20000", asset: ASSET, payTo: PAY_TO };
const RUTA = "/v1/check_return";

function pago(id = ID) {
  const payload = { signature: "0xsig", authorization: { from: PAYER, to: PAY_TO, value: "20000" } };
  if (id) payload.extensions = { "payment-identifier": id };
  return { x402Version: 2, accepted: { ...ACEPTADO }, payload };
}

// El motor, con contador: gastar el modelo dos veces por una pregunta pagada una
// vez tambien es un fallo, aunque no cueste USDC.
function motor() {
  const c = { veces: 0 };
  c.AI = { run: async () => {
    c.veces++;
    return { response: JSON.stringify({
      verdict: "YES", confidence: 0.9,
      answer_human: "Yes. Within the 30-day window.", reason: null,
      merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
      policy: { return_category: "MerchantReturnFiniteReturnWindow", merchant_return_days: 30,
                window_basis: "delivery_date", return_method: [], return_fees: null, refund_type: null },
      evidence: { source_url: PETICION.product_url, clause_id: null,
                  exact_clause: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery." },
    }) };
  } };
  return c;
}

// El facilitador de mentira. `tardaVerify` es lo que abre el hueco de la carrera.
//
// `settle` admite tres desenlaces, y la diferencia entre ellos decide si la
// reclamacion se suelta o se queda: "ok" (cobrado), "no_salio" (la peticion no
// llego a irse: el dinero NO se movio) y "no_se" (un 504: la peticion salio y
// puede haberse ejecutado). Es la distincion de W41, y aqui vale dinero.
function facilitador({ tardaVerify = 0, verificaOk = true, settle = "ok" } = {}) {
  const c = { verify: 0, settle: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/verify")) {
      c.verify++;
      if (tardaVerify) await new Promise((r) => setTimeout(r, tardaVerify));
      return { ok: true, status: 200,
               json: async () => ({ isValid: verificaOk, payer: PAYER,
                                    invalidReason: verificaOk ? null : "bad_signature" }) };
    }
    if (u.endsWith("/settle")) {
      c.settle++;
      if (settle === "no_salio") throw new TypeError("fetch failed");
      if (settle === "no_se") return { ok: false, status: 504, json: async () => ({}) };
      return { ok: true, status: 200,
               json: async () => ({ success: true, transaction: TX, network: RED, payer: PAYER }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  c.restaurar = () => { globalThis.fetch = original; };
  return c;
}

function entorno(extra = {}) {
  const m = motor();
  return { m, env: {
    PUBLIC_BASE_URL: "https://rc.example", PRICE_USD: "0.02", ANSWER_LOG: "false",
    X402_ENABLED: "true", X402_NETWORK: RED, X402_PAY_TO: PAY_TO, X402_ASSET: ASSET,
    X402_FACILITATOR: "https://facilitador.example", FREE_TRIAL_ENABLED: "false",
    IDEMPOTENCY_HOURS: 24,
    DB: baseReal(), AI: m.AI, ...extra,
  } };
}

const cobrar = (env, peticion = PETICION, id = ID) =>
  cobrarConX402(env, { pago: pago(id), aceptado: ACEPTADO, peticion, ruta: RUTA, precio: "0.02" });

// ---------------------------------------------------------------------------
// 1. EL FALLO. Dos peticiones a la vez, mismo identificador, misma pregunta:
//    UNA sola llamada a /settle.
// ---------------------------------------------------------------------------

test("dos peticiones simultaneas con el mismo identificador liquidan UNA sola vez", async () => {
  const { m, env } = entorno();
  const f = facilitador({ tardaVerify: 25 });
  try {
    const [a, b] = await Promise.all([cobrar(env), cobrar(env)]);

    // Lo que cuesta dinero, primero.
    assert.equal(f.settle, 1, "se llamo al facilitador " + f.settle + " veces, y solo se pago una pregunta");

    // Exactamente una sirvio respuesta pagada; la otra no.
    const tipos = [a.tipo, b.tipo].sort();
    assert.deepEqual(tipos, ["en_curso", "ok"]);

    // Y una sola fila, la del ganador, cerrada.
    assert.equal(cuantasIdem(env.DB), 1);
    assert.equal(filaIdem(env.DB, ID).status, "done");
    assert.equal(filaIdem(env.DB, ID).transaction_hash, TX);
  } finally { f.restaurar(); }
});

// ---------------------------------------------------------------------------
// 2. El perdedor NO gasta el motor, NO verifica y NO liquida. Y cuando
//    reintenta, recibe la respuesta del ganador sin volver a pagar.
// ---------------------------------------------------------------------------

test("el perdedor no toca el motor ni el facilitador, y al reintentar recibe lo servido", async () => {
  const { m, env } = entorno();
  const f = facilitador({ tardaVerify: 25 });
  try {
    const [a, b] = await Promise.all([cobrar(env), cobrar(env)]);
    const ganador = a.tipo === "ok" ? a : b;

    assert.equal(m.veces, 1, "el modelo se gasto " + m.veces + " veces");
    assert.equal(f.verify, 1, "se verifico " + f.verify + " veces");
    assert.equal(f.settle, 1);

    // El reintento del perdedor, ya cerrada la fila del ganador.
    const tercera = await cobrar(env);
    assert.equal(tercera.tipo, "repetido");
    assert.equal(tercera.cuerpo, ganador.cuerpo);
    assert.equal(tercera.transaccion, TX);

    // Y el reintento no ha vuelto a costar nada.
    assert.equal(f.settle, 1);
    assert.equal(m.veces, 1);
  } finally { f.restaurar(); }
});

// ---------------------------------------------------------------------------
// 3. El permiso lo da el motor. Una excepcion NO es un cero.
// ---------------------------------------------------------------------------

test("la puerta da 1 al ganador y 0 al perdedor, y el 0 lo dice el motor", async () => {
  const env = { DB: baseReal(), IDEMPOTENCY_HOURS: 24 };
  const h = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: RUTA, cuerpo: PETICION });

  assert.deepEqual(await reclamar(env, { id: ID, huella: h }), { dueno: true });
  assert.deepEqual(await reclamar(env, { id: ID, huella: h }), { enCurso: true });
  assert.equal(filaIdem(env.DB, ID).status, "in_flight");
  assert.equal(filaIdem(env.DB, ID).response_json, "");
});

test("si la base revienta la puerta dice INDETERMINADO, no cero, y NO se liquida", async () => {
  const { env } = entorno({ DB: { prepare: () => ({ bind: () => ({
    run: async () => { throw new Error("D1_ERROR: connection lost"); },
    first: async () => { throw new Error("D1_ERROR: connection lost"); },
  }) }) } });
  const f = facilitador();
  try {
    const r = await cobrar(env);
    assert.equal(r.tipo, "reto");
    assert.match(r.motivo, /Idempotency gate unavailable/);
    // Lo importante no es el texto: es que no se llamo al facilitador.
    assert.equal(f.settle, 0, "se liquido sin puerta");
    assert.equal(f.verify, 0);
  } finally { f.restaurar(); }
});

test("una verificacion fallida suelta la reclamacion: el identificador no queda quemado", async () => {
  const { env } = entorno();
  const f = facilitador({ verificaOk: false });
  try {
    const r = await cobrar(env);
    assert.equal(r.tipo, "reto");
    assert.equal(f.settle, 0, "no se liquida lo que no se ha verificado");
    assert.equal(cuantasIdem(env.DB), 0, "la reclamacion se quedo puesta sin que se moviera dinero");

    // Y el cliente puede volver a intentarlo con el mismo identificador.
    f.restaurar();
    const g = facilitador();
    try {
      const segunda = await cobrar(env);
      assert.equal(segunda.tipo, "ok");
      assert.equal(g.settle, 1);
    } finally { g.restaurar(); }
  } finally { globalThis.fetch && f.restaurar(); }
});

test("si la liquidacion NO llego a salir, se suelta: el dinero no se movio", async () => {
  const { env } = entorno();
  const f = facilitador({ settle: "no_salio" });
  try {
    const r = await cobrar(env);
    assert.equal(r.tipo, "reto");
    assert.match(r.motivo, /settlement failed/);
    assert.equal(cuantasIdem(env.DB), 0);
  } finally { f.restaurar(); }
});

// LA IMPORTANTE DE LAS TRES. Un 504 del facilitador significa que la peticion SI
// salio y puede haberse ejecutado. "No se" no es "no". La reclamacion se queda
// puesta aunque eso deje el identificador ocupado: reintentar y liquidar dos
// veces es mucho peor que hacer esperar al cliente hasta que caduque la ventana.
test("si la liquidacion es INCIERTA, la reclamacion NO se suelta", async () => {
  const { env } = entorno();
  const f = facilitador({ settle: "no_se" });
  try {
    const r = await cobrar(env);
    assert.equal(r.tipo, "ok");
    assert.equal(r.estadoLiquidacion, "unconfirmed");
    assert.equal(cuantasIdem(env.DB), 1);
    assert.equal(filaIdem(env.DB, ID).status, "done", "una liquidacion incierta no puede dejar la fila en vuelo");
  } finally { f.restaurar(); }
});

// Un modelo caido NO llega a ser un error del motor: con una peticion completa
// el motor devuelve UNKNOWN, que no se liquida y por tanto no cuesta nada. Se
// deja escrito porque es facil suponer lo contrario.
test("un modelo caido acaba en UNKNOWN, no se liquida, y la fila queda cerrada", async () => {
  const { env } = entorno({ AI: { run: async () => { throw new Error("modelo caido"); } } });
  const f = facilitador();
  try {
    const r = await cobrar(env);
    assert.equal(r.tipo, "ok");
    assert.equal(JSON.parse(r.cuerpo).verdict, "UNKNOWN");
    assert.equal(r.coste, 0);
    assert.equal(f.settle, 0, "un UNKNOWN no se liquida");
    assert.equal(filaIdem(env.DB, ID).status, "done");
  } finally { f.restaurar(); }
});

// ---------------------------------------------------------------------------
// 4. Mismo identificador, OTRA pregunta: 409, y sin liquidar. (W31 intacto.)
// ---------------------------------------------------------------------------

test("mismo identificador con otra pregunta sigue siendo conflicto, y no liquida", async () => {
  const { env } = entorno();
  const f = facilitador();
  try {
    const primera = await cobrar(env);
    assert.equal(primera.tipo, "ok");
    assert.equal(f.settle, 1);

    const otra = { ...PETICION, product_url: "https://eval.example/p/OTRO-PRODUCTO" };
    const segunda = await cobrar(env, otra);
    assert.equal(segunda.tipo, "conflicto");
    assert.equal(f.settle, 1, "un conflicto no puede liquidar");
    assert.equal(cuantasIdem(env.DB), 1);
  } finally { f.restaurar(); }
});

// ---------------------------------------------------------------------------
// 5. Una reclamacion colgada no bloquea el identificador para siempre — pero
//    tampoco se le quita a una peticion que sigue viva.
// ---------------------------------------------------------------------------

test("una reclamacion viva NO se le quita a nadie", async () => {
  const env = { DB: baseReal(), IDEMPOTENCY_HOURS: 24 };
  const h = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: RUTA, cuerpo: PETICION });
  await reclamar(env, { id: ID, huella: h });
  // Ventana de dos minutos, reclamacion de hace un instante.
  assert.deepEqual(await reclamar(env, { id: ID, huella: h }), { enCurso: true });
});

test("una reclamacion colgada se puede retomar pasada la ventana", async () => {
  const env = { DB: baseReal(), IDEMPOTENCY_HOURS: 24 };
  const h = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: RUTA, cuerpo: PETICION });
  const hace5min = new Date(Date.now() - 5 * 60000).toISOString();
  await reclamar(env, { id: ID, huella: h }, hace5min);
  assert.equal(filaIdem(env.DB, ID).claimed_at, hace5min);

  // Ahora, con la ventana por defecto de dos minutos, ya se puede retomar.
  assert.deepEqual(await reclamar(env, { id: ID, huella: h }), { dueno: true });
  assert.equal(cuantasIdem(env.DB), 1, "retomar no puede crear una segunda fila");
});

test("una reclamacion colgada NO se retoma si la pregunta es otra: sigue siendo conflicto", async () => {
  const env = { DB: baseReal(), IDEMPOTENCY_HOURS: 24 };
  const h = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: RUTA, cuerpo: PETICION });
  const otraH = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: RUTA, cuerpo: { ...PETICION, product_url: "https://x.example/otro" } });
  await reclamar(env, { id: ID, huella: h }, new Date(Date.now() - 5 * 60000).toISOString());
  assert.deepEqual(await reclamar(env, { id: ID, huella: otraH }), { conflicto: true });
});

// ---------------------------------------------------------------------------
// Cierre y liberacion: que hagan exactamente lo que dicen.
// ---------------------------------------------------------------------------

test("finalizar solo cierra NUESTRA fila, y liberar solo suelta una en vuelo", async () => {
  const env = { DB: baseReal(), IDEMPOTENCY_HOURS: 24 };
  const h = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: RUTA, cuerpo: PETICION });

  await reclamar(env, { id: ID, huella: h });
  assert.equal(await finalizar(env, { id: ID, cuerpo: '{"ok":true}', transaccion: TX }), true);
  assert.equal(filaIdem(env.DB, ID).status, "done");

  // Ya cerrada: ni se vuelve a cerrar ni se puede soltar. Una respuesta servida
  // no se borra por un `liberar` despistado.
  assert.equal(await finalizar(env, { id: ID, cuerpo: '{"ok":false}' }), false);
  assert.equal(await liberar(env, ID), false);
  assert.equal(filaIdem(env.DB, ID).response_json, '{"ok":true}');
});
