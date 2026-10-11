// W52 — LA CITA QUE PUBLICAMOS TIENE QUE SER DEL COMERCIO, ENTERA.
//
// EL DEFECTO (informe 242): `clauseInText` daba por buena una cita si 40
// caracteres seguidos aparecían en la página. Una cita de 300 caracteres podía
// llevar 260 inventados por el modelo y pasar el guarda — y `exact_clause` se
// publica al cliente como palabras literales del comercio. Un cliente que
// auditara una de esas citas contra la página no la encontraría.
//
// EL ARREGLO, en dos piezas:
//   · `clauseInText` es estricto: la cita tiene que estar ÍNTEGRA.
//   · `verbatimClause` recupera la frase LITERAL de la página a la que el modelo
//     apuntaba. El modelo dice dónde mirar; la página dice qué se publica.
//
// Lo único que se normaliza son diferencias que no cambian el significado ni
// añaden palabras: mayúsculas, comillas, guiones y espacios.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clauseInText, verbatimClause } from "../src/text.mjs";
import { runCheck } from "../src/engine.mjs";

const POLIZA =
  "Return Policy. " +
  "Items may be returned within 30 days of delivery for a full refund, provided they are unused and in their original packaging. " +
  "Personalised and engraved items are final sale and cannot be returned. " +
  "Shipping costs are not refundable.";

const LITERAL_30 =
  "Items may be returned within 30 days of delivery for a full refund, provided they are unused and in their original packaging.";

// ---------- 1. Cita completamente correcta ----------

test("1. cita íntegra de la página -> aceptada", () => {
  assert.equal(clauseInText(LITERAL_30, POLIZA), true);
  // Y si se pide la frase de la fuente, es ella misma.
  assert.equal(verbatimClause(LITERAL_30, POLIZA), LITERAL_30);
});

// ---------- 2. Cita totalmente inventada ----------

test("2. cita totalmente inventada -> rechazada y sin ancla", () => {
  const inventada = "Customers enjoy a lifetime guarantee and may return any product at any time for any reason.";
  assert.equal(clauseInText(inventada, POLIZA), false);
  assert.equal(verbatimClause(inventada, POLIZA), null);
});

// ---------- 3. 300 caracteres con solo 40 auténticos (EL DEFECTO) ----------

test("3. 300 caracteres con solo 40 auténticos -> rechazada (antes pasaba)", () => {
  const autentico = "Items may be returned within 30 days of ";   // 40 chars, literales
  assert.equal(autentico.length, 40);
  const inventado =
    "delivery and also after that period at the sole discretion of our customer service team, " +
    "who may issue a full refund, a replacement or store credit, including for personalised " +
    "items, with no restocking fee and with return shipping always paid by the merchant in every case.";
  const cita = autentico + inventado;
  assert.ok(cita.length > 300, "la cita de prueba debe pasar de 300 caracteres");

  // EL GUARDA: la cita no está íntegra en la página.
  assert.equal(clauseInText(cita, POLIZA), false);

  // El anclaje sí la localiza, pero lo que devuelve es la frase DE LA PÁGINA,
  // no los 260 caracteres inventados.
  const recuperada = verbatimClause(cita, POLIZA);
  assert.equal(recuperada, LITERAL_30);
  assert.ok(!recuperada.includes("sole discretion"), "no puede colarse texto del modelo");
  assert.ok(!recuperada.includes("store credit"), "no puede colarse texto del modelo");
});

// ---------- 4. Cita auténtica seguida de frase inventada ----------

test("4. cita auténtica + coletilla inventada -> rechazada; se publica solo lo auténtico", () => {
  const cita = LITERAL_30 + " No questions asked, and we always pay return shipping.";
  assert.equal(clauseInText(cita, POLIZA), false);
  assert.equal(verbatimClause(cita, POLIZA), LITERAL_30);
});

// ---------- 5. Diferencias de espacios y saltos de línea ----------

test("5. mismos caracteres con otros espacios/saltos/comillas -> aceptada", () => {
  const conEspacios = "  Items may be returned   within 30 days\nof delivery for a full refund,\tprovided they are unused and in their original packaging. ";
  assert.equal(clauseInText(conEspacios, POLIZA), true);

  // Mayúsculas y comillas tipográficas tampoco deben romperla.
  assert.equal(clauseInText('“ITEMS MAY BE RETURNED WITHIN 30 DAYS OF DELIVERY”', POLIZA), true);

  // Guion tipográfico frente a guion normal: misma frase, no se pierde.
  const pagina = "Returns are accepted within 30-45 days of delivery.";
  assert.equal(clauseInText("returns are accepted within 30‑45 days of delivery.", pagina), true);
});

// ---------- 6. Cambios de palabra que alteran el significado ----------

test("6. cambios de palabra que alteran el significado -> rechazada", () => {
  // 30 -> 90: el número es el dato que vendemos.
  assert.equal(clauseInText(LITERAL_30.replace("30 days", "90 days"), POLIZA), false);
  // Se invierte el sentido.
  assert.equal(clauseInText(LITERAL_30.replace("may be returned", "may not be returned"), POLIZA), false);
  // Se afloja una condición.
  assert.equal(clauseInText(LITERAL_30.replace("provided they are unused", "even if used"), POLIZA), false);
  // "delivery" -> "purchase": cambia el ancla temporal.
  assert.equal(clauseInText(LITERAL_30.replace("of delivery", "of purchase"), POLIZA), false);
});

// ---------- 7. El motor degrada a UNKNOWN si la evidencia no es válida ----------

const DB_FALSA = { prepare: () => ({
  bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
  run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };

const envFalso = (ia) => ({ DB: DB_FALSA, AI: { run: async () => ({ response: JSON.stringify(ia) }) } });

const respuestaIA = (exact_clause) => ({
  verdict: "YES_WITH_CONDITIONS", confidence: 0.9,
  answer_human: "Yes, returnable within 30 days under the merchant's policy.",
  reason: null,
  merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
  policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, window_basis: "delivery_date",
            return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
  evidence: { source_url: "https://example.com/p/x", clause_id: null, exact_clause },
});

const pedir = (ia) => runCheck(envFalso(ia), {
  product_url: "https://example.com/p/x", buyer_country: "US", page_text: POLIZA,
});

test("7a. cita inventada sin ancla en la página -> UNKNOWN, sin evidencia", async () => {
  const r = await pedir(respuestaIA("Customers may return any product at any time, no conditions apply."));
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.evidence, null);
  assert.equal(r.policy, null);
  assert.equal(r.returnable, null);
  assert.ok(r.reason, "un UNKNOWN tiene que decir por qué");
});

test("7b. cita medio inventada -> se publica la frase literal de la página, no la del modelo", async () => {
  const cita = LITERAL_30 + " No questions asked, and we always pay return shipping.";
  const r = await pedir(respuestaIA(cita));

  // No se tira el caso: la página lo respalda.
  assert.notEqual(r.verdict, "UNKNOWN");
  // Y lo publicado es del comercio, entero y verificable contra la fuente.
  assert.equal(r.evidence.exact_clause, LITERAL_30);
  assert.equal(clauseInText(r.evidence.exact_clause, POLIZA), true);
  assert.ok(!r.evidence.exact_clause.includes("No questions asked"));
  // Queda rastro de que hubo sustitución, para poder auditarlo.
  assert.equal(r.meta.clause_anchored_to_source, true);
  assert.ok(r.meta.clause_model_rejected.includes("No questions asked"));
});

test("7c. lo que se publica siempre se puede volver a verificar contra la fuente", async () => {
  for (const cita of [LITERAL_30, LITERAL_30 + " Extra inventado.", "  items may be returned   within 30 days of delivery for a full refund, provided they are unused and in their original packaging."]) {
    const r = await pedir(respuestaIA(cita));
    if (r.verdict !== "UNKNOWN") {
      assert.equal(clauseInText(r.evidence.exact_clause, POLIZA), true,
        "toda cita publicada debe estar íntegra en la página: " + r.evidence.exact_clause);
    }
  }
});
