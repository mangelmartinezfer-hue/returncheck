// Pruebas de rutas del Worker (sin red, sin Cloudflare): se invoca el propio
// export default { fetch } con un env falso.
//
// Existen sobre todo por el aviso de datos (/data-policy): es un texto público
// que promete cosas concretas, y un cambio descuidado podría borrar el correo de
// reclamación o meter una promesa que no queremos hacer. Que lo vigile una prueba
// y no la memoria de nadie.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example",
  CONTACT_EMAIL: "martiplacsystem@gmail.com",
  DATA_RETENTION_MONTHS: "48",
  PRICE_USD: "0.02",
};
const get = (path, env = ENV) => worker.fetch(new Request("https://rc.example" + path), env);

test("aviso: /data-policy se sirve como texto plano", async () => {
  const r = await get("/data-policy");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/plain/);
});

test("aviso: lleva la dirección de reclamación y el plazo de conservación", async () => {
  const t = await (await get("/data-policy")).text();
  assert.match(t, /martiplacsystem@gmail\.com/);
  assert.match(t, /48 months/);
});

test("aviso: NO promete que no se venden los datos (decisión de Miguel, doc 40)", async () => {
  const t = await (await get("/data-policy")).text();
  assert.doesNotMatch(t, /do not sell|never sell|not sold/i);
});

test("aviso: dice que la referencia del cliente es un hash, no la clave ni el email", async () => {
  const t = await (await get("/data-policy")).text();
  assert.match(t, /hash/i);
  assert.match(t, /Never the API key itself/i);
});

test("aviso: la vía de borrado para comercios está escrita", async () => {
  const t = await (await get("/data-policy")).text();
  assert.match(t, /removal/i);
  assert.match(t, /We delete it/i);
});

test("aviso: el plazo y el correo salen de la configuración, no están fijos en el código", async () => {
  const t = await (await get("/data-policy", { ...ENV, CONTACT_EMAIL: "otro@ejemplo.com", DATA_RETENTION_MONTHS: "12" })).text();
  assert.match(t, /otro@ejemplo\.com/);
  assert.match(t, /12 months/);
});

test("descubrimiento: / enlaza el aviso", async () => {
  const j = await (await get("/")).json();
  assert.equal(j.data_policy, "https://rc.example/data-policy");
});

test("descubrimiento: agents.json enlaza el aviso y lleva el correo real", async () => {
  const j = await (await get("/agents.json")).json();
  assert.equal(j.data_policy, "https://rc.example/data-policy");
  assert.equal(j.contact_email, "martiplacsystem@gmail.com");
});

test("descubrimiento: ai-plugin.json ya no lleva el correo inventado", async () => {
  const j = await (await get("/.well-known/ai-plugin.json")).json();
  assert.equal(j.contact_email, "martiplacsystem@gmail.com");
  assert.equal(j.legal_info_url, "https://rc.example/data-policy");
});

test("descubrimiento: llms.txt enlaza el aviso", async () => {
  const t = await (await get("/llms.txt")).text();
  assert.match(t, /\/data-policy/);
});

// No regresión: el aviso no puede haber roto nada de lo que ya funcionaba.
test("no regresión: /openapi.json sigue respondiendo", async () => {
  assert.equal((await get("/openapi.json")).status, 200);
});

test("no regresión: /dashboard sigue oculto sin clave de administrador", async () => {
  assert.equal((await get("/dashboard")).status, 404);
});

test("no regresión: una ruta inexistente sigue devolviendo 404", async () => {
  assert.equal((await get("/no-existe")).status, 404);
});
