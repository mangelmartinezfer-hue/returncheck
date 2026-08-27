// W06 — el holdout de 25 casos, y la aritmética con la que se va a leer.
//
// Estas pruebas no miden el motor: miden el INSTRUMENTO. El 26 de agosto leímos
// una cobertura del 72,2 % como un suspenso cuando era el techo del banco, y
// estuvimos a punto de perseguir un número imposible. Antes de correr 125
// llamadas conviene que el marcador esté demostrado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLDOUT_CASES } from "../src/holdout-cases.mjs";
import { EVAL_CASES } from "../src/eval-cases.mjs";
import worker from "../src/index.mjs";

test("W06: el holdout tiene los 25 casos y ninguno duplicado", () => {
  assert.equal(HOLDOUT_CASES.length, 25);
  assert.equal(new Set(HOLDOUT_CASES.map((c) => c.id)).size, 25);
});

test("W06 EL NÚMERO QUE HAY QUE TENER DELANTE: el techo de cobertura es 80,0 %", () => {
  // Cinco de los 25 esperan UNKNOWN. O sea que el criterio de H4 «cobertura ≥ 80 %»
  // sobre este banco no es un aprobado holgado: es la perfección, sin margen.
  const unknowns = HOLDOUT_CASES.filter((c) => c.expected.verdict === "UNKNOWN").length;
  assert.equal(unknowns, 5);
  assert.equal(Math.round(((25 - unknowns) / 25) * 1000) / 10, 80);
});

test("W27: los DOS bancos distinguen ya YES de YES_WITH_CONDITIONS", () => {
  // Esta prueba afirmaba lo contrario hasta hoy: que el holdout distinguia y
  // nuestro banco NO. Esa asimetria era la que hacia falta puntuar dos veces, y
  // era el sintoma de que nuestra definicion de YES estaba muerta — en 250
  // evaluaciones el motor no habia emitido ni uno.
  //
  // W27 recalibro tres casos (C01, C04, C13) siguiendo al holdout, no a nuestro
  // codigo. La justificacion caso por caso esta escrita en src/eval-cases.mjs.
  assert.ok(HOLDOUT_CASES.some((c) => c.expected.verdict === "YES"));
  assert.ok(EVAL_CASES.some((c) => c.expected.verdict === "YES"));
});

test("W27 LO QUE NO PUEDE PASAR: el banco propio NO se ha vuelto todo YES", () => {
  // Si todos los positivos fueran YES, habriamos matado la etiqueta por el otro
  // lado y el examen dejaria de discriminar. Cinco casos siguen esperando
  // YES_WITH_CONDITIONS a proposito: C07, C08, C10, C16 y C17.
  const ywc = EVAL_CASES.filter((c) => c.expected.verdict === "YES_WITH_CONDITIONS");
  assert.equal(ywc.length, 5);
  const yes = EVAL_CASES.filter((c) => c.expected.verdict === "YES");
  assert.equal(yes.length, 3);
});

test("W27: cada respuesta recalibrada lleva su justificacion escrita", () => {
  // Cambiar el examen sin dejar por escrito POR QUE es como se acaba aprobando
  // sin saber la asignatura. Si algun dia falta la justificacion, se revierte.
  for (const c of EVAL_CASES.filter((x) => x.expected.verdict === "YES"))
    assert.match(c.note || "", /W27/, c.id + " recalibrado sin justificacion");
});

test("W06: cada caso trae la fecha de referencia y una cita esperada", () => {
  for (const c of HOLDOUT_CASES) {
    assert.ok(c.request.as_of, c.id + " sin as_of: el plazo se calcularía contra hoy");
    assert.ok(c.page_text && c.page_text.length > 40, c.id + " sin texto de política");
    assert.ok(c.note && c.note.length > 10, c.id + " sin justificación de la etiqueta");
  }
});

test("W06: los casos con ventana traen plazo, base y fecha límite esperados", () => {
  const conVentana = HOLDOUT_CASES.filter((c) => c.expected.days != null);
  assert.ok(conVentana.length >= 12);
  for (const c of conVentana) {
    assert.ok(c.expected.window_basis, c.id + " sin base de ventana");
    assert.match(c.expected.deadline || "", /^\d{4}-\d{2}-\d{2}$/, c.id + " sin fecha límite");
  }
});

test("W06: el adaptador congelado del 24 ago se conserva", () => {
  // Si cambiara, el resultado dejaría de ser comparable con aquella auditoría y
  // no sabríamos si mejoró el motor o el mapeo.
  const razones = new Set(HOLDOUT_CASES.map((c) => c.request.reason));
  assert.ok(!razones.has("wrong_size"), "wrong_size debía mapearse a wrong_size_or_model");
  assert.ok(!razones.has("damaged_in_transit"), "damaged_in_transit debía mapearse a defective");
  assert.ok(razones.has("wrong_size_or_model"));
});

test("W06: los campos que W03 añadió llegan al motor", () => {
  // RC25-12 (membresía Plus) y RC25-21 (compra en tienda) fallaban en agosto
  // porque el contrato los ignoraba. Si se perdieran por el camino, volveríamos
  // a medir el fallo antiguo y creeríamos que W03 no sirvió.
  assert.equal(HOLDOUT_CASES.find((c) => c.id === "RC25-12").request.membership, "Plus");
  assert.equal(HOLDOUT_CASES.find((c) => c.id === "RC25-21").request.purchase_channel, "store");
});

// ---------- la ruta ----------

const DB_FALSA = { prepare: () => ({
  bind: () => ({ first: async () => ({}), all: async () => ({ results: [] }), run: async () => ({}) }),
  first: async () => ({}), all: async () => ({ results: [] }), run: async () => ({}) }) };
const ENV = { PUBLIC_BASE_URL: "https://rc.example", ADMIN_KEY: "clave-de-prueba-no-real", DB: DB_FALSA };
const pide = (path) => worker.fetch(new Request("https://rc.example" + path,
  { headers: { authorization: "Bearer clave-de-prueba-no-real" } }), ENV);

test("W06: /eval?set=holdout se identifica y publica su propio techo", async () => {
  const j = await (await pide("/eval?set=holdout&count=0")).json();
  assert.equal(j.set, "holdout");
  assert.equal(j.coverage_ceiling_pct, 80);
});

test("W06: sin ?set sigue siendo el banco propio, con su techo de 72,2 %", async () => {
  // No regresión: cualquier comparación con las mediciones de hoy debe seguir valiendo.
  const j = await (await pide("/eval?count=0")).json();
  assert.equal(j.set, "own");
  assert.equal(j.coverage_ceiling_pct, 72.2);
});

test("W06: el volcado trae las dos puntuaciones, no una", async () => {
  const j = await (await pide("/eval?set=holdout&count=0")).json();
  assert.equal(typeof j.operational, "object");
  assert.equal(typeof j.operational.taxonomy_only_diffs, "number");
  assert.equal(typeof j.window_accuracy, "object");
});

test("W06: el holdout sigue cerrado sin clave de administrador", async () => {
  const r = await worker.fetch(new Request("https://rc.example/eval?set=holdout"), ENV);
  assert.equal(r.status, 404);
});
