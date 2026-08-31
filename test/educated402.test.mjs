// W50 — EL 402 EDUCADO DECIA UNA MENTIRA.
//
// Servia, por escrito, que el pago entre agentes estaba "not_yet_enabled" y que
// llegaba "Coming in Phase 2". Es falso desde W46: x402 cobra en Base mainnet.
// Y no era una mentira inocua ni escondida: la rama que de verdad se alcanza en
// produccion es la de CLAVE CON SALDO CERO, o sea que era lo primero que iba a
// leer un agente ajeno justo cuando se queda sin credito — el momento exacto en
// que le estas diciendo como seguir pagando.
//
// LO QUE VIGILAN ESTAS PRUEBAS. Las dos primeras, que la mentira ya no se sirve.
// La tercera, que lo que se sirve en su lugar describe la ruta que EXISTE. Y las
// demas —las que de verdad importan— que arreglar un texto no ha movido ni una
// condicion: el saldo cero se comporta igual que ayer, y ni HTTP ni MCP han
// cambiado de logica. Un arreglo informativo que cambia conducta deja de ser
// informativo.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example",
  PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00",
  FREE_IP_DAILY: "3",
  FREE_TRIAL_ENABLED: "false",
  X402_ENABLED: "true",
  X402_NETWORK: "eip155:8453",
  X402_PAY_TO: PAY_TO,
  X402_ASSET: ASSET,
};

// Base falsa: un cliente activo con el saldo que se le diga.
function db(saldo) {
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

const PETICION = { product_url: "https://t.example/p/1", buyer_country: "US" };

// La rama que de verdad se alcanza en produccion: clave valida, saldo cero.
const saldoCero = (env = ENV) =>
  worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer rc_live_test" },
    body: JSON.stringify(PETICION),
  }), { ...env, DB: db(0) });

// La otra ruta que servia la nota obsoleta.
const agentCheck = () =>
  worker.fetch(new Request("https://rc.example/v1/agent/check", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(PETICION),
  }), { ...ENV, DB: db(0) });

// ---------------------------------------------------------------------------
// 1. La mentira ya no se sirve
// ---------------------------------------------------------------------------

test("W50: la respuesta ya NO contiene 'not_yet_enabled'", async () => {
  const cuerpo = await (await saldoCero()).text();
  assert.equal(cuerpo.includes("not_yet_enabled"), false);
});

test("W50: la respuesta ya NO contiene 'Coming in Phase 2'", async () => {
  const cuerpo = await (await saldoCero()).text();
  assert.equal(cuerpo.includes("Coming in Phase 2"), false);
  assert.equal(cuerpo.includes("Phase 2"), false, "ninguna referencia a fases pendientes");
});

test("W50: /v1/agent/check tampoco dice ya que x402 este pendiente", async () => {
  const cuerpo = await (await agentCheck()).text();
  assert.equal(cuerpo.includes("not yet enabled"), false);
  assert.equal(cuerpo.includes("Phase 2"), false);
});

// ---------------------------------------------------------------------------
// 2. Lo que se sirve en su lugar describe la ruta REAL
// ---------------------------------------------------------------------------

test("W50: la descripcion coincide con la ruta que de verdad existe", async () => {
  const x = (await (await saldoCero()).json()).how_to_pay.x402_agentic;
  assert.equal(x.status, "enabled");
  // Las dos puertas por las que se paga de verdad, nombradas como se llaman.
  assert.match(x.description, /PAYMENT-SIGNATURE/);
  assert.match(x.description, /POST \/v1\/check/);
  assert.match(x.description, /payment_signature/);
  assert.match(x.description, /check_return/);
  // Y donde se leen los terminos sin gastar una llamada.
  assert.match(x.description, /\/\.well-known\/x402/);
  // La red real, no una de pruebas.
  assert.match(x.description, /Base mainnet/);
});

test("W50 LA TRAMPA: no promete que una clave sin saldo pase sola a x402", async () => {
  // Es lo que NO ocurre, y decirlo mal seria cambiar una mentira por otra: esta
  // misma peticion no continua por x402, hay que reenviarla con autorizacion.
  const x = (await (await saldoCero()).json()).how_to_pay.x402_agentic;
  assert.match(x.description, /does not switch to x402 on its own/);
  assert.match(x.description, /resend it with an authorization/);
});

test("W50: la estructura del contrato no cambia — mismos campos, sin anadidos", async () => {
  const h = (await (await saldoCero()).json()).how_to_pay;
  assert.deepEqual(Object.keys(h).sort(), ["fiat_prepaid", "x402_agentic"]);
  assert.deepEqual(Object.keys(h.x402_agentic).sort(), ["description", "status"]);
  assert.deepEqual(Object.keys(h.fiat_prepaid).sort(),
    ["description", "note", "price_usd_per_call", "signup"]);
});

// ---------------------------------------------------------------------------
// 3. Lo que NO puede haber cambiado
// ---------------------------------------------------------------------------

test("W50: la clave con saldo cero mantiene su comportamiento — 402, sin reto x402", async () => {
  const r = await saldoCero();
  assert.equal(r.status, 402);
  const b = await r.json();
  assert.equal(b.error.code, "PAYMENT_REQUIRED");
  assert.match(b.error.message, /Insufficient balance/);
  // Sigue SIN ser un reto x402: ni cabecera ni accepts. Esto es conducta, no texto.
  assert.equal(r.headers.get("PAYMENT-REQUIRED"), null);
  assert.equal(b.accepts, undefined);
  assert.equal(b.x402Version, undefined);
});

test("W50: HTTP no cambia de logica — sin clave y tramo agotado sigue dando el reto x402", async () => {
  const r = await worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(PETICION),
  }), { ...ENV, DB: db(0) });
  assert.equal(r.status, 402);
  assert.ok(r.headers.get("PAYMENT-REQUIRED"), "esta rama SI es el reto de verdad");
  const b = await r.json();
  assert.equal(b.x402Version, 2);
  assert.equal(b.accepts[0].payTo, PAY_TO);
});

test("W50: MCP no cambia de logica — saldo cero sigue dando texto plano sin reto", async () => {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer rc_live_test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "check_return", arguments: PETICION } }),
  }), { ...ENV, DB: db(0) });
  const res = (await r.json()).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Insufficient balance/);
  assert.equal(res.structuredContent, undefined, "por MCP el saldo cero nunca fue un reto, y sigue sin serlo");
});

test("W50: MCP sin clave y con tramo agotado sigue dando el reto en structuredContent", async () => {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "check_return", arguments: PETICION } }),
  }), { ...ENV, DB: db(0) });
  const res = (await r.json()).result;
  assert.equal(res.structuredContent.x402Version, 2);
  assert.equal(res.structuredContent.accepts[0].payTo, PAY_TO);
});
