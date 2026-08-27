// W23 — YES significa «ya cumple», no «la política tiene letra pequeña».
//
// Estas pruebas usan las CLÁUSULAS REALES de los dos bancos, no ejemplos
// inventados. Es lo único que las hace valer: si paso el examen con textos que me
// he escrito yo, no he probado nada.
//
// Los casos RC25-* son del holdout, que escribió el equipo de ChatGPT sin saber
// que nosotros nunca emitíamos YES. Son el árbitro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPositive } from "../src/decision.mjs";

const positivo = (clause) => ({
  verdict: "YES_WITH_CONDITIONS",
  evidence: { exact_clause: clause },
  policy: { merchant_return_days: 30, return_category: "FiniteReturnWindow" },
});

// ---------------------------------------------------------------------------
// Los 4 del holdout que hoy perdemos. Son 16 puntos de examen.
// ---------------------------------------------------------------------------

test("RC25-05: sin ninguna condición nombrada, es YES a secas", () => {
  const r = classifyPositive(
    positivo("Purchases made from November 1 through December 24 may be returned within 60 calendar days of the purchase date."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES");
  assert.deepEqual(r.assumed_satisfied, []);
});

test("RC25-09: sello intacto y sin abrir, y el artículo viene unopened", () => {
  const r = classifyPositive(
    positivo("Physical software packages may be returned for a refund within 14 calendar days after delivery if the activation seal remains intact and the package has not been opened."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES");
  assert.ok(r.assumed_satisfied.length > 0);
});

test("RC25-01 EL CASO DIFÍCIL: los accesorios no nos los han dicho, y aun así es YES", () => {
  // Un artículo SIN ABRIR tiene por fuerza sus accesorios dentro. Eso es lo que
  // hace legítimo darlo por cumplido — pero se dice en voz alta.
  const r = classifyPositive(
    positivo("Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES");
  assert.ok(r.assumed_satisfied.some((x) => /accessories/.test(x)));
});

test("RC25-25 EL OTRO DIFÍCIL: etiquetas puestas, no nos lo han dicho, YES", () => {
  const r = classifyPositive(
    positivo("Regular-price apparel may be returned for a refund within 30 calendar days after delivery when it is unworn and the original tags remain attached."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES");
  assert.ok(r.assumed_satisfied.some((x) => /tags/.test(x)));
});

// ---------------------------------------------------------------------------
// LO QUE NO PUEDE PASAR. Si esto falla, hemos convertido el motor en optimista y
// habremos roto lo único que vendemos.
// ---------------------------------------------------------------------------

test("C07 · solo cambio, sin reembolso en metálico -> SIGUE siendo YES_WITH_CONDITIONS", () => {
  // Es una condición sobre lo que el comprador RECIBE. No depende de él, así que
  // no se puede dar por cumplida jamás.
  const r = classifyPositive(
    positivo("Defective items are eligible for replacement only; cash refunds are not provided for defective merchandise."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.pending, "outcome_condition");
});

test("C16 · vale de tienda en vez de reembolso -> YES_WITH_CONDITIONS aunque venga unopened", () => {
  const r = classifyPositive(
    positivo("Unworn items with tags may be returned within 45 days. Returns made after 14 days receive store credit rather than a refund to the original payment method."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
});

test("C10 · comisión de reposición -> YES_WITH_CONDITIONS", () => {
  const r = classifyPositive(
    positivo("Opened electronics in the video card and television categories are subject to a 15% restocking fee."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
});

test("C08 · 'final sale' -> no sabemos si ESTE artículo entra, YES_WITH_CONDITIONS", () => {
  const r = classifyPositive(
    positivo("Products may be returned within 60 days of purchase. Gift cards and items marked final sale are not returnable."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.pending, "eligibility_unverifiable");
});

test("C17 · 'algunas categorías varían' -> YES_WITH_CONDITIONS", () => {
  const r = classifyPositive(
    positivo("Returns are accepted within 30 days. Some categories may have different windows as noted on the product page."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
});

test("EL LÍMITE DEL ENTRAÑAMIENTO: artículo ABIERTO con condiciones de estado -> nada se da por cumplido", () => {
  // El entrañamiento solo vale para 'unopened' y 'new'. Un artículo abierto no
  // demuestra nada sobre sus etiquetas ni sus accesorios.
  const r = classifyPositive(
    positivo("Items must be unused and in their original packaging."),
    { item_condition: "opened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.pending, "item_condition");
});

test("SEGURIDAD NUEVA: un YES del modelo se BAJA a YES_WITH_CONDITIONS si hay condición de resultado", () => {
  // Va en los dos sentidos. Esto no existía antes y es proteccion, no cobertura.
  const resp = { verdict: "YES",
                 evidence: { exact_clause: "Returns are accepted within 30 days for store credit only." },
                 policy: {} };
  assert.equal(classifyPositive(resp, { item_condition: "unopened" }).verdict, "YES_WITH_CONDITIONS");
});

test("no toca los veredictos que no son positivos", () => {
  assert.equal(classifyPositive({ verdict: "NO", evidence: {}, policy: {} }, {}), null);
  assert.equal(classifyPositive({ verdict: "UNKNOWN", evidence: null, policy: null }, {}), null);
});

test("EL AGUJERO QUE ENCONTRÓ UNA PRUEBA VIEJA: 'con recibo' no lo entraña estar sin abrir", () => {
  // Este caso ya estaba en el banco de pruebas desde C09 y por poco se me cuela
  // como YES. Que un artículo venga sin abrir no dice NADA sobre si el comprador
  // conserva el recibo — y sin recibo no hay devolución. Habría sido un SÍ falso,
  // que es la peor clase de error de este producto.
  const r = classifyPositive(
    positivo("Unopened bottles may be returned within 30 days with receipt."),
    { item_condition: "unopened" });
  assert.equal(r.verdict, "YES_WITH_CONDITIONS");
  assert.equal(r.pending, "procedure_unverifiable");
});
