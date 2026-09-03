// W56 — `resource` EN EL SOBRE DE PAGO.
//
// QUE FIJA ESTA PRUEBA, Y POR QUE COSTO UNA TARDE ENCONTRARLO.
//
// La especificacion x402 v2 marca `resource` como OPCIONAL dentro del
// PaymentPayload (specs/x402-specification-v2.md: en PaymentPayload es
// "Required: No", y PaymentRequirements ni siquiera tiene ese campo). Mogami,
// que es nuestro facilitador, lo EXIGE. Sin el responde:
//
//     {"isValid": false, "invalidReason": "invalid_payload"}
//
// que es EXACTAMENTE el mismo mensaje que devuelve ante una firma falsa. Ese es
// el problema: el sintoma acusa al comprador y la causa esta en nuestro lado.
//
// MEDIDO, no supuesto. El 3 de septiembre de 2026, en Base mainnet, con una
// firma real hecha en MetaMask:
//   · se recupero la direccion firmante de la firma con secp256k1 y salia
//     identica al campo `from` -> la firma era valida;
//   · se simulo `transferWithAuthorization` con `eth_call` desde el propio
//     firmante de Mogami y PASABA contra el contrato USDC -> la autorizacion era
//     ejecutable en la cadena;
//   · y aun asi Mogami devolvia `invalid_payload`.
// Con `resource` anadido al sobre, la misma firma dio `isValid: true` y la
// liquidacion entro a la primera (tx 0xbdbac71f...b03e68ce3).
//
// O sea que, hasta W56, NINGUNA firma buena podia entrar. Eso explica por que el
// bloque de liquidacion no se habia observado nunca en produccion.
//
// Lo que se comprueba aqui:
//   1. el sobre validado SALE con `resource`, aunque llegue sin el;
//   2. ese `resource` es el MISMO que el del reto (una sola fuente);
//   3. es adicion y no requisito: un sobre sin `resource` se sigue aceptando;
//   4. los cinco campos que mueven dinero se comparan igual que antes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recursoDePago, retoDePago, validarPagoDecodificado, validarSobreDePago,
  leerFirmaDePago, meterEnSobre, requisitosDePago,
} from "../src/x402.mjs";

const RED = "eip155:8453";
const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE = "https://rc.example";

const ENV = {
  PUBLIC_BASE_URL: BASE, PRICE_USD: "0.02", X402_ENABLED: "true",
  X402_NETWORK: RED, X402_PAY_TO: PAY_TO, X402_ASSET: ASSET,
  X402_ASSET_NAME: "USD Coin", X402_ASSET_VERSION: "2",
};

const ACEPTADO = {
  scheme: "exact", network: RED, amount: "20000", asset: ASSET, payTo: PAY_TO,
  maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
};

// Un sobre tal y como lo manda un cliente x402 que sigue la especificacion: SIN
// `resource`, porque la especificacion no lo obliga.
const sobreSinRecurso = () => ({
  x402Version: 2,
  accepted: { ...ACEPTADO },
  payload: {
    signature: "0x" + "ab".repeat(65),
    authorization: {
      from: "0xce4fbd6ea0d2e73a8d8959b4c8e28ec39bd3c236", to: PAY_TO, value: "20000",
      validAfter: "0", validBefore: "1893456000", nonce: "0x" + "cd".repeat(32),
    },
  },
});

// ---------------------------------------------------------------------------
// 1 · El sobre sale con `resource` aunque llegue sin el
// ---------------------------------------------------------------------------

test("W56: un sobre SIN resource se acepta y SALE con resource", () => {
  const r = validarPagoDecodificado(sobreSinRecurso(), ENV);
  assert.equal(r.ok, true, "un sobre sin resource NO puede rechazarse: es adicion, no requisito");
  assert.ok(r.pago.resource, "el sobre validado tiene que llevar resource al salir");
  assert.equal(typeof r.pago.resource.url, "string");
  assert.ok(r.pago.resource.url.length > 0);
});

test("W56: el sobre que llega no se toca; el resource va en la copia que sale", () => {
  const entrada = sobreSinRecurso();
  const r = validarPagoDecodificado(entrada, ENV);
  assert.equal(entrada.resource, undefined, "el objeto de entrada no se muta");
  assert.ok(r.pago.resource);
});

// ---------------------------------------------------------------------------
// 2 · Es EL MISMO recurso que el del reto — una sola fuente
// ---------------------------------------------------------------------------

test("W56: el resource del sobre es identico al del reto para la misma url", () => {
  const url = BASE + "/mcp";
  const reto = retoDePago(ENV, { url });
  const r = validarPagoDecodificado(sobreSinRecurso(), ENV, { url });
  assert.deepEqual(r.pago.resource, reto.resource,
    "si divergieran habria dos fuentes para lo mismo y acabarian separandose");
});

test("W56: cada transporte declara SU recurso", () => {
  const mcp = validarPagoDecodificado(sobreSinRecurso(), ENV, { url: BASE + "/mcp" });
  const http = validarPagoDecodificado(sobreSinRecurso(), ENV, { url: BASE + "/v1/check" });
  assert.equal(mcp.pago.resource.url, BASE + "/mcp");
  assert.equal(http.pago.resource.url, BASE + "/v1/check");
});

test("W56: sin url se cae al recurso HTTP, el mismo que anuncia el .well-known", () => {
  const r = validarPagoDecodificado(sobreSinRecurso(), ENV);
  assert.deepEqual(r.pago.resource, recursoDePago(ENV));
  assert.equal(r.pago.resource.url, BASE + "/v1/check");
});

test("W56: el recurso lleva url, description y mimeType", () => {
  const rec = recursoDePago(ENV, { url: BASE + "/mcp" });
  assert.deepEqual(Object.keys(rec).sort(), ["description", "mimeType", "url"]);
  assert.equal(rec.mimeType, "application/json");
  assert.ok(rec.description.includes("ReturnCheck"));
});

// ---------------------------------------------------------------------------
// 3 · Las dos puertas de entrada emiten lo mismo
// ---------------------------------------------------------------------------

test("W56: por cabecera base64 (HTTP) el sobre tambien sale con resource", () => {
  const req = { url: BASE + "/v1/check",
    headers: { get: (k) => (k === "PAYMENT-SIGNATURE" ? meterEnSobre(sobreSinRecurso()) : null) } };
  const r = leerFirmaDePago(req, ENV);
  assert.equal(r.ok, true);
  assert.equal(r.pago.resource.url, BASE + "/v1/check");
});

test("W56: los dos vehiculos de MCP dan el MISMO resource, asi que no hay ambiguedad", () => {
  const url = BASE + "/mcp";
  const porMeta = validarPagoDecodificado(sobreSinRecurso(), ENV, { url });
  const porArgumento = validarSobreDePago(meterEnSobre(sobreSinRecurso()), ENV, { url });
  assert.deepEqual(porMeta.pago.resource, porArgumento.pago.resource,
    "si difirieran, un cliente que mandase los dos vehiculos seria rechazado por ambiguo");
  assert.deepEqual(porMeta.pago, porArgumento.pago);
});

// ---------------------------------------------------------------------------
// 4 · Si el comprador manda uno, manda el nuestro
// ---------------------------------------------------------------------------

test("W56: un resource enviado por el comprador se reemplaza por el nuestro", () => {
  const suyo = { ...sobreSinRecurso(), resource: { url: "https://otro.example/gratis" } };
  const r = validarPagoDecodificado(suyo, ENV, { url: BASE + "/mcp" });
  assert.equal(r.ok, true, "no se rechaza: no es un campo que el comprador pueda equivocarse en mandar");
  assert.equal(r.pago.resource.url, BASE + "/mcp",
    "el recurso es el que NOSOTROS servimos; no se declara al facilitador un valor que no podemos comprobar");
});

// ---------------------------------------------------------------------------
// 5 · Lo que W56 NO toca: los cinco campos que mueven dinero
// ---------------------------------------------------------------------------

test("W56 NO relaja aceptadoCoincide: los cinco campos se siguen comparando", () => {
  const cambios = [
    ["amount", "1"],
    ["payTo", "0x0000000000000000000000000000000000000bad"],
    ["asset", "0x0000000000000000000000000000000000000bad"],
    ["network", "eip155:84532"],
    ["scheme", "upto"],
  ];
  for (const [campo, valor] of cambios) {
    const malo = sobreSinRecurso();
    malo.accepted[campo] = valor;
    const r = validarPagoDecodificado(malo, ENV, { url: BASE + "/mcp" });
    assert.equal(r.ok, false, "un " + campo + " distinto tiene que seguir rechazandose");
    assert.match(r.error, /do not match/);
  }
});

test("W56: anadir resource no salta ninguna de las comprobaciones previas", () => {
  const sinPayload = { x402Version: 2, accepted: { ...ACEPTADO } };
  assert.equal(validarPagoDecodificado(sinPayload, ENV).ok, false);

  const v1 = { ...sobreSinRecurso(), x402Version: 1 };
  const r = validarPagoDecodificado(v1, ENV);
  assert.equal(r.ok, false);
  assert.match(r.error, /x402Version/);

  // Sin configuracion de cobro no se emite nada, resource incluido.
  const sinCobro = validarPagoDecodificado(sobreSinRecurso(), { X402_ENABLED: "true" });
  assert.equal(sinCobro.ok, false);
  assert.equal(sinCobro.pago, undefined);
});

test("W56: requisitosDePago sigue sin llevar resource (la spec no lo tiene ahi)", () => {
  const req = requisitosDePago(ENV);
  assert.equal(req.length, 1);
  assert.equal(req[0].resource, undefined,
    "PaymentRequirements no tiene campo resource en la especificacion v2");
});
