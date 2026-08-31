// W49 — LA PRUEBA DE QUE SE PAGO, VISIBLE POR MCP.
//
// LO QUE VIGILAN ESTAS PRUEBAS. El bloque `x402` que se añade a
// structuredContent existe para eliminar una ambiguedad: por MCP no habia forma
// de distinguir una respuesta PAGADA de una del TRAMO GRATIS, ni de llegar al
// hash de la transaccion.
//
// Y la mitad mas importante de estas pruebas no es que el bloque aparezca: es
// que NO aparezca cuando no toca. Introducir la ambiguedad al reves —que algo
// gratuito parezca pagado— seria peor que el hueco que estamos cerrando, porque
// convertiria la evidencia en una mentira en vez de en una ausencia.
//
// Los cuatro escenarios del encargo: gratis, reto, pago valido, reintento.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { meterEnSobre, sacarDelSobre } from "../src/x402.mjs";
import { validateRequest } from "../src/contract.mjs";
import { huella } from "../src/idempotencia.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RED    = "eip155:8453";
const TX     = "0xdeadbeefcafe0000000000000000000000000000000000000000000000000001";

const POLIZA = "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories.";

const PETICION = {
  product_url: "https://eval.example/p/RC25-01",
  buyer_country: "US",
  item_condition: "unopened",
  reason: "changed_mind",
  purchase_date: "2026-08-01",
  delivery_date: "2026-08-05",
  as_of: "2026-08-20",
  page_text: POLIZA,
};

// Modelo de mentira: contesta lo que le digamos, sin red.
function ia(verdict) {
  const determinado = verdict !== "UNKNOWN";
  return { run: async () => ({ response: JSON.stringify({
    verdict, confidence: 0.9,
    answer_human: determinado ? "Yes. Within the 30-day window." : "Unknown.",
    reason: determinado ? null : "The policy text does not resolve this case.",
    merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
    policy: determinado
      ? { return_category: "MerchantReturnFiniteReturnWindow", merchant_return_days: 30,
          window_basis: "delivery_date", return_method: [], return_fees: null, refund_type: null }
      : null,
    evidence: determinado
      ? { source_url: PETICION.product_url, clause_id: null,
          exact_clause: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery." }
      : null,
  }) }) };
}

// Base de mentira. Sabe contestar lo justo: los contadores del tramo gratis y,
// si se le pide, una fila de idempotencia ya guardada.
function db({ idemFila = null } = {}) {
  const generico = {
    run: async () => ({ meta: { changes: 0 } }),
    first: async () => null,
    all: async () => ({ results: [] }),
  };
  return {
    prepare: (sql) => ({
      bind: () => ({
        ...generico,
        first: async () => (idemFila && /FROM payment_idempotency/.test(sql)) ? idemFila : null,
      }),
      ...generico,
    }),
  };
}

const ENV_BASE = {
  PUBLIC_BASE_URL: "https://rc.example",
  PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00",
  FREE_IP_DAILY: "3",
  ANSWER_LOG: "false",              // el registro no es lo que se prueba aqui
  X402_ENABLED: "true",
  X402_NETWORK: RED,
  X402_PAY_TO: PAY_TO,
  X402_ASSET: ASSET,
  X402_FACILITATOR: "https://facilitador.example",
};

async function llamar(env, args = {}) {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "check_return", arguments: { ...PETICION, ...args } } }),
  }), env);
  return (await r.json()).result;
}

function sobreDePago({ amount = "20000", id = null } = {}) {
  const payload = { signature: "0xsig", authorization: { from: "0x857bEEF0000000000000000000000000000000aa" } };
  if (id) payload.extensions = { "payment-identifier": id };
  return meterEnSobre({
    x402Version: 2,
    accepted: { scheme: "exact", network: RED, amount, asset: ASSET, payTo: PAY_TO },
    payload,
  });
}

// Facilitador de mentira, inyectado sustituyendo el fetch global (cobrarConX402
// lo llama sin opciones, que es como corre en produccion).
function conFacilitador({ verifica = true, liquida = true }, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => String(url).endsWith("/verify")
      ? { isValid: verifica, payer: "0x857bEEF0000000000000000000000000000000aa",
          invalidReason: verifica ? null : "bad_signature" }
      : { success: liquida, transaction: TX, network: RED,
          payer: "0x857bEEF0000000000000000000000000000000aa" },
  });
  return fn().finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------
// 1. RESPUESTA GRATUITA — la condicion critica: NUNCA puede parecer pagada
// ---------------------------------------------------------------------------

test("W49 LO CRITICO: una respuesta del TRAMO GRATIS no lleva bloque x402", async () => {
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "true", DB: db(), AI: ia("YES") };
  const res = await llamar(env);
  const sc = res.structuredContent;
  assert.ok(sc, "tiene que haber respuesta");
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(sc.verdict), "y un veredicto servido gratis");
  assert.equal(sc.x402, undefined, "una respuesta gratuita NO puede parecer pagada");
  assert.equal(res.isError, false);
});

test("W49: y el texto de esa respuesta tampoco menciona una liquidacion", async () => {
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "true", DB: db(), AI: ia("YES") };
  const res = await llamar(env);
  assert.equal(res.content[0].text.includes(TX), false);
  assert.equal(res.content[0].text.includes("settlement"), false);
});

// ---------------------------------------------------------------------------
// 2. RETO 402 — hay terminos de pago, pero no hay pago
// ---------------------------------------------------------------------------

test("W49: el reto lleva x402Version y accepts, pero NO bloque de liquidacion", async () => {
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("YES") };
  const res = await llamar(env);
  const sc = res.structuredContent;
  assert.equal(sc.x402Version, 2, "el reto sigue estando");
  assert.ok(sc.accepts.length);
  assert.equal(sc.x402, undefined, "no se ha pagado nada: no hay nada que demostrar");
  assert.equal(res.isError, true);
});

test("W49: una firma que no cuadra devuelve reto, y tampoco bloque", async () => {
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("YES") };
  const res = await llamar(env, { payment_signature: sobreDePago({ amount: "1" }) });
  assert.equal(res.isError, true);
  assert.match(res.structuredContent.error, /do not match/);
  assert.equal(res.structuredContent.x402, undefined);
});

// ---------------------------------------------------------------------------
// 3. PAGO VALIDO — aqui SI, y con el hash de la transaccion dentro
// ---------------------------------------------------------------------------

test("W49 EL HUECO CERRADO: tras pagar, el hash de la transaccion llega por MCP", async () => {
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { payment_signature: sobreDePago() }));
  const x = res.structuredContent.x402;
  assert.ok(x, "sin esto no hay cadena de evidencia por MCP");
  assert.equal(x.settlement, "confirmed");
  assert.equal(x.transaction, TX);
  assert.equal(x.network, RED);
  assert.equal(x.payer, "0x857bEEF0000000000000000000000000000000aa");
  assert.equal(x.cost_usd, "0.0200");
  assert.equal(res.isError, false);
  // Y el veredicto sigue estando donde estaba: el bloque se AÑADE, no sustituye.
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(res.structuredContent.verdict));
});

test("W49: payment_response es el MISMO sobre que la cabecera de HTTP", async () => {
  // Se construye a partir del sobre, no en paralelo, para que no puedan discrepar.
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { payment_signature: sobreDePago() }));
  const x = res.structuredContent.x402;
  const dentro = sacarDelSobre(x.payment_response);
  assert.equal(dentro.success, true);
  assert.equal(dentro.transaction, x.transaction);
  assert.equal(dentro.network, x.network);
  assert.equal(dentro.payer, x.payer);
});

test("W49 SIN LIQUIDACION NO HAY BLOQUE: se presento autorizacion, pero con UNKNOWN no se liquido", async () => {
  // La formulacion importa y por eso el nombre de esta prueba cambio: SE PRESENTO
  // UNA AUTORIZACION DE PAGO, PERO NO SE PRODUJO LIQUIDACION porque el resultado
  // fue UNKNOWN. La autorizacion caduca sin usarse y no se mueve un centimo.
  // "Un UNKNOWN pagado" seria afirmar un pago que no ocurrio; poner un bloque
  // aqui seria lo mismo, pero escrito en la evidencia.
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("UNKNOWN") };
  const res = await conFacilitador({}, () => llamar(env, { payment_signature: sobreDePago() }));
  assert.equal(res.structuredContent.verdict, "UNKNOWN");
  assert.equal(res.structuredContent.x402, undefined, "no se cobro: no hay liquidacion que demostrar");
});

test("W49: si la liquidacion falla, se vuelve a pedir pago y no hay bloque", async () => {
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("YES") };
  const res = await conFacilitador({ liquida: false }, () => llamar(env, { payment_signature: sobreDePago() }));
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.x402, undefined);
  assert.equal(res.structuredContent.x402Version, 2, "vuelve el reto");
});

// ---------------------------------------------------------------------------
// 4. IDEMPOTENCIA — el reintento no cobra otra vez, pero SI prueba el cobro
// ---------------------------------------------------------------------------

test("W49: un reintento devuelve la transaccion ORIGINAL y coste 0", async () => {
  const id = "kgninja-prueba-0001";
  const v = validateRequest(PETICION);
  const aceptado = { scheme: "exact", network: RED, amount: "20000", asset: ASSET, payTo: PAY_TO };
  const h = await huella({ aceptado, metodo: "POST", ruta: "/mcp", cuerpo: v.value });
  const guardada = JSON.stringify({ schema_version: "1.0", verdict: "YES", returnable: true, policy: null, evidence: null });

  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", AI: ia("YES"),
    DB: db({ idemFila: { payment_id: id, fingerprint: h, response_json: guardada,
                         http_status: 200, transaction_hash: TX,
                         expires_at: "2099-01-01T00:00:00.000Z" } }) };

  const res = await llamar(env, { payment_signature: sobreDePago({ id }) });
  const x = res.structuredContent.x402;
  assert.equal(res.isError, false);
  assert.equal(res.structuredContent.verdict, "YES", "se devuelve lo ya servido");
  assert.ok(x, "el cobro existio: hay que poder demostrarlo tambien en el reintento");
  assert.equal(x.settlement, "replay");
  assert.equal(x.transaction, TX, "la transaccion del cobro ORIGINAL");
  assert.equal(x.cost_usd, "0.0000", "no se ha vuelto a cobrar");
});

// ---------------------------------------------------------------------------
// 5. EL CONTRATO v1.0 NO SE TOCA
// ---------------------------------------------------------------------------

test("W49: el cuerpo de /v1/check NO lleva x402 — el contrato sigue congelado", async () => {
  // La prueba de que el bloque vive SOLO en el resultado de la herramienta MCP.
  // Por HTTP esa evidencia sigue viajando en cabeceras, como siempre.
  const env = { ...ENV_BASE, FREE_TRIAL_ENABLED: "false", DB: db(), AI: ia("YES") };
  const r = await conFacilitador({}, () => worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": sobreDePago() },
    body: JSON.stringify(PETICION),
  }), env));
  assert.equal(r.status, 200);
  const cuerpo = await r.json();
  assert.equal(cuerpo.x402, undefined, "el cuerpo del contrato no gana campos");
  assert.ok(r.headers.get("PAYMENT-RESPONSE"), "la evidencia sigue en la cabecera");
  assert.equal(sacarDelSobre(r.headers.get("PAYMENT-RESPONSE")).transaction, TX);
  assert.equal(r.headers.get("X-ReturnCheck-Settlement"), "confirmed");
});
