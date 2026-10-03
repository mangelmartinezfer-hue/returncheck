// Documentacion de errores: se comprueba contra el CODIGO, no contra si misma.
// Lo que vale de estas pruebas es que un codigo documentado que el servidor ya no
// devuelva, o un desenlace del cobro que deje de estar documentado, rompe aqui.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.mjs";
import { cobrarConX402 } from "../src/cobro-x402.mjs";
import { validateRequest } from "../src/contract.mjs";

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example", X402_ENABLED: "true",
  X402_NETWORK: "eip155:8453", X402_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  X402_PAY_TO: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b", PRICE_USD: "0.02",
  FREE_TRIAL_ENABLED: "false",
};
const SIN_PAGO = { PUBLIC_BASE_URL: "https://rc.example" };

const openapi = async (env) =>
  (await (await worker.fetch(new Request("https://rc.example/openapi.json"), env)).json());

test("con x402 activo se documentan los seis desenlaces reales, con cuerpo de error", async () => {
  const s = await openapi(ENV);
  const r = s.paths["/v1/check"].post.responses;
  assert.deepEqual(Object.keys(r).sort(), ["200", "400", "402", "409", "500", "503"]);
  for (const estado of ["400", "409", "500", "503"])
    assert.equal(r[estado].content["application/json"].schema.$ref, "#/components/schemas/Error");
  // El 402 pagado lleva el reto, no un Error: no debe anunciar cuerpo de error.
  assert.equal(r["402"].content, undefined);
  assert.equal(s.components.schemas.Error.required[0], "error");
});

test("sin x402 no se anuncian el 409 ni el 503, que solo existen en el cobro", async () => {
  const r = (await openapi(SIN_PAGO)).paths["/v1/check"].post.responses;
  assert.deepEqual(Object.keys(r).sort(), ["200", "400", "402", "500"]);
  assert.equal(r["409"], undefined);
  assert.equal(r["503"], undefined);
});

test("cada codigo documentado lo devuelve de verdad el codigo fuente", async () => {
  const fuente = ["src/index.mjs", "src/cobro-x402.mjs", "src/util.mjs"]
    .map((f) => readFileSync(new URL("../" + f, import.meta.url), "utf8")).join("\n");
  const documentado = JSON.stringify((await openapi(ENV)).paths["/v1/check"].post.responses);
  const codigos = [
    "INVALID_INPUT", "PAYMENT_IDENTIFIER_REQUIRED", "CONFLICT",
    "PAYMENT_IN_FLIGHT", "PAYMENT_GATE_UNAVAILABLE", "INTERNAL",
  ];
  for (const codigo of codigos) {
    assert.ok(documentado.includes(codigo), "el codigo " + codigo + " deberia estar documentado");
    assert.ok(fuente.includes('"' + codigo + '"'), "el codigo " + codigo + " no aparece en el servidor");
  }
});

test("el 400 documentado coincide con el que devuelve la puerta ante identidades contradictorias", async () => {
  const peticion = validateRequest({ product_url: "https://shop.example/p/1", buyer_country: "US" });
  assert.equal(peticion.ok, true);
  const pago = {
    extensions: { "payment-identifier": { info: { id: "otro-identificador-valido-01" } } },
    payload: { extensions: { "payment-identifier": "returncheck-payment-test-0001" }, signature: "0x", authorization: {} },
  };
  const db = { prepare() { throw new Error("D1 no debe tocarse"); } };
  const r = await cobrarConX402({ DB: db }, {
    pago, aceptado: { network: "eip155:8453" }, peticion: peticion.value, ruta: "/v1/check", precio: "0.02",
  });
  assert.equal(r.http, 400);
  assert.equal(r.code, "PAYMENT_IDENTIFIER_REQUIRED");
  const doc = (await openapi(ENV)).paths["/v1/check"].post.responses["400"].description;
  assert.ok(doc.includes("PAYMENT_IDENTIFIER_REQUIRED"));
  assert.ok(doc.includes("nothing was settled"), "el 400 dice que no se liquido nada");
});

test("los estados inciertos no se documentan como gratis", async () => {
  const r = (await openapi(ENV)).paths["/v1/check"].post.responses;
  const d200 = r["200"].description.toLowerCase();
  for (const palabra of ["pending", "unconfirmed", "do not assume you were not charged"])
    assert.ok(d200.includes(palabra), "el 200 documenta " + palabra);
  assert.deepEqual(
    r["200"].headers["X-ReturnCheck-Settlement"].schema.enum,
    ["confirmed", "pending", "unconfirmed", "not_charged", "replay"],
  );
  // El 409 distingue las dos causas, que tienen instrucciones de parada distintas.
  assert.ok(r["409"].description.includes("CONFLICT"));
  assert.ok(r["409"].description.includes("PAYMENT_IN_FLIGHT"));
  // El 503 no invita a una segunda autorizacion.
  assert.ok(r["503"].description.includes("never with a second authorization"));
});
