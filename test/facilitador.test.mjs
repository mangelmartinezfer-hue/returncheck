// W30 — el facilitador.
//
// Todo esto se prueba SIN RED: la llamada HTTP se inyecta. Así se pueden
// reproducir a voluntad los casos que en la vida real aparecen una vez cada mil y
// siempre en el peor momento — el facilitador caído, el que tarda, el que
// contesta basura, y el que dice que sí cuando debería decir que no.
//
// Las formas de /verify y /settle son las de la especificación v2, no inventadas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verificarPago, liquidarPago, veredictoCobrable } from "../src/facilitador.mjs";

const ENV = { X402_FACILITATOR: "https://facilitador.example", X402_TIMEOUT_MS: 500 };
const REQUISITOS = { scheme: "exact", network: "eip155:84532", amount: "20000",
                     asset: "0x036C", payTo: "0x2096" };
const PAGO = { x402Version: 2, accepted: REQUISITOS, payload: { signature: "0xsig" } };

// Un facilitador de mentira que contesta lo que le digamos.
function facilitadorQueDice(respuesta, { status = 200, tarda = 0, revienta = null } = {}) {
  const llamadas = [];
  const impl = async (url, opciones) => {
    llamadas.push({ url, cuerpo: JSON.parse(opciones.body) });
    if (revienta) { const e = new Error("boom"); e.name = revienta; throw e; }
    if (tarda) await new Promise((r) => setTimeout(r, tarda));
    return { ok: status >= 200 && status < 300, status, json: async () => respuesta };
  };
  return { impl, llamadas };
}

// ---------------------------------------------------------------------------
// Verificar: falla cerrado, sin excepciones
// ---------------------------------------------------------------------------

test("verificar: un pago bueno se acepta y devuelve quién paga", async () => {
  const f = facilitadorQueDice({ isValid: true, payer: "0x857b" });
  const r = await verificarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.valido, true);
  assert.equal(r.pagador, "0x857b");
  // Y se llama a la ruta correcta con la forma que pide la especificacion.
  assert.match(f.llamadas[0].url, /\/verify$/);
  assert.equal(f.llamadas[0].cuerpo.x402Version, 2);
  assert.ok(f.llamadas[0].cuerpo.paymentPayload);
  assert.ok(f.llamadas[0].cuerpo.paymentRequirements);
});

test("verificar: un pago malo se rechaza con su motivo", async () => {
  const f = facilitadorQueDice({ isValid: false, invalidReason: "insufficient_funds", payer: "0x857b" });
  const r = await verificarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.valido, false);
  assert.equal(r.motivo, "insufficient_funds");
});

test("FALLA CERRADO: si el facilitador NO CONTESTA, no se sirve nada", async () => {
  // Si esto devolviera "valido", bastaria con tumbar al facilitador para tener
  // respuestas gratis. Un error de red no puede ser un descuento del 100%.
  const f = facilitadorQueDice(null, { revienta: "TypeError" });
  const r = await verificarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.valido, false);
  assert.equal(r.motivo, "facilitator_unreachable");
});

test("FALLA CERRADO: si TARDA demasiado, tampoco", async () => {
  const f = facilitadorQueDice(null, { revienta: "TimeoutError" });
  const r = await verificarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.valido, false);
  assert.equal(r.motivo, "facilitator_timeout");
});

test("FALLA CERRADO: un 500 del facilitador no es una respuesta, es una ausencia", async () => {
  const f = facilitadorQueDice({ isValid: true }, { status: 500 });
  const r = await verificarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.valido, false);
  assert.match(r.motivo, /facilitator_http_500/);
});

test("FALLA CERRADO: sin isValid EXPLICITO no hay beneficio de la duda", async () => {
  // Nada de tratar "ausente" o "casi" como valido. Solo true vale.
  for (const raro of [{}, { isValid: "true" }, { isValid: 1 }, { valid: true }, { isValid: null }]) {
    const f = facilitadorQueDice(raro);
    const r = await verificarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
    assert.equal(r.valido, false, JSON.stringify(raro));
  }
});

test("FALLA CERRADO: sin facilitador configurado, no se cobra ni se sirve", async () => {
  const r = await verificarPago({}, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: async () => { throw new Error("no deberia llamarse"); } });
  assert.equal(r.valido, false);
  assert.equal(r.motivo, "no_facilitator_configured");
});

// ---------------------------------------------------------------------------
// Liquidar
// ---------------------------------------------------------------------------

test("liquidar: cobro correcto devuelve la transacción", async () => {
  const f = facilitadorQueDice({ success: true, transaction: "0xabc", network: "eip155:84532", payer: "0x857b" });
  const r = await liquidarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.cobrado, true);
  assert.equal(r.transaccion, "0xabc");
  assert.match(f.llamadas[0].url, /\/settle$/);
});

test("liquidar: si falla, NO se sirve — y el motivo queda", async () => {
  // Duele: el trabajo ya esta hecho y pagado por nosotros. Pero servir igualmente
  // convierte "haz que falle la liquidacion" en la forma de tener respuestas
  // gratis. Se pierde el coste del modelo UNA vez; la alternativa es perderlo
  // SIEMPRE.
  const f = facilitadorQueDice({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
  const r = await liquidarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.cobrado, false);
  assert.equal(r.pendiente, false);
  assert.equal(r.motivo, "insufficient_funds");
});

test("LA EXCEPCIÓN: cadena lenta pero transacción lanzada -> SÍ se sirve", async () => {
  // El comprador ha pagado; que la cadena tarde en confirmar no es culpa suya.
  // Dejarle sin respuesta por eso seria castigar al cliente por un problema
  // nuestro. Se sirve y se anota como pendiente para conciliar.
  const f = facilitadorQueDice({ success: false, errorReason: "settlement_pending", transaction: "0xdef", network: "eip155:84532" });
  const r = await liquidarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.cobrado, false);
  assert.equal(r.pendiente, true);
  assert.equal(r.transaccion, "0xdef");
});

test("y un 'pendiente' SIN transacción no es pendiente: es un fallo", async () => {
  // Sin hash no hay nada que conciliar despues. Eso no es lentitud, es un fallo
  // con nombre bonito.
  const f = facilitadorQueDice({ success: false, errorReason: "settlement_pending", transaction: "" });
  const r = await liquidarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.pendiente, false);
  assert.equal(r.cobrado, false);
});

test("liquidar: si el facilitador se cae DESPUÉS de trabajar, no se cobra", async () => {
  const f = facilitadorQueDice(null, { revienta: "TimeoutError" });
  const r = await liquidarPago(ENV, { pago: PAGO, requisitos: REQUISITOS }, { fetchImpl: f.impl });
  assert.equal(r.cobrado, false);
  assert.equal(r.motivo, "facilitator_timeout");
});

// ---------------------------------------------------------------------------
// La regla del 22 de agosto
// ---------------------------------------------------------------------------

test("UNKNOWN NO SE COBRA — la decisión de Miguel, en una línea", async () => {
  // Con x402 sale redondo: el comprador firmo la autorizacion, pero si el
  // veredicto es UNKNOWN simplemente no llamamos a liquidar y esa firma caduca sin
  // usarse. No hay que devolver nada porque no se movio nada.
  assert.equal(veredictoCobrable("UNKNOWN"), false);
  assert.equal(veredictoCobrable("YES"), true);
  assert.equal(veredictoCobrable("YES_WITH_CONDITIONS"), true);
  assert.equal(veredictoCobrable("NO"), true);
});

test("y el interruptor para cambiar de idea sin desplegar", async () => {
  assert.equal(veredictoCobrable("UNKNOWN", { CHARGE_ON_UNKNOWN: "true" }), true);
});
