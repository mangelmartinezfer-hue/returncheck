import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { cobrarConX402 } from "../src/cobro-x402.mjs";
import { validateRequest } from "../src/contract.mjs";
import { meterEnSobre } from "../src/x402.mjs";
import {
  baseReal, aplicarEsquema, filaIdem, cuantasIdem,
} from "./dobles/d1-sqlite.mjs";
import {
  huella, reclamar, prepararLiquidacion, completar, liberar,
} from "../src/idempotencia.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RED = "eip155:8453";
const PAYER = "0x857bEEF0000000000000000000000000000000aa";
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID = "returncheck-concurrent-payment-0001";

const ACEPTADO = {
  scheme: "exact", network: RED, amount: "20000", asset: ASSET, payTo: PAY_TO,
};

const PETICION_CRUDA = {
  product_url: "https://eval.example/p/pr2",
  buyer_country: "US",
  item_condition: "unopened",
  reason: "changed_mind",
  purchase_date: "2026-08-01",
  delivery_date: "2026-08-05",
  as_of: "2026-08-20",
  page_text: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery.",
};

function pago(id = ID) {
  const payload = {
    signature: "0xsig",
    authorization: { from: PAYER, to: PAY_TO, value: "20000", nonce: "0x01" },
  };
  if (id !== null) payload.extensions = { "payment-identifier": id };
  return { x402Version: 2, accepted: { ...ACEPTADO }, payload };
}

function ia(contadores) {
  return {
    run: async () => {
      contadores.motor++;
      return { response: JSON.stringify({
        verdict: "YES",
        confidence: 0.99,
        answer_human: "Yes. Within the 30-day window.",
        reason: null,
        merchant_resolved: {
          name: "eval.example", domain: "eval.example", is_marketplace_third_party: false,
        },
        policy: {
          return_category: "MerchantReturnFiniteReturnWindow",
          merchant_return_days: 30,
          window_basis: "delivery_date",
          return_method: [], return_fees: null, refund_type: null,
        },
        evidence: {
          source_url: PETICION_CRUDA.product_url,
          clause_id: null,
          exact_clause: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery.",
        },
      }) };
    },
  };
}

function env(DB, contadores) {
  return {
    DB,
    AI: ia(contadores),
    ANSWER_LOG: "false",
    X402_ENABLED: "true",
    PRICE_USD: "0.02",
    X402_FACILITATOR: "https://facilitador.example",
    X402_NETWORK: RED,
    X402_ASSET: ASSET,
    X402_PAY_TO: PAY_TO,
    PAYMENT_GATE_WAIT_MS: "1000",
  };
}

async function conFacilitador(
  contadores, fn,
  { settleIncierto = false, settleRechazado = false, demoraSettle = 10 } = {}
) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/verify")) {
      contadores.verify++;
      return { ok: true, status: 200, json: async () => ({ isValid: true, payer: PAYER }) };
    }
    if (String(url).endsWith("/settle")) {
      contadores.settle++;
      if (demoraSettle) await new Promise((resolve) => setTimeout(resolve, demoraSettle));
      if (settleIncierto) {
        const error = new Error("respuesta perdida despues de enviar");
        error.name = "TimeoutError";
        throw error;
      }
      if (settleRechazado) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: false, errorReason: "authorization_already_used" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, transaction: TX, network: RED, payer: PAYER }),
      };
    }
    throw new Error("red inesperada: " + url);
  };
  try { return await fn(); }
  finally { globalThis.fetch = original; }
}

function argumentos(peticion = PETICION_CRUDA, id = ID) {
  const v = validateRequest(peticion);
  assert.equal(v.ok, true);
  return { pago: pago(id), aceptado: ACEPTADO, peticion: v.value, ruta: "/v1/check", precio: "0.02" };
}

test("PR-2: dos peticiones simultaneas producen un solo /settle y una sola ejecucion del motor", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env(baseReal(), contadores);

  const [a, b] = await conFacilitador(contadores, () => Promise.all([
    cobrarConX402(entorno, argumentos()),
    cobrarConX402(entorno, argumentos()),
  ]));

  assert.equal(contadores.verify, 1, "la perdedora no verifica");
  assert.equal(contadores.motor, 1, "la perdedora no ejecuta el motor");
  assert.equal(contadores.settle, 1, "exactamente una llamada a /settle");
  assert.deepEqual(new Set([a.tipo, b.tipo]), new Set(["ok", "repetido"]));
  assert.equal(a.cuerpo, b.cuerpo, "las dos reciben la misma respuesta funcional");
  assert.equal(cuantasIdem(entorno.DB), 1);
  assert.equal(filaIdem(entorno.DB, ID).gate_state, "completed");
});

test("PR-2: mismo identificador con otra huella da conflicto y nunca inicia otro cobro", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env(baseReal(), contadores);
  // Cambia la huella sin invalidar la evidencia del motor.
  const otra = { ...PETICION_CRUDA, membership: "Gold" };

  const [a, b] = await conFacilitador(contadores, () => Promise.all([
    cobrarConX402(entorno, argumentos()),
    cobrarConX402(entorno, argumentos(otra)),
  ]));

  assert.equal(contadores.settle, 1);
  assert.ok([a.tipo, b.tipo].includes("conflicto"));
  assert.ok([a.tipo, b.tipo].includes("ok"));
});

test("PR-2: una excepción de D1 falla cerrado; no equivale a changes=0", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env({ prepare: () => { throw new Error("D1 caida"); } }, contadores);
  const r = await conFacilitador(contadores, () => cobrarConX402(entorno, argumentos()));

  assert.equal(r.tipo, "error");
  assert.equal(r.code, "PAYMENT_GATE_UNAVAILABLE");
  assert.equal(r.http, 503);
  assert.deepEqual(contadores, { verify: 0, motor: 0, settle: 0 });
});

test("PR-2: una liquidacion incierta se sirve y su replay no vuelve a /settle", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env(baseReal(), contadores);

  const [primera, replay] = await conFacilitador(contadores, async () => {
    const uno = await cobrarConX402(entorno, argumentos());
    const dos = await cobrarConX402(entorno, argumentos());
    return [uno, dos];
  }, { settleIncierto: true, demoraSettle: 0 });

  assert.equal(primera.tipo, "ok");
  assert.equal(primera.estadoLiquidacion, "unconfirmed");
  assert.equal(replay.tipo, "repetido");
  assert.equal(replay.estadoLiquidacion, "unconfirmed");
  assert.equal(replay.cuerpo, primera.cuerpo);
  assert.deepEqual(contadores, { verify: 1, motor: 1, settle: 1 });
});

test("PR-2: un rechazo de /settle bloquea el reintento monetario", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env(baseReal(), contadores);

  const [primera, replay] = await conFacilitador(contadores, async () => {
    const uno = await cobrarConX402(entorno, argumentos());
    const dos = await cobrarConX402(entorno, argumentos());
    return [uno, dos];
  }, { settleRechazado: true, demoraSettle: 0 });

  assert.equal(primera.tipo, "reto");
  assert.equal(replay.tipo, "reto");
  assert.match(replay.motivo, /cannot be retried automatically/);
  assert.deepEqual(contadores, { verify: 1, motor: 1, settle: 1 });
  assert.equal(filaIdem(entorno.DB, ID).settlement_state, "rejected");
});

test("PR-2: sin payment-identifier no hay motor, verificacion ni liquidacion", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env(baseReal(), contadores);
  const r = await conFacilitador(contadores, () => cobrarConX402(entorno, argumentos(PETICION_CRUDA, null)));

  assert.equal(r.tipo, "error");
  assert.equal(r.code, "PAYMENT_IDENTIFIER_REQUIRED");
  assert.equal(r.http, 400);
  assert.deepEqual(contadores, { verify: 0, motor: 0, settle: 0 });
});

test("PR-2: schema-005 migra filas anteriores como completadas", () => {
  const DB = baseReal(["schema-004-idempotencia.sql"]);
  DB._sqlite.prepare(
    `INSERT INTO payment_idempotency
       (payment_id, fingerprint, response_json, http_status,
        transaction_hash, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    ID, "huella-anterior", '{"verdict":"YES"}', 200, TX,
    "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"
  );

  aplicarEsquema(DB, "schema-005-puerta-idempotencia.sql");
  const fila = filaIdem(DB, ID);
  assert.equal(fila.gate_state, "completed");
  assert.equal(fila.attempt_id, null);
});

test("PR-2: el esquema rechaza una puerta activa sin propietaria", () => {
  const DB = baseReal();
  assert.throws(() => DB._sqlite.prepare(
    `INSERT INTO payment_idempotency
       (payment_id, fingerprint, response_json, http_status,
        created_at, expires_at, gate_state)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    ID, "h", "pendiente", 0,
    "2026-09-21T00:00:00.000Z", "2026-09-22T00:00:00.000Z", "claimed"
  ), /RC_PAYMENT_GATE_OWNER_REQUIRED/);
});

test("PR-2: una propietaria antigua no puede preparar, completar ni liberar el intento nuevo", async () => {
  const DB = baseReal();
  const h = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: PETICION_CRUDA });
  const primera = await reclamar(
    { DB, IDEMPOTENCY_HOURS: 1 }, { id: ID, huella: h },
    "2026-09-21T00:00:00.000Z", "intento-antiguo"
  );
  assert.equal(primera.propietaria, true);

  const segunda = await reclamar(
    { DB, IDEMPOTENCY_HOURS: 1 }, { id: ID, huella: h },
    "2026-09-21T02:00:00.000Z", "intento-nuevo"
  );
  assert.deepEqual(segunda, { propietaria: true, attemptId: "intento-nuevo" });

  assert.equal(await prepararLiquidacion({ DB }, {
    id: ID, huella: h, attemptId: "intento-antiguo", cuerpo: { verdict: "YES" },
  }), false);
  assert.equal(await completar({ DB }, {
    id: ID, huella: h, attemptId: "intento-antiguo", cuerpo: { verdict: "YES" },
    estadoLiquidacion: "confirmed",
  }), false);
  assert.equal(await liberar({ DB }, {
    id: ID, huella: h, attemptId: "intento-antiguo",
  }), false);
  assert.equal(filaIdem(DB, ID).attempt_id, "intento-nuevo");
});

test("PR-2: una fila settling no se recicla por antigüedad", async () => {
  const DB = baseReal();
  const h = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: PETICION_CRUDA });
  await reclamar(
    { DB, IDEMPOTENCY_HOURS: 1 }, { id: ID, huella: h },
    "2026-09-21T00:00:00.000Z", "intento-1"
  );
  assert.equal(await prepararLiquidacion({ DB }, {
    id: ID, huella: h, attemptId: "intento-1", cuerpo: { verdict: "YES" },
  }, "2026-09-21T00:10:00.000Z"), true);

  const mientrasLiquida = await reclamar(
    { DB, IDEMPOTENCY_HOURS: 1 }, { id: ID, huella: h },
    "2026-09-21T00:10:30.000Z", "intento-2"
  );
  assert.equal(mientrasLiquida.enCurso, true);

  const posterior = await reclamar(
    { DB, IDEMPOTENCY_HOURS: 1 }, { id: ID, huella: h },
    "2026-09-22T00:00:00.000Z", "intento-2"
  );
  assert.equal(posterior.repetido, true);
  assert.equal(posterior.estadoLiquidacion, "unconfirmed");
  assert.equal(filaIdem(DB, ID).attempt_id, "intento-1");
});

test("PR-2: el replay HTTP incierto omite PAYMENT-RESPONSE", async () => {
  const contadores = { verify: 0, motor: 0, settle: 0 };
  const entorno = env(baseReal(), contadores);
  const v = validateRequest(PETICION_CRUDA);
  const h = await huella({
    aceptado: ACEPTADO, metodo: "POST", ruta: "/v1/check", cuerpo: v.value,
  });
  const propietario = await reclamar(entorno, { id: ID, huella: h });
  await completar(entorno, {
    id: ID, huella: h, attemptId: propietario.attemptId,
    cuerpo: { schema_version: "1.0", verdict: "YES" },
    transaccion: TX, estadoLiquidacion: "pending",
  });

  const respuesta = await worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "PAYMENT-SIGNATURE": meterEnSobre(pago()),
    },
    body: JSON.stringify(PETICION_CRUDA),
  }), entorno);

  assert.equal(respuesta.status, 200);
  assert.equal(respuesta.headers.get("X-ReturnCheck-Settlement"), "pending");
  assert.equal(respuesta.headers.get("PAYMENT-RESPONSE"), null);
  assert.deepEqual(contadores, { verify: 0, motor: 0, settle: 0 });
});
