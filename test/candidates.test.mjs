// W05 — frases candidatas.
//
// Por qué existen estas pruebas: el hallazgo del 25 ago fue que el motor no falla
// razonando, falla ELIGIENDO qué frase citar. Este cambio le quita esa elección
// libre y le da una lista numerada. Lo que hay que vigilar es que la garantía se
// cumpla —la cita sale de la página, no del teclado del modelo— y, sobre todo,
// que cuando algo salga mal se caiga al comportamiento anterior y no a algo peor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateClauses, candidateBlock, pickClause, clauseInText } from "../src/text.mjs";
import { runCheck } from "../src/engine.mjs";

const POLIZA = [
  "Return Policy",
  "You may return merchandise within 90 calendar days of purchase.",
  "Items must be unused and in original packaging.",
  "Gift cards are non-returnable and cannot be refunded.",
  "Our warehouse is located in Ohio and ships every weekday.",
  "Refunds are issued to the original form of payment within 10 business days.",
].join(" ");

// ---------- extracción ----------

test("candidatas: coge la frase del plazo y descarta el relleno", () => {
  const c = candidateClauses(POLIZA);
  assert.ok(c.some((s) => s.includes("90 calendar days")));
  assert.ok(!c.some((s) => s.includes("Ohio")));   // logística, no política
});

test("candidatas: descarta títulos sueltos como \"Return Policy\"", () => {
  const c = candidateClauses(POLIZA);
  assert.ok(!c.includes("Return Policy"));
});

test("candidatas: TODAS son literales de la página", () => {
  // Es la garantía entera del cambio. Si esto falla, no hemos ganado nada.
  for (const s of candidateClauses(POLIZA)) {
    assert.equal(clauseInText(s, POLIZA), true, "no literal: " + s);
  }
});

test("candidatas: recoge también las exclusiones, que deciden los NO", () => {
  assert.ok(candidateClauses(POLIZA).some((s) => s.includes("non-returnable")));
});

test("candidatas: sin texto devuelve lista vacía, no revienta", () => {
  assert.deepEqual(candidateClauses(""), []);
  assert.deepEqual(candidateClauses(null), []);
});

test("candidatas: respeta el tope y NO devuelve duplicados", () => {
  const larga = Array.from({ length: 40 }, (_, i) =>
    `Category ${i} items may be returned within ${i + 1} calendar days of purchase.`).join(" ");
  const c = candidateClauses(larga, { max: 8 });
  assert.equal(c.length, 8);
  assert.equal(new Set(c).size, 8);
});

test("candidatas: cuando sobran, se devuelven en orden de lectura", () => {
  // Una lista desordenada respecto a la página confunde al modelo y a quien depure.
  const larga = Array.from({ length: 30 }, (_, i) =>
    `Rule ${String(i).padStart(2, "0")} allows returns within ${i + 1} calendar days of purchase.`).join(" ");
  const c = candidateClauses(larga, { max: 5 });
  const posiciones = c.map((s) => larga.indexOf(s));
  assert.deepEqual(posiciones, posiciones.slice().sort((a, b) => a - b));
});

test("candidatas: la numeración que ve el modelo empieza en 1", () => {
  // Un [0] es ambiguo entre "el primero" y "ninguno". Ese detalle cuesta una tarde.
  assert.match(candidateBlock(["primera", "segunda"]), /^\[1\] primera\n\[2\] segunda$/);
  assert.equal(candidateBlock([]), "");
});

// ---------- resolución del número elegido ----------

test("elección válida: la cita pasa a ser la frase literal, no lo que tecleó el modelo", () => {
  const c = candidateClauses(POLIZA);
  const idx = c.findIndex((s) => s.includes("90 calendar days")) + 1;
  const out = pickClause({ clause_id: idx, exact_clause: "within 90 days (parafraseado)" }, POLIZA);
  assert.equal(out, c[idx - 1]);
  assert.equal(clauseInText(out, POLIZA), true);
});

test("sin elección: se respeta la cita libre, como antes", () => {
  const libre = "You may return merchandise within 90 calendar days of purchase.";
  assert.equal(pickClause({ clause_id: null, exact_clause: libre }, POLIZA), libre);
});

test("número imposible: NO se premia, se cae a la cita libre", () => {
  const libre = "algo que dijo el modelo";
  for (const malo of [0, -1, 999, 1.5, "2", null, undefined]) {
    assert.equal(pickClause({ clause_id: malo, exact_clause: libre }, POLIZA), libre);
  }
});

test("desactivado: se comporta exactamente como antes del cambio", () => {
  const libre = "cita libre del modelo";
  assert.equal(pickClause({ clause_id: 1, exact_clause: libre }, POLIZA, false), libre);
});

// ---------- el motor entero, con un modelo falso ----------
// Sin red y sin Cloudflare: se le pasa un env de mentira. Es la prueba que de
// verdad importa, porque cubre el cableado entre las piezas y no solo las piezas.

function envFalso(respuestaIA, { useCandidates } = {}) {
  const visto = { userMsg: null, opciones: null };
  const env = {
    USE_CANDIDATES: useCandidates,
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
                            run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) },
    AI: {
      run: async (_model, opts) => {
        visto.userMsg = opts.messages.find((m) => m.role === "user").content;
        visto.opciones = opts;
        return { response: JSON.stringify(respuestaIA) };
      },
    },
  };
  return { env, visto };
}

const PETICION = {
  product_url: "https://example.com/p/w05",
  buyer_country: "US",
  item_condition: "unopened",
  purchase_date: "2026-08-01",
  page_text: POLIZA,
};

const IA_BASE = {
  verdict: "YES_WITH_CONDITIONS",
  confidence: 0.9,
  answer_human: "Yes, within 90 days.",
  reason: null,
  merchant_resolved: { name: "example.com", domain: "example.com", is_marketplace_third_party: false },
  policy: { return_category: "FiniteReturnWindow", merchant_return_days: 90, window_basis: "purchase_date",
            return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
};

test("motor: la lista numerada llega al modelo dentro del mensaje", async () => {
  const { env, visto } = envFalso({ ...IA_BASE, evidence: { source_url: PETICION.product_url, exact_clause: "x", clause_id: null } });
  await runCheck(env, PETICION);
  assert.match(visto.userMsg, /CANDIDATE CLAUSES/);
  assert.match(visto.userMsg, /\[1\] /);
});

test("motor: una cita PARAFRASEADA se rescata eligiendo la candidata", async () => {
  // Este es el fallo real de producción: el modelo casi acierta, el guard lo
  // rechaza y perdíamos la respuesta entera. Ahora el número la salva.
  const c = candidateClauses(POLIZA);
  const idx = c.findIndex((s) => s.includes("90 calendar days")) + 1;
  const { env } = envFalso({
    ...IA_BASE,
    evidence: { source_url: PETICION.product_url, exact_clause: "puedes devolver en 90 días", clause_id: idx },
  });
  const r = await runCheck(env, PETICION);
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.evidence.exact_clause, c[idx - 1]);
  assert.equal(r.meta.clause_from_candidate, true);
});

test("motor: sin el rescate, esa misma respuesta se habría degradado a UNKNOWN", async () => {
  // La contraprueba. Sin ella no sabríamos si el rescate hace algo o solo adorna.
  const { env } = envFalso({
    ...IA_BASE,
    evidence: { source_url: PETICION.product_url, exact_clause: "puedes devolver en 90 días", clause_id: 1 },
  }, { useCandidates: "false" });
  const r = await runCheck(env, PETICION);
  assert.equal(r.verdict, "UNKNOWN");
});

test("motor: apagado, no se manda ninguna lista al modelo", async () => {
  const { env, visto } = envFalso({ ...IA_BASE, evidence: { source_url: PETICION.product_url, exact_clause: "x", clause_id: null } },
                                  { useCandidates: "false" });
  await runCheck(env, PETICION);
  assert.doesNotMatch(visto.userMsg, /CANDIDATE CLAUSES/);
});

test("motor: una candidata que NO respalda el veredicto sigue degradando a UNKNOWN", async () => {
  // El rescate no puede convertirse en una puerta trasera: elegir un número
  // válido pero equivocado no debe comprar un veredicto. Los guards siguen mandando.
  const c = candidateClauses(POLIZA);
  const idx = c.findIndex((s) => s.includes("non-returnable")) + 1;
  const { env } = envFalso({
    ...IA_BASE,
    evidence: { source_url: PETICION.product_url, exact_clause: "da igual", clause_id: idx },
  });
  const r = await runCheck(env, PETICION);
  assert.equal(r.verdict, "UNKNOWN");
});
