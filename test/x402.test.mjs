// W28 — x402: el reto de pago y sus sobres.
//
// Todo esto se prueba sin cartera, sin céntimos y sin red. Por eso se construyó
// primero: la mitad del protocolo que no toca dinero se puede dejar cerrada y
// medida antes de que exista una dirección de cobro.
//
// Los ejemplos son los de la especificación de transporte v2, no inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  X402_VERSION, RED, aUnidadesAtomicas, meterEnSobre, sacarDelSobre,
  x402Activo, requisitosDePago, retoDePago, aceptadoCoincide,
  leerFirmaDePago, cabeceraLiquidacion, pagadorDe,
} from "../src/x402.mjs";

const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MI_DIRECCION = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const ENV = {
  X402_ENABLED: "true",
  X402_NETWORK: RED.BASE_SEPOLIA,
  X402_PAY_TO: MI_DIRECCION,
  X402_ASSET: USDC_SEPOLIA,
  PRICE_USD: "0.02",
};

// ---------------------------------------------------------------------------
// El céntimo. Es donde se pierde el dinero sin que nadie se entere.
// ---------------------------------------------------------------------------

test("EL DETALLE QUE MUEVE DINERO: la coma se mueve sobre el TEXTO, no multiplicando", () => {
  // CORRECCION A MI MISMO: escribi que 0.02 * 1e6 daba 20000.000000000004 y lo
  // di por bueno sin comprobarlo. Es FALSO — ese caso sale exacto. Pero el
  // problema existe y esta medido; solo que en otros precios:
  //
  //    1.005 * 1e6  =  1004999.9999999999   -> truncando se cobra UNA unidad DE MENOS
  //    8.13  * 1e6  =  8130000.000000001    -> y aqui una DE MAS
  //
  // Hoy el precio es 0,02 y saldria bien por casualidad. Pero PRICE_USD es una
  // variable de configuracion: el dia que se ponga 1.005 el fallo aparece solo, y
  // en dinero. Por eso se hace sobre la cadena, que es exacto para todo precio.
  assert.equal(aUnidadesAtomicas("0.02"), "20000");

  // Los dos casos donde multiplicar SI falla, comprobados y no supuestos:
  assert.equal(Number.isInteger(1.005 * 1e6), false);
  assert.equal(aUnidadesAtomicas("1.005"), "1005000");   // exacto
  assert.equal(Number.isInteger(8.13 * 1e6), false);
  assert.equal(aUnidadesAtomicas("8.13"), "8130000");    // exacto
});

test("unidades atómicas: casos que hay que aguantar", () => {
  assert.equal(aUnidadesAtomicas("1"), "1000000");
  assert.equal(aUnidadesAtomicas("0.000001"), "1");       // el mínimo de USDC
  assert.equal(aUnidadesAtomicas("10.5"), "10500000");
  assert.equal(aUnidadesAtomicas("0.1"), "100000");
});

test("unidades atómicas: lo que hay que RECHAZAR, no redondear", () => {
  // Más precisión de la que el token tiene no se redondea a la baja en silencio:
  // se rechaza. Redondear es decidir por el comercio cuánto cobra.
  assert.equal(aUnidadesAtomicas("0.0000001"), null);
  assert.equal(aUnidadesAtomicas("abc"), null);
  assert.equal(aUnidadesAtomicas(""), null);
  assert.equal(aUnidadesAtomicas(null), null);
  assert.equal(aUnidadesAtomicas("-1"), null);
});

// ---------------------------------------------------------------------------
// Los sobres base64
// ---------------------------------------------------------------------------

test("sobre: lo que se mete sale igual, con acentos incluidos", () => {
  const o = { a: 1, b: "ñandú €", c: [1, 2, 3] };
  assert.deepEqual(sacarDelSobre(meterEnSobre(o)), o);
});

test("sobre: una cabecera corrupta devuelve null y NO revienta", () => {
  // La manda un cliente cualquiera. Que un tercero pueda tumbarnos con una
  // cabecera mal formada seria un fallo nuestro, no suyo.
  assert.equal(sacarDelSobre("esto no es base64 !!!"), null);
  assert.equal(sacarDelSobre(meterEnSobre("texto suelto") + "XX"), null);
  assert.equal(sacarDelSobre(""), null);
  assert.equal(sacarDelSobre(null), null);
});

// ---------------------------------------------------------------------------
// El reto
// ---------------------------------------------------------------------------

test("apagado por defecto: sin X402_ENABLED no se activa nada", () => {
  assert.equal(x402Activo({}), false);
  assert.equal(x402Activo({ X402_ENABLED: "false" }), false);
  assert.equal(x402Activo(ENV), true);
});

test("SIN DIRECCIÓN DE COBRO NO SE ANUNCIA PRECIO", () => {
  // Preferimos no ofrecer el pago a ofrecerlo mal. Un reto sin payTo pediria
  // dinero sin decir a donde.
  assert.equal(requisitosDePago({ ...ENV, X402_PAY_TO: "" }), null);
  assert.equal(requisitosDePago({ ...ENV, X402_ASSET: "" }), null);
  assert.equal(requisitosDePago({ ...ENV, X402_NETWORK: "" }), null);
  assert.equal(retoDePago({ ...ENV, X402_PAY_TO: "" }, { url: "https://x/y" }), null);
});

test("el reto lleva los campos exactos de la especificación v2", () => {
  const reto = retoDePago(ENV, { url: "https://api.example.com/v1/check" });
  assert.equal(reto.x402Version, X402_VERSION);
  assert.equal(reto.resource.url, "https://api.example.com/v1/check");
  assert.equal(reto.resource.mimeType, "application/json");
  const a = reto.accepts[0];
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:84532");   // CAIP-2, no "base-sepolia" (eso era v1)
  assert.equal(a.amount, "20000");
  assert.equal(a.asset, USDC_SEPOLIA);
  assert.equal(a.payTo, MI_DIRECCION);
  assert.equal(a.maxTimeoutSeconds, 60);
  assert.deepEqual(a.extra, { name: "USDC", version: "2" });
});

// ---------------------------------------------------------------------------
// LA COMPROBACIÓN QUE NO SE DELEGA
// ---------------------------------------------------------------------------

function firmaCon(aceptado) {
  return {
    headers: new Map([["PAYMENT-SIGNATURE", meterEnSobre({
      x402Version: 2,
      resource: { url: "https://api.example.com/v1/check" },
      accepted: aceptado,
      payload: {
        signature: "0x2d6a75...",
        authorization: {
          from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          to: aceptado.payTo, value: aceptado.amount,
          validAfter: "1740672089", validBefore: "1740672154", nonce: "0xf374",
        },
      },
    })]]),
  };
}
// El objeto Request real usa .get(); Map tambien. Sirve tal cual.
const req = (o) => ({ headers: { get: (k) => o.headers.get(k) || null } });

const BUENO = {
  scheme: "exact", network: RED.BASE_SEPOLIA, amount: "20000",
  asset: USDC_SEPOLIA, payTo: MI_DIRECCION, maxTimeoutSeconds: 60,
};

test("firma correcta: se acepta", () => {
  const r = leerFirmaDePago(req(firmaCon(BUENO)), ENV);
  assert.equal(r.ok, true);
  assert.equal(pagadorDe(r.pago), "0x857b06519E91e3A54538791bDbb0E22373e36b66");
});

test("EL ATAQUE QUE IMPORTA: el cliente rebaja la cantidad y firma eso", () => {
  // Su firma seria PERFECTA para 0,001 $. El facilitador la validaria: el
  // facilitador no sabe cuanto pedimos nosotros. Si no comparamos aqui, cobramos
  // veinte veces menos y todo parece correcto.
  const r = leerFirmaDePago(req(firmaCon({ ...BUENO, amount: "1000" })), ENV);
  assert.equal(r.ok, false);
  assert.match(r.error, /do not match/);
});

test("EL OTRO ATAQUE: el cliente cambia la dirección de cobro", () => {
  // Firma perfecta, pago real... a la cartera de otro. Nosotros entregariamos la
  // respuesta y no cobrariamos nada.
  const r = leerFirmaDePago(req(firmaCon({ ...BUENO, payTo: "0x0000000000000000000000000000000000000bad" })), ENV);
  assert.equal(r.ok, false);
});

test("y las otras tres puertas: moneda, red y esquema", () => {
  assert.equal(leerFirmaDePago(req(firmaCon({ ...BUENO, asset: "0xdead" })), ENV).ok, false);
  assert.equal(leerFirmaDePago(req(firmaCon({ ...BUENO, network: RED.BASE_MAINNET })), ENV).ok, false);
  assert.equal(leerFirmaDePago(req(firmaCon({ ...BUENO, scheme: "upto" })), ENV).ok, false);
});

test("la dirección se compara sin distinguir mayúsculas, la cantidad como TEXTO", () => {
  // Las direcciones EVM llevan mayusculas de checksum y llegan de las dos formas.
  assert.equal(aceptadoCoincide({ ...BUENO, payTo: MI_DIRECCION.toLowerCase() }, requisitosDePago(ENV)), true);
  // La cantidad NO: son unidades atomicas y pueden no caber en un numero seguro
  // de JavaScript, asi que se comparan como cadenas.
  assert.equal(aceptadoCoincide({ ...BUENO, amount: 20000 }, requisitosDePago(ENV)), true);
  assert.equal(aceptadoCoincide({ ...BUENO, amount: "020000" }, requisitosDePago(ENV)), false);
});

test("sin cabecera, con basura, o con versión vieja: se rechaza con motivo", () => {
  const vacio = { headers: { get: () => null } };
  assert.match(leerFirmaDePago(vacio, ENV).error, /required/);

  const basura = { headers: { get: () => "no-es-base64!!" } };
  assert.match(leerFirmaDePago(basura, ENV).error, /base64/);

  const v1 = { headers: { get: () => meterEnSobre({ x402Version: 1, accepted: BUENO, payload: {} }) } };
  assert.match(leerFirmaDePago(v1, ENV).error, /x402Version/);
});

// ---------------------------------------------------------------------------
// La liquidación
// ---------------------------------------------------------------------------

test("cabecera de liquidación: éxito y fracaso, con la forma de la especificación", () => {
  const ok = sacarDelSobre(cabeceraLiquidacion({
    success: true, transaction: "0xabc", network: RED.BASE_SEPOLIA, payer: "0x857b",
  }));
  assert.deepEqual(ok, { success: true, transaction: "0xabc", network: "eip155:84532", payer: "0x857b" });

  const mal = sacarDelSobre(cabeceraLiquidacion({
    success: false, errorReason: "insufficient_funds", network: RED.BASE_SEPOLIA, payer: "0x857b",
  }));
  assert.equal(mal.success, false);
  assert.equal(mal.errorReason, "insufficient_funds");
  assert.equal(mal.transaction, "");
});
