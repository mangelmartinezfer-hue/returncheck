// W12 — cuando la respuesta estaba dos frases más arriba.
//
// MEDIDO, no supuesto: en la pasada de W11 del 26 ago, C11_software_opened_NO era
// el ÚNICO safe_miss del banco (safe_misses = 1), y la firma del guard dijo por
// qué: `opened_item_unverified`, con la cita rechazada siendo la frase de los
// artículos SIN ABRIR. Su política solo produce dos frases candidatas, el artículo
// es abierto, y la que resuelve el caso es la otra.
//
// Nos estábamos absteniendo con la respuesta escrita en la misma página.
//
// El riesgo de este cambio es el que importa: convertir un UNKNOWN en un veredicto
// determinado es LO ÚNICO que puede fabricar un error peligroso. Por eso la mitad
// de estas pruebas no comprueban que C11 pase, sino que el resto NO se rompa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionExclusionClause } from "../src/text.mjs";
import { runCheck } from "../src/engine.mjs";

const POLIZA_C11 = "Software & Digital. Opened software, digital downloads and activated license keys cannot be returned or refunded once the seal is broken or the code has been revealed. Unopened physical software may be returned within 15 days.";
const CITA_MALA = "Unopened physical software may be returned within 15 days.";
const CITA_BUENA = "Opened software, digital downloads and activated license keys cannot be returned or refunded once the seal is broken or the code has been revealed.";

// ---------- la extracción ----------

test("W12: encuentra la frase que excluye la condición del artículo", () => {
  assert.equal(conditionExclusionClause(POLIZA_C11, "opened"), CITA_BUENA);
});

test("W12 EL MATIZ QUE IMPORTA: \"Unopened ... may be returned\" NO es una exclusión", () => {
  // Si esto fallara, un permiso se leería como una prohibición y firmaríamos un
  // NO falso. Es el fallo más caro que puede tener este cambio.
  const poliza = "Return Policy. Unopened items may be returned within 30 days. Refunds go to the original payment method.";
  assert.equal(conditionExclusionClause(poliza, "opened"), null);
});

test("W12: una frase que nombra la condición pero no niega nada no cuenta", () => {
  const poliza = "Return Policy. Opened items must be returned in their original packaging with all accessories included.";
  assert.equal(conditionExclusionClause(poliza, "opened"), null);
});

test("W12: una prohibición que no nombra la condición tampoco cuenta", () => {
  // "Final sale items cannot be returned" no dice nada sobre estar abierto.
  const poliza = "Return Policy. Final sale items cannot be returned. All other merchandise may be returned within 30 days.";
  assert.equal(conditionExclusionClause(poliza, "opened"), null);
});

test("W12: solo aplica a artículos abiertos o usados", () => {
  assert.equal(conditionExclusionClause(POLIZA_C11, "unopened"), null);
  assert.equal(conditionExclusionClause(POLIZA_C11, undefined), null);
  assert.equal(conditionExclusionClause(null, "opened"), null);
});

// ---------- el motor ----------

const DB_FALSA = { prepare: () => ({
  bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
  run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };
const envFalso = (ia) => ({ DB: DB_FALSA, AI: { run: async () => ({ response: JSON.stringify(ia) }) } });

const IA_CITANDO_MAL = {
  verdict: "YES_WITH_CONDITIONS", confidence: 0.9,
  answer_human: "Yes, returnable within 15 days.", reason: null,
  merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
  policy: { return_category: "FiniteReturnWindow", merchant_return_days: 15, window_basis: "purchase_date",
            return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
  evidence: { source_url: "https://example.com/p/c11", clause_id: null, exact_clause: CITA_MALA },
};

const PETICION = {
  product_url: "https://example.com/p/c11", buyer_country: "US",
  item_condition: "opened", reason: "changed_mind", page_text: POLIZA_C11,
};

test("motor C11: el único safe_miss del banco pasa a NO, con la cita correcta", async () => {
  const r = await runCheck(envFalso(IA_CITANDO_MAL), PETICION);
  assert.equal(r.verdict, "NO");
  assert.equal(r.returnable, false);
  assert.equal(r.evidence.exact_clause, CITA_BUENA);
  assert.equal(r.policy.return_category, "NotPermitted");
  // El plazo de 15 días que dijo el modelo era de la OTRA frase: no puede sobrevivir.
  assert.equal(r.policy.merchant_return_days, null);
  assert.equal(r.meta.guard.name, "opened_item_excluded");
  assert.equal(r.meta.guard.rejected_clause, CITA_MALA);
  assert.match(r.answer_human, /^No\./);
});

test("motor: sin frase de exclusión se sigue abstiniendo, como antes", async () => {
  // La contraprueba. Si esto fallara, W12 no sería un arreglo: sería una puerta
  // por la que se cuela un NO cada vez que el artículo viene abierto.
  const poliza = "Return Policy. Unopened items may be returned within 15 days of purchase. Refunds go to the original payment method.";
  const cita = "Unopened items may be returned within 15 days of purchase.";
  const r = await runCheck(envFalso({ ...IA_CITANDO_MAL,
    evidence: { source_url: "https://example.com/p/x", clause_id: null, exact_clause: cita } }),
    { ...PETICION, product_url: "https://example.com/p/x", page_text: poliza });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard.name, "opened_item_unverified");
});

test("motor: un artículo SIN ABRIR con la misma política sigue siendo devolvible", async () => {
  // El guard entero solo existe para artículos abiertos. Si W12 tocara este caso,
  // habríamos convertido una política normal en un no permanente.
  const r = await runCheck(envFalso(IA_CITANDO_MAL), { ...PETICION, item_condition: "unopened" });
  // W23 — a esta prueba le da igual el SABOR del positivo: lo que vigila es
  // otra cosa. Se comprueba que el veredicto sea positivo, para que un cambio
  // de taxonomia no la rompa por algo de lo que no trata.
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(r.verdict), r.verdict);
  assert.equal(r.policy.merchant_return_days, 15);
});

test("motor: si el modelo YA cita bien, W12 no se mete", async () => {
  const r = await runCheck(envFalso({ ...IA_CITANDO_MAL,
    verdict: "NO", answer_human: "No. Opened software cannot be returned.",
    policy: { return_category: "NotPermitted", merchant_return_days: null, window_basis: null,
              return_method: [], return_fees: null, refund_type: null },
    evidence: { source_url: PETICION.product_url, clause_id: null, exact_clause: CITA_BUENA } }), PETICION);
  assert.equal(r.verdict, "NO");
  assert.equal(r.meta.guard, undefined);
  assert.equal(r.evidence.exact_clause, CITA_BUENA);
});
