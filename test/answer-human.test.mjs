// W08 — coherencia del texto humano de la respuesta.
//
// Fallo real de producción (26 ago): verdict "NO" con answer_human
// "YES_WITH_CONDITIONS". El respaldo solo miraba la longitud, y esa cadena mide
// 19 caracteres: pasaba el filtro y salía al cliente. Quien lea el texto lee lo
// contrario del veredicto.
//
// Estas pruebas cubren las dos caras: que el fallo se ataje, y —más importante—
// que no nos llevemos por delante respuestas correctas al atajarlo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usableAnswerHuman } from "../src/text.mjs";
import { runCheck } from "../src/engine.mjs";

// ---------- el fallo que hay que atajar ----------

test("W08 EL FALLO: 'YES_WITH_CONDITIONS' con veredicto NO es inservible", () => {
  assert.equal(usableAnswerHuman("YES_WITH_CONDITIONS", "NO"), false);
});

test("W08: cualquier nombre de enum suelto es una fuga, no una respuesta", () => {
  for (const [texto, v] of [["YES_WITH_CONDITIONS", "YES_WITH_CONDITIONS"], ["yes with conditions", "NO"],
                            ["UNKNOWN.", "UNKNOWN"], ["  Yes_With_Conditions  ", "YES"]]) {
    assert.equal(usableAnswerHuman(texto, v), false, texto);
  }
});

test("W08: un texto que afirma lo contrario del veredicto se rechaza", () => {
  assert.equal(usableAnswerHuman("Yes, you can return this item within 30 days.", "NO"), false);
  assert.equal(usableAnswerHuman("No, this item cannot be returned.", "YES_WITH_CONDITIONS"), false);
  assert.equal(usableAnswerHuman("Unknown. The policy does not say.", "NO"), false);
  assert.equal(usableAnswerHuman("Yes, returnable within 30 days.", "UNKNOWN"), false);
});

test("W08: se conserva el criterio anterior de longitud mínima", () => {
  assert.equal(usableAnswerHuman("Yes.", "YES"), false);
  assert.equal(usableAnswerHuman("", "NO"), false);
  assert.equal(usableAnswerHuman(null, "NO"), false);
});

// ---------- que no rompamos lo que ya funcionaba ----------

test("W08: una respuesta correcta se respeta tal cual", () => {
  assert.equal(usableAnswerHuman("No. This item is not returnable under the merchant's published policy.", "NO"), true);
  assert.equal(usableAnswerHuman("Yes, with conditions — returnable within 90 days.", "YES_WITH_CONDITIONS"), true);
  assert.equal(usableAnswerHuman("Unknown. The published policy does not resolve this case.", "UNKNOWN"), true);
});

test("W08 EL MATIZ QUE IMPORTA: \"No restocking fee\" no es una negación", () => {
  // Aquí "no" es un adjetivo, no la respuesta. Si esto fallara, estaríamos
  // sustituyendo prosa correcta del modelo por nuestra plantilla genérica —
  // arreglando un fallo y creando otro más silencioso.
  assert.equal(usableAnswerHuman("No restocking fee applies; you may return within 30 days.", "YES_WITH_CONDITIONS"), true);
  assert.equal(usableAnswerHuman("No returns are accepted after 30 days, so this one is fine.", "YES"), true);
});

test("W08: 'Yes' dentro de la frase no delata polaridad, solo al principio", () => {
  assert.equal(usableAnswerHuman("This item is not returnable, even though yes applies elsewhere.", "NO"), true);
});

test("W08: los textos de respaldo del propio motor se consideran válidos", () => {
  // Si nuestra propia plantilla no pasara el filtro, entraríamos en un bucle
  // de sustituirla por sí misma. Merece una prueba explícita.
  const propios = [
    ["No. This item is not returnable under the merchant's published policy for this case.", "NO"],
    ["Unknown. The published policy does not resolve this specific case.", "UNKNOWN"],
    ["Yes, with conditions — returnable within 90 days under the merchant's policy.", "YES_WITH_CONDITIONS"],
    ["Unknown. This item is sold by a third-party seller whose own return policy is not on this page.", "UNKNOWN"],
    ["Unknown. This depends on the buyer's state law, which was not provided.", "UNKNOWN"],
    ["Unknown. The cited clause does not clearly cover an opened/used item.", "UNKNOWN"],
  ];
  for (const [t, v] of propios) assert.equal(usableAnswerHuman(t, v), true, t);
});

// ---------- el motor entero ----------

test("motor: la fuga de enum se sustituye antes de salir al cliente", async () => {
  const POLIZA = "Return Policy. Final sale items cannot be returned or exchanged under any circumstances. All sales are final.";
  const env = {
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
                            run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) },
    AI: { run: async () => ({ response: JSON.stringify({
      verdict: "NO", confidence: 0.9,
      answer_human: "YES_WITH_CONDITIONS",          // la fuga exacta vista en producción
      reason: null,
      merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
      policy: { return_category: "NotPermitted", merchant_return_days: null, window_basis: null,
                return_method: [], return_fees: null, refund_type: null },
      evidence: { source_url: "https://example.com/p/x", clause_id: null,
                  exact_clause: "Final sale items cannot be returned or exchanged under any circumstances." },
    }) }) },
  };
  const r = await runCheck(env, { product_url: "https://example.com/p/x", buyer_country: "US", page_text: POLIZA });
  assert.equal(r.verdict, "NO");
  assert.notEqual(r.answer_human, "YES_WITH_CONDITIONS");
  assert.match(r.answer_human, /^No\./);
});
