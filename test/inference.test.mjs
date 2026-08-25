// W05 — parámetros de muestreo del modelo.
//
// Estas pruebas existen por una razón concreta: durante cinco días la llamada al
// modelo no pasó `temperature`, Workers AI aplicó su 0.6 por defecto, y el motor
// estuvo muestreando al azar sin que nadie lo hubiera decidido. Un parámetro
// AUSENTE no lo detecta ninguna prueba de comportamiento; solo lo detecta una
// prueba que mire los parámetros. Eso es lo que hay aquí.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferenceParams, AI_TEMPERATURE } from "../src/prompt.mjs";

test("W05: por defecto la temperatura se envía EXPLÍCITA y es 0", () => {
  const p = inferenceParams({});
  assert.equal(p.temperature, 0);
  assert.equal(AI_TEMPERATURE, 0);
});

test("W05: la temperatura nunca se omite, ni con env vacío o ausente", () => {
  // Omitirla es lo que causó el problema: el proveedor pone la suya.
  for (const env of [undefined, null, {}, { AI_TEMPERATURE: "" }, { AI_TEMPERATURE: null }]) {
    assert.equal(Object.hasOwn(inferenceParams(env), "temperature"), true);
  }
});

test("W05: se puede volver al comportamiento anterior (0.6) sin desplegar", () => {
  // Necesario para medir las dos ramas contra el MISMO build: una sola variable.
  assert.equal(inferenceParams({ AI_TEMPERATURE: "0.6" }).temperature, 0.6);
  assert.equal(inferenceParams({ AI_TEMPERATURE: "1" }).temperature, 1);
});

test("W05: un valor basura cae al defecto y NO se envía a la API", () => {
  for (const bad of ["caliente", "-1", "9", "NaN", "{}"]) {
    assert.equal(inferenceParams({ AI_TEMPERATURE: bad }).temperature, 0);
  }
});

test("W05: sin AI_SEED no se envía semilla", () => {
  assert.equal(Object.hasOwn(inferenceParams({}), "seed"), false);
  assert.equal(Object.hasOwn(inferenceParams({ AI_SEED: "" }), "seed"), false);
});

test("W05: con AI_SEED la semilla se envía y el REINTENTO usa otra distinta", () => {
  // Repetir la misma semilla tras una salida inválida reproduciría el mismo fallo.
  assert.equal(inferenceParams({ AI_SEED: "42" }, 0).seed, 42);
  assert.equal(inferenceParams({ AI_SEED: "42" }, 1).seed, 43);
});

test("W05: una semilla inválida se ignora en vez de romper la llamada", () => {
  for (const bad of ["0", "-5", "abc", "1.5", "99999999999"]) {
    assert.equal(Object.hasOwn(inferenceParams({ AI_SEED: bad }), "seed"), false);
  }
});

test("W05: no se cuelan parámetros que nadie ha pedido", () => {
  // Si mañana alguien añade top_p o top_k sin decidirlo, esta prueba lo caza.
  assert.deepEqual(Object.keys(inferenceParams({})).sort(), ["temperature"]);
  assert.deepEqual(Object.keys(inferenceParams({ AI_SEED: "7" })).sort(), ["seed", "temperature"]);
});
