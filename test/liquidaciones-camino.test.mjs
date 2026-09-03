// W57 — LA EVIDENCIA SE ESCRIBE DESDE EL CAMINO COMPARTIDO.
//
// Las pruebas de `liquidaciones.test.mjs` miran el modulo por dentro. Estas
// miran lo unico que de verdad importa: que al pagar por HTTP y al pagar por
// MCP se escriba la fila, y que al no cobrarse NO se escriba.
//
// POR QUE HACEN FALTA LAS DOS. La regla "UNKNOWN no deja liquidacion" no vive en
// `registrarLiquidacion`: vive en DONDE se la llama, colgando de
// `veredictoCobrable` en cobro-x402.mjs. Una prueba del modulo suelto la daria
// por buena aunque alguien moviera la llamada fuera de ese `if`, que es
// exactamente el error que costaria dinero: registrar un cobro que no existio.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { meterEnSobre } from "../src/x402.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RED    = "eip155:8453";
const TX     = "0xdeadbeefcafe0000000000000000000000000000000000000000000000000057";
const PAYER  = "0x857bEEF0000000000000000000000000000000aa";
const NONCE  = "0x4748f83dd8b3f1ad933f056181b085e3d1b006556fc909feb23f9350f6f4d5c6";

const POLIZA = "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories.";
const PETICION = {
  product_url: "https://eval.example/p/RC25-01", buyer_country: "US",
  item_condition: "unopened", reason: "changed_mind",
  purchase_date: "2026-08-01", delivery_date: "2026-08-05", as_of: "2026-08-20",
  page_text: POLIZA,
};

// ANSWER_LOG activo, como en produccion. NO es un detalle de montaje: el enlace
// de la evidencia es el `check_id`, que ES el id de la fila de `answer_log`. Sin
// registro de respuestas no hay check_id que enlazar. Ver la ultima prueba.
const ENV = {
  PUBLIC_BASE_URL: "https://rc.example", PRICE_USD: "0.02", ANSWER_LOG: "true",
  X402_ENABLED: "true", X402_NETWORK: RED, X402_PAY_TO: PAY_TO, X402_ASSET: ASSET,
  X402_ASSET_NAME: "USD Coin", X402_ASSET_VERSION: "2",
  X402_FACILITATOR: "https://facilitador.example", FREE_TRIAL_ENABLED: "false",
  ANSWER_RETENTION_MONTHS: "12",
};

function ia(verdict) {
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

// D1 de mentira que solo se fija en una cosa: que se inserta en settlement_log.
function db() {
  const liquidaciones = [];
  const g = { run: async () => ({ meta: { changes: 0 } }), first: async () => null,
              all: async () => ({ results: [] }) };
  return {
    _liq: liquidaciones,
    prepare: (sql) => ({
      bind: (...a) => ({
        ...g,
        run: async () => {
          if (/INSERT OR IGNORE INTO settlement_log/.test(sql.replace(/\s+/g, " "))) {
            const [check_id, settled_at, status, transaction_hash, network, payer,
                   amount_atomic, asset, nonce, pay_to, mismatch, retention_until] = a;
            liquidaciones.push({ check_id, settled_at, status, transaction_hash, network,
              payer, amount_atomic, asset, nonce, pay_to, mismatch, retention_until });
          }
          return { meta: { changes: 1 } };
        },
      }),
      ...g,
    }),
  };
}

const sobre = () => ({
  x402Version: 2,
  accepted: { scheme: "exact", network: RED, amount: "20000", asset: ASSET,
              payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } },
  payload: { signature: "0xsig", authorization: {
    from: PAYER, to: PAY_TO, value: "20000",
    validAfter: "0", validBefore: "1893456000", nonce: NONCE } },
});

function conFacilitador({ settle = null, settleCae = false } = {}, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/verify"))
      return { ok: true, status: 200, json: async () => ({ isValid: true, payer: PAYER }) };
    if (settleCae) return { ok: false, status: 504, json: async () => ({}) };
    return { ok: true, status: 200,
             json: async () => settle || { success: true, transaction: TX, network: RED, payer: PAYER } };
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

const porMcp = (env) => worker.fetch(new Request("https://rc.example/mcp", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "check_return", arguments: PETICION, _meta: { "x402/payment": sobre() } } }),
}), env);

const porHttp = (env) => worker.fetch(new Request("https://rc.example/v1/check", {
  method: "POST",
  headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": meterEnSobre(sobre()) },
  body: JSON.stringify(PETICION),
}), env);

// ---------------------------------------------------------------------------

test("W57: pagando por MCP se escribe la evidencia, atada al check_id servido", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => porMcp(env));
  const cuerpo = (await res.json()).result.structuredContent;

  assert.equal(env.DB._liq.length, 1);
  const f = env.DB._liq[0];
  assert.equal(f.check_id, cuerpo.meta.check_id,
    "el enlace con la respuesta es el check_id, y tiene que ser EL de la respuesta servida");
  assert.equal(f.status, "confirmed");
  assert.equal(f.transaction_hash, TX);
  assert.equal(f.transaction_hash, cuerpo.x402.transaction);
  assert.equal(f.network, RED);
  assert.equal(f.payer, PAYER);
  assert.equal(f.amount_atomic, "20000");
  assert.equal(f.asset, ASSET);
  assert.equal(f.nonce, NONCE);
  assert.equal(f.pay_to, PAY_TO);
  assert.equal(f.mismatch, null);
  assert.ok(f.retention_until > f.settled_at);
});

test("W57: pagando por HTTP se escribe la MISMA evidencia (camino compartido)", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => porHttp(env));
  assert.equal(res.status, 200);
  assert.equal(env.DB._liq.length, 1);
  assert.equal(env.DB._liq[0].status, "confirmed");
  assert.equal(env.DB._liq[0].transaction_hash, TX);
});

test("W57 LA REGLA QUE CUESTA DINERO: UNKNOWN no deja liquidacion", async () => {
  // No se liquida, luego no hay nada que registrar. Si esto se rompiera,
  // estariamos guardando la evidencia de un cobro que no existio.
  const env = { ...ENV, DB: db(), AI: ia("UNKNOWN") };
  const res = await conFacilitador({}, () => porMcp(env));
  const cuerpo = (await res.json()).result.structuredContent;
  assert.equal(cuerpo.verdict, "UNKNOWN");
  assert.equal(cuerpo.x402, undefined, "UNKNOWN no emite bloque de pago");
  assert.equal(env.DB._liq.length, 0, "ni fila de liquidacion");
});

test("W57: sin la extension payment-identifier la evidencia se escribe igual", async () => {
  // El sobre de `sobre()` no lleva extensions. Antes de W57, este pago no dejaba
  // NINGUNA correlacion entre la respuesta y la transaccion.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  await conFacilitador({}, () => porMcp(env));
  assert.equal(env.DB._liq.length, 1);
  assert.equal(env.DB._liq[0].transaction_hash, TX);
});

test("W57: una liquidacion sin confirmar se guarda como unconfirmed, no se pierde", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  await conFacilitador({ settleCae: true }, () => porMcp(env));
  assert.equal(env.DB._liq.length, 1);
  assert.equal(env.DB._liq[0].status, "unconfirmed");
  assert.equal(env.DB._liq[0].transaction_hash, null);
  // La red y el pagador se conservan de lo pedido y de lo firmado, que es lo que
  // permite ir a buscar esa transaccion a la cadena cuando se concilie.
  assert.equal(env.DB._liq[0].network, RED);
  assert.equal(env.DB._liq[0].payer, PAYER);
});

test("W57: el facilitador dice otro pagador -> se guarda unconfirmed con el motivo", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  await conFacilitador({ settle: { success: true, transaction: TX, network: RED,
    payer: "0x0000000000000000000000000000000000000bad" } }, () => porMcp(env));
  assert.equal(env.DB._liq[0].status, "unconfirmed");
  assert.equal(env.DB._liq[0].mismatch, "payer");
});

test("W57 CONSECUENCIA QUE HAY QUE SABER: con ANSWER_LOG apagado no hay evidencia", async () => {
  // El enlace pedido es el `check_id`, y el check_id ES el id de la fila de
  // `answer_log`. Con el registro de respuestas apagado no se genera, asi que no
  // hay nada a lo que atar la liquidacion y no se escribe fila.
  //
  // NO ES UN DESCUIDO: una fila de liquidacion sin su respuesta no dice a que
  // pago corresponde, que es justo lo que veniamos a arreglar. Pero SI es un
  // acoplamiento real, y queda aqui escrito: apagar ANSWER_LOG apaga tambien la
  // evidencia de cobro. Si algun dia se quiere una cosa sin la otra, hay que
  // decidirlo a proposito y no descubrirlo el dia que haga falta la fila.
  const env = { ...ENV, ANSWER_LOG: "false", DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => porMcp(env));
  const cuerpo = (await res.json()).result.structuredContent;
  assert.equal(cuerpo.x402.settlement, "confirmed", "el cobro ocurre igual");
  assert.equal(cuerpo.meta.check_id, undefined, "pero no hay check_id que enlazar");
  assert.equal(env.DB._liq.length, 0);
});
