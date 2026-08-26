// W10 — la condición legal partida en dos frases.
//
// EL FALLO, MEDIDO: en las cinco pasadas del banco del 26 ago, C09_state_law_TRAP
// dio UNSAFE 5 de 5 — siempre YES_WITH_CONDITIONS donde tocaba UNKNOWN. No era
// ruido ni mala suerte: era un agujero fijo. Y no era un fallo de razonamiento,
// era de ALCANCE: la página parte la condición en dos frases y el modelo cita la
// segunda, que por sí sola parece limpia.
//
//   [1] "Returns of alcoholic beverages are not accepted where prohibited by law."
//   [2] "Where returns are permitted, unopened bottles may be returned within 30 days."
//
// El guard solo miraba la cita, así que con [2] no se disparaba nunca.
//
// Lo que estas pruebas vigilan no es solo que C09 pase: es que el arreglo NO se
// coma veredictos correctos. Un guard que se dispara de más cuesta cobertura —
// que es justo la métrica que peor tenemos— y eso no se ve en el número de
// aciertos, solo en el de UNKNOWN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clauseIsJurisdictionConditional } from "../src/text.mjs";
import { runCheck } from "../src/engine.mjs";

const POLIZA_C09 = "Alcohol Returns. Returns of alcoholic beverages are not accepted where prohibited by law. Where returns are permitted, unopened bottles may be returned within 30 days with receipt.";
const CITA_C09 = "Where returns are permitted, unopened bottles may be returned within 30 days with receipt.";

// ---------- el agujero exacto ----------

test("W10 EL FALLO: la cita permisiva sola no delataba nada", () => {
  // Comportamiento anterior, conservado tal cual: sin el texto de la página el
  // guard no puede saberlo, y no se inventa nada.
  assert.equal(clauseIsJurisdictionConditional(CITA_C09), false);
});

test("W10 EL ARREGLO: con el texto de la página delante, sí se detecta", () => {
  assert.equal(clauseIsJurisdictionConditional(CITA_C09, POLIZA_C09), true);
});

test("W10: la detección directa de siempre sigue funcionando igual", () => {
  // No podemos arreglar C09 rompiendo lo que ya cerraba C09 por la vía directa.
  for (const c of [
    "Returns of alcoholic beverages are not accepted where prohibited by law.",
    "Refunds vary by state.",
    "Returns are subject to state law.",
    "Restocking fees apply except where required by law.",
  ]) {
    assert.equal(clauseIsJurisdictionConditional(c), true, c);
    assert.equal(clauseIsJurisdictionConditional(c, POLIZA_C09), true, c);
  }
});

// ---------- que NO se dispare de más ----------

test("W10 EL MATIZ QUE IMPORTA: \"where permitted\" sobre PORTES no tumba el veredicto", () => {
  // Aquí la condición legal no afecta a si se puede devolver, sino a quién paga
  // el envío. Tumbar esto a UNKNOWN sería cambiar un fallo por otro más callado.
  const poliza = "Return Policy. All items may be returned within 30 days of purchase for a full refund. Where permitted, we offer free return shipping on orders over $50.";
  const cita = "Where permitted, we offer free return shipping on orders over $50.";
  assert.equal(clauseIsJurisdictionConditional(cita, poliza), false);
});

test("W10: la condición legal lejana, en otro párrafo, no contamina", () => {
  // Vecindad de ±1 frase, no la página entera: una cláusula de tarjetas regalo
  // al principio no puede invalidar una cita del final.
  const poliza = [
    "Gift cards are non-returnable except where required by law.",
    "Shipping is free on all domestic orders.",
    "Our warehouse operates Monday through Friday.",
    "Refunds are issued to the original payment method.",
    "Where returns are permitted, merchandise may be returned within 30 days.",
  ].join(" ");
  const cita = "Where returns are permitted, merchandise may be returned within 30 days.";
  assert.equal(clauseIsJurisdictionConditional(cita, poliza), false);
});

test("W10: una cita normal con la palabra \"permitted\" no es un condicional", () => {
  const poliza = "Return Policy. Returns are permitted within 30 days of delivery.";
  assert.equal(clauseIsJurisdictionConditional("Returns are permitted within 30 days of delivery.", poliza), false);
});

test("W10: entradas vacías o basura no revientan ni afirman nada", () => {
  assert.equal(clauseIsJurisdictionConditional(null, POLIZA_C09), false);
  assert.equal(clauseIsJurisdictionConditional("", POLIZA_C09), false);
  assert.equal(clauseIsJurisdictionConditional(CITA_C09, null), false);
  assert.equal(clauseIsJurisdictionConditional(CITA_C09, "texto que no contiene la cita"), false);
});

// ---------- el motor entero ----------

function envFalso(respuestaIA) {
  return {
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
                            run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) },
    AI: { run: async () => ({ response: JSON.stringify(respuestaIA) }) },
  };
}

const IA_C09 = {
  verdict: "YES_WITH_CONDITIONS", confidence: 0.9,
  answer_human: "Yes, unopened bottles may be returned within 30 days.",
  reason: null,
  merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
  policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, window_basis: "purchase_date",
            return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
  evidence: { source_url: "https://example.com/p/c09", clause_id: null, exact_clause: CITA_C09 },
};

const PETICION_C09 = {
  product_url: "https://example.com/p/c09",
  buyer_country: "US",
  item_condition: "unopened",
  reason: "changed_mind",
  page_text: POLIZA_C09,
};

test("motor C09: el falso sí de las cinco pasadas ya no sale", async () => {
  const r = await runCheck(envFalso(IA_C09), PETICION_C09);
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.reason, /state\/jurisdiction law/);
  assert.match(r.answer_human, /^Unknown\./);
});

test("motor C09: con el estado del comprador SÍ se puede responder", async () => {
  // El guard existe porque falta un dato, no porque el caso sea irresoluble.
  // Si el dato llega, el motor tiene que dejar de abstenerse — si no, habríamos
  // construido un "no lo sé" permanente y eso no se puede vender.
  const r = await runCheck(envFalso(IA_C09), { ...PETICION_C09, buyer_state: "CA" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
});

test("motor: una política sin condición legal sigue respondiendo con normalidad", async () => {
  // La contraprueba de cobertura: el mismo texto sin la frase de la ley.
  const poliza = "Return Policy. Unopened bottles may be returned within 30 days with receipt.";
  const cita = "Unopened bottles may be returned within 30 days with receipt.";
  const r = await runCheck(envFalso({ ...IA_C09, evidence: { ...IA_C09.evidence, exact_clause: cita } }),
                           { ...PETICION_C09, page_text: poliza });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.policy.merchant_return_days, 30);
});
