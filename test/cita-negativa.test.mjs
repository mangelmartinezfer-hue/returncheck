// W13 — un "no" apoyado en una exclusión que habla de otro artículo.
//
// ENCONTRADO EN EL HOLDOUT, no en nuestro banco. RC25-17, 26 ago: cepillo
// eléctrico SIN ABRIR, dentro de plazo. En dos de cinco pasadas el motor firmó
// NO citando «Opened hygiene products are not eligible for return.»
//
// La cita existe. Niega devoluciones de verdad. `clauseSupportsVerdict` la da por
// buena — y hace bien, porque es exactamente lo que ese guard comprueba. Lo que
// nadie miraba es que la frase habla de artículos ABIERTOS y este no lo está.
//
// C15 cubre el caso contrario: una frase de «sin abrir» usada para justificar un
// artículo abierto. Este es su espejo, y llevaba abierto desde el principio.
// El banco propio no podía verlo: no tiene ningún caso de esta forma.
//
// AVISO SOBRE LO QUE ESTO ARREGLA Y LO QUE NO: RC25-17 esperaba devolvible.
// W13 no lo convierte en acierto — lo convierte en UNKNOWN. Quita un error
// peligroso y deja un "no lo sé". Es honesto, no es una victoria de cobertura.
import { test } from "node:test";
import assert from "node:assert/strict";
import { negativeClauseWrongCondition, clauseSupportsVerdict } from "../src/text.mjs";
import { runCheck } from "../src/engine.mjs";

const POLIZA = "For hygiene reasons, electric toothbrushes may be returned within 14 calendar days after delivery only when the retail seal is unbroken. Opened hygiene products are not eligible for return.";
const CITA = "Opened hygiene products are not eligible for return.";

test("W13 EL PUNTO DE PARTIDA: el guard de siempre acepta la cita, y hace bien", () => {
  // Si esto fuera false, el fallo se habría cazado solo y W13 no haría falta.
  // Que sea true es justo por lo que el agujero existía.
  assert.equal(clauseSupportsVerdict(CITA, { verdict: "NO", days: null, category: "NotPermitted", policyText: POLIZA }), true);
});

test("W13 EL FALLO: la exclusión es de artículos abiertos y este viene sin abrir", () => {
  assert.equal(negativeClauseWrongCondition(CITA, "unopened"), true);
});

test("W13: si el artículo SÍ está abierto, la exclusión aplica y no se toca", () => {
  assert.equal(negativeClauseWrongCondition(CITA, "opened"), false);
  assert.equal(negativeClauseWrongCondition(CITA, "used"), false);
});

test("W13 EL MATIZ QUE IMPORTA: una frase que cubre AMBAS condiciones sí aplica", () => {
  // «Opened or unopened, final sale items cannot be returned» habla también de
  // lo sellado. Tumbar ese NO sería cambiar un fallo por otro.
  assert.equal(negativeClauseWrongCondition("Opened or unopened, final sale items cannot be returned.", "unopened"), false);
  assert.equal(negativeClauseWrongCondition("Whether sealed or opened, these items are non-returnable.", "unopened"), false);
});

test("W13: una prohibición por CATEGORÍA, sin condición, no se toca", () => {
  // El guard es sobre la condición del artículo, no sobre qué es el artículo.
  assert.equal(negativeClauseWrongCondition("Final sale items cannot be returned.", "unopened"), false);
  assert.equal(negativeClauseWrongCondition("Gift cards are non-returnable.", "unopened"), false);
});

test("W13: una frase que nombra \"opened\" pero PERMITE devolver no es una exclusión", () => {
  assert.equal(negativeClauseWrongCondition("Opened software may be returned within 30 days.", "unopened"), false);
});

test("W13: otras redacciones del mismo fallo también entran", () => {
  assert.equal(negativeClauseWrongCondition("Items with a broken seal cannot be returned.", "unopened"), true);
  assert.equal(negativeClauseWrongCondition("Used merchandise is non-returnable.", "new"), true);
});

test("W13: entradas vacías no afirman nada", () => {
  assert.equal(negativeClauseWrongCondition(null, "unopened"), false);
  assert.equal(negativeClauseWrongCondition(CITA, undefined), false);
  assert.equal(negativeClauseWrongCondition(CITA, "defective"), false);
});

// ---------- el motor ----------

const DB_FALSA = { prepare: () => ({
  bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
  run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };
const envFalso = (ia) => ({ DB: DB_FALSA, AI: { run: async () => ({ response: JSON.stringify(ia) }) } });

const IA_NO = {
  verdict: "NO", confidence: 0.9,
  answer_human: "No. Hygiene products cannot be returned.", reason: null,
  merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
  policy: { return_category: "NotPermitted", merchant_return_days: null, window_basis: null,
            return_method: [], return_fees: null, refund_type: null },
  evidence: { source_url: "https://example.com/p/rc17", clause_id: null, exact_clause: CITA },
};
const PETICION = {
  product_url: "https://example.com/p/rc17", buyer_country: "US",
  item_condition: "unopened", reason: "changed_mind",
  purchase_date: "2026-08-10", delivery_date: "2026-08-12", as_of: "2026-08-20",
  page_text: POLIZA,
};

test("motor RC25-17: el falso NO deja de salir, y queda un UNKNOWN honesto", async () => {
  const r = await runCheck(envFalso(IA_NO), PETICION);
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard.name, "negative_clause_wrong_condition");
  assert.equal(r.meta.guard.rejected_clause, CITA);
  assert.match(r.answer_human, /^Unknown\./);
});

test("motor: el mismo caso con el artículo ABIERTO sigue siendo NO", async () => {
  // La contraprueba de que no hemos desarmado el guard entero.
  const r = await runCheck(envFalso(IA_NO), { ...PETICION, item_condition: "opened" });
  assert.equal(r.verdict, "NO");
  assert.equal(r.meta.guard, undefined);
});

test("motor: un NO por categoría sobre un artículo sin abrir sigue siendo NO", async () => {
  const poliza = "Clearance Policy. Final sale items cannot be returned or exchanged for any reason.";
  const cita = "Final sale items cannot be returned or exchanged for any reason.";
  const r = await runCheck(envFalso({ ...IA_NO,
    evidence: { source_url: PETICION.product_url, clause_id: null, exact_clause: cita } }),
    { ...PETICION, page_text: poliza });
  assert.equal(r.verdict, "NO");
  assert.equal(r.meta.guard, undefined);
});
