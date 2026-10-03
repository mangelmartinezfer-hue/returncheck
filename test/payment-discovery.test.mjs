import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { leerIdentificador } from "../src/idempotencia.mjs";
import { limpiarParaFacilitador } from "../src/facilitador.mjs";
import { requisitosDePago, sacarDelSobre } from "../src/x402.mjs";
import { CHECK_EXAMPLE } from "../src/payment-discovery.mjs";
import { validateRequest } from "../src/contract.mjs";

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example", X402_ENABLED: "true",
  X402_NETWORK: "eip155:8453", X402_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  X402_PAY_TO: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b", PRICE_USD: "0.02",
  FREE_TRIAL_ENABLED: "false",
};
const id = "returncheck-payment-test-0001";
const standard = value => ({ extensions: { "payment-identifier": { info: { required: true, id: value } } } });

test("published HTTP challenge, header and discovery agree without DB or model", async () => {
  const r = await worker.fetch(new Request("https://rc.example/v1/check", { method: "POST", body: JSON.stringify(CHECK_EXAMPLE) }), ENV);
  assert.equal(r.status, 402);
  const challenge = await r.json();
  const { human_next_steps, ...protocolChallenge } = challenge;
  assert.deepEqual(sacarDelSobre(r.headers.get("PAYMENT-REQUIRED")), protocolChallenge);
  const discovery = await (await worker.fetch(new Request("https://rc.example/.well-known/x402"), ENV)).json();
  assert.deepEqual(challenge.extensions, discovery.extensions);
  assert.equal(challenge.extensions["payment-identifier"].info.required, true);
  assert.deepEqual(challenge.accepts, requisitosDePago(ENV));
  assert.equal(validateRequest(challenge.extensions.bazaar.info.input.body).ok, true);
  assert.ok(r.headers.get("PAYMENT-REQUIRED").length < 16000);
});

test("OpenAPI announces x402, atomic terms and an executable synthetic example", async () => {
  const s = await (await worker.fetch(new Request("https://rc.example/openapi.json"), ENV)).json();
  const op = s.paths["/v1/check"].post;
  assert.deepEqual(op["x-payment-info"], { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: "0.02" } });
  assert.equal(op["x-x402"].accepts[0].amount, "20000");
  assert.equal(op["x-x402"].x402Version, 2);
  assert.equal(op["x-x402"].unknown_is_free, true);
  assert.equal(validateRequest(op.requestBody.content["application/json"].example).ok, true);
  const off = await (await worker.fetch(new Request("https://rc.example/openapi.json"), { ...ENV, X402_ENABLED: "false" })).json();
  assert.equal(off.paths["/v1/check"].post["x-payment-info"], undefined);
});

test("standard and legacy identifiers resolve to the same durable key", () => {
  assert.equal(leerIdentificador(standard(id)), id);
  assert.equal(leerIdentificador({ payload: { extensions: { "payment-identifier": id } } }), id);
  assert.equal(leerIdentificador({ ...standard(id), payload: { extensions: { "payment-identifier": id } } }), id);
});

test("invalid standard identifiers cannot fall back to a valid legacy identity", () => {
  for (const bad of [null, 123, "short", "a".repeat(129), "spaces not allowed", "different-valid-id-0001"]) {
    assert.equal(leerIdentificador({ ...standard(bad), payload: { extensions: { "payment-identifier": id } } }), null);
  }
});

test("facilitator adapter strips both extension locations without mutating signature or identity", () => {
  const p = { ...standard(id), payload: { signature: "0xtest", authorization: { nonce: "0x01" }, extensions: { "payment-identifier": id } } };
  const original = structuredClone(p);
  const clean = limpiarParaFacilitador(p);
  assert.equal(clean.extensions, undefined);
  assert.equal(clean.payload.extensions, undefined);
  assert.equal(clean.payload.signature, p.payload.signature);
  assert.deepEqual(clean.payload.authorization, p.payload.authorization);
  assert.deepEqual(p, original);
  assert.equal(leerIdentificador(p), id);
});
