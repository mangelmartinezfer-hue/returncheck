// W11 — que el diagnóstico no mienta.
//
// LO QUE PASÓ, y por eso existe este fichero: el 26 ago, tras arreglar C09, las
// cinco pasadas del banco lo daban como UNKNOWN con `unknown_reason: "model
// returned UNKNOWN"`. De ahí se dedujo —razonablemente— que el guard nuevo no
// había actuado y que el arreglo no servía. Era falso: `/eval` solo sabía mirar
// `meta.degrade`, que lo pone UNO de los cuatro caminos, y etiquetaba los otros
// tres como abstención del modelo. La etiqueta afirmaba lo que no sabía.
//
// Costó una llamada de pago averiguar la verdad, y estuvo a punto de costar una
// decisión: buscar el arreglo donde no estaba el problema.
//
// Un motor cuya gracia es decir "no lo sé" cuando no lo sabe tiene que poder
// decir TAMBIÉN por qué no lo sabe. Estas pruebas fijan los cuatro caminos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "../src/engine.mjs";

const DB_FALSA = { prepare: () => ({
  bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
  run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };

const envFalso = (ia) => ({ DB: DB_FALSA, AI: { run: async () => ({ response: JSON.stringify(ia) }) } });

const base = (over = {}) => ({
  verdict: "YES_WITH_CONDITIONS", confidence: 0.9,
  answer_human: "Yes, returnable within 30 days under the merchant's policy.",
  reason: null,
  merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
  policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, window_basis: "purchase_date",
            return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
  ...over,
});

// ---------- camino 1: la cita no sostiene el veredicto ----------

test("W11: cita que no sostiene el veredicto -> guard \"clause_unsupported\"", async () => {
  const poliza = "Return Policy. Items may be returned within 30 days of purchase.";
  const r = await runCheck(envFalso(base({
    evidence: { source_url: "https://example.com/p/x", clause_id: null,
                exact_clause: "Free shipping on all domestic orders over $50." },
  })), { product_url: "https://example.com/p/x", buyer_country: "US", page_text: poliza });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard.name, "clause_unsupported");
  assert.equal(r.meta.guard.rejected_clause, "Free shipping on all domestic orders over $50.");
  assert.ok(r.meta.degrade, "el diagnóstico anterior se conserva, no se sustituye");
});

// ---------- camino 2: vendedor tercero ----------

test("W11: vendedor tercero con política propia -> guard \"third_party_seller\"", async () => {
  const poliza = "Marketplace. Items sold by third-party sellers are subject to each seller's own return policy. Our own items may be returned within 30 days.";
  const r = await runCheck(envFalso(base({
    evidence: { source_url: "https://example.com/p/x", clause_id: null,
                exact_clause: "Our own items may be returned within 30 days." },
  })), { product_url: "https://example.com/p/x", buyer_country: "US",
         seller_name: "Tienda Ajena SL", page_text: poliza });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard.name, "third_party_seller");
});

// ---------- camino 3: condición de jurisdicción (el de C09) ----------

test("W11 EL CASO QUE LO MOTIVA: C09 deja firma, ya no parece abstención del modelo", async () => {
  const poliza = "Alcohol Returns. Returns of alcoholic beverages are not accepted where prohibited by law. Where returns are permitted, unopened bottles may be returned within 30 days with receipt.";
  const cita = "Where returns are permitted, unopened bottles may be returned within 30 days with receipt.";
  const r = await runCheck(envFalso(base({
    evidence: { source_url: "https://example.com/p/c09", clause_id: null, exact_clause: cita },
  })), { product_url: "https://example.com/p/c09", buyer_country: "US",
         item_condition: "unopened", page_text: poliza });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard.name, "jurisdiction_conditional");
  // La cita rechazada se guarda: sin ella no se puede distinguir "el modelo no
  // contesta" de "el modelo contesta citando la frase equivocada", que son dos
  // arreglos completamente distintos.
  assert.equal(r.meta.guard.rejected_clause, cita);
});

// ---------- camino 4: item abierto con cita de "sin abrir" ----------

test("W11: item abierto y cita de \"unopened\" -> guard \"opened_item_unverified\"", async () => {
  // Es la hipótesis viva sobre C11: el modelo citaría la frase permisiva de los
  // artículos sin abrir para un artículo abierto. Con la firma se confirma o se
  // descarta de un vistazo, sin gastar una llamada.
  //
  // La política de aquí NO excluye la condición en ninguna otra frase: por eso
  // abstenerse sigue siendo lo correcto. Cuando sí la excluye, el veredicto pasa
  // a ser NO — eso es W12, y vive en su propio fichero.
  const poliza = "Return Policy. Unopened items may be returned within 15 days of purchase with the original receipt. Refunds go to the original payment method.";
  const cita = "Unopened items may be returned within 15 days of purchase with the original receipt.";
  const r = await runCheck(envFalso(base({
    policy: { return_category: "FiniteReturnWindow", merchant_return_days: 15, window_basis: "purchase_date",
              return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
    evidence: { source_url: "https://example.com/p/c11", clause_id: null, exact_clause: cita },
  })), { product_url: "https://example.com/p/c11", buyer_country: "US",
         item_condition: "opened", page_text: poliza });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard.name, "opened_item_unverified");
  assert.equal(r.meta.guard.rejected_clause, cita);
});

// ---------- camino 5: el modelo se abstiene de verdad ----------

test("W11 LO QUE MÁS IMPORTA: si se abstiene el modelo, NO se le cuelga un guard", async () => {
  // Si esto fallara habríamos cambiado una mentira por otra, y encima en la
  // dirección contraria: creeríamos que sobran guards cuando falta capacidad.
  const poliza = "Help Center. Our team is available 24/7 and we offer gift wrapping at checkout.";
  const r = await runCheck(envFalso({
    verdict: "UNKNOWN", confidence: 0, answer_human: "Unknown. The published policy does not resolve this specific case.",
    reason: null,
    merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
    policy: null, evidence: null,
  }), { product_url: "https://example.com/p/x", buyer_country: "US", page_text: poliza });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.meta.guard, undefined);
});

test("W11: una respuesta buena no lleva guard ninguno", async () => {
  const poliza = "Return Policy. Items may be returned within 30 days of purchase for a full refund.";
  const r = await runCheck(envFalso(base({
    evidence: { source_url: "https://example.com/p/x", clause_id: null,
                exact_clause: "Items may be returned within 30 days of purchase for a full refund." },
  })), { product_url: "https://example.com/p/x", buyer_country: "US", page_text: poliza });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.meta.guard, undefined);
});
