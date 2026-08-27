// W24 — abstenerse cuando la política no es la del comprador.
//
// Estas dos trampas son del holdout, que escribió el equipo de ChatGPT. Los
// textos son los suyos, sin tocar. Son las dos únicas donde el motor AFIRMABA
// donde tocaba callar — la peor clase de error de este producto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { policyScopedToOtherCountry, policyDefersToSeller } from "../src/text.mjs";

const RC25_13 = "Canada Return Policy. Orders delivered to Canadian addresses may be returned within 30 days of delivery. Refunds are issued in Canadian dollars. This policy applies only to purchases made on our Canadian storefront.";
const RC25_16 = "Items sold directly by Central Marketplace may be returned within 30 days of delivery. This policy does not apply to independent marketplace sellers, whose return terms appear on the seller profile.";
const RC25_04 = "Products sold and shipped by MarketHub may be returned within 30 days of delivery. Products sold by marketplace partners are governed by the individual seller's return policy.";

// ---------- RC25-13: la política de otro país ----------

test("RC25-13: política declarada exclusiva de Canadá y comprador de EEUU -> nos callamos", () => {
  // El texto dice 30 días con todas las letras y es perfectamente válido. Por eso
  // el motor lo leía y respondía que sí. Pero no es SU política: responder aquí no
  // es un error de lectura, es contestar la pregunta de otro.
  const r = policyScopedToOtherCountry(RC25_13, "US");
  assert.ok(r);
  assert.match(r, /applies only to/);
});

test("RC25-13 LA CONTRAPRUEBA: si el comprador SÍ es de ese país, se responde con normalidad", () => {
  // Un guardián que se lo traga todo no es seguridad, es un producto roto.
  assert.equal(policyScopedToOtherCountry(RC25_13, "CA"), null);
});

test("EL LÍMITE: MENCIONAR un país no es limitarse a él", () => {
  // Hace falta una marca de exclusividad explícita en la MISMA frase. Sin esto
  // abstendríamos cada política que hable de aduanas o de envíos al extranjero.
  assert.equal(policyScopedToOtherCountry(
    "Orders shipped to Canada may incur customs fees. Returns are accepted within 30 days.", "US"), null);
  assert.equal(policyScopedToOtherCountry(
    "We ship to the United Kingdom, Canada and Australia. Items may be returned within 30 days.", "US"), null);
});

test("si mandan país del comprador, no se puede comparar y no se dispara", () => {
  assert.equal(policyScopedToOtherCountry(RC25_13, null), null);
  assert.equal(policyScopedToOtherCountry(null, "US"), null);
});

test("una frase con ámbito que SÍ incluye al comprador manda sobre otra que no", () => {
  const dos = "This policy applies only to customers in Canada. Free shipping is available only in the United States.";
  assert.equal(policyScopedToOtherCountry(dos, "US"), null);
});

// ---------- RC25-16: la política que se excluye a sí misma ----------

test("RC25-16: 'this policy DOES NOT APPLY to marketplace sellers' -> es una remisión", () => {
  // La forma que se nos escapaba: en vez de remitir a otra política, la política
  // se excluye a sí misma. Y dice "return TERMS", no "return policy".
  assert.equal(policyDefersToSeller(RC25_16), true);
});

test("RC25-04 sigue detectándose: no hemos roto la forma que ya funcionaba", () => {
  assert.equal(policyDefersToSeller(RC25_04), true);
});

test("una política normal de marketplace NO dispara la remisión", () => {
  // Si esto fallara, convertiríamos en UNKNOWN cada tienda que venda por su cuenta.
  assert.equal(policyDefersToSeller(
    "Items may be returned within 30 days of delivery for a full refund to the original payment method."), false);
});
