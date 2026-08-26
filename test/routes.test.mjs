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

// ---------- W09: la clave de administrador deja de tener que ir en la URL ----------
// Lo detecto la sesion local: las URLs se escriben enteras en los registros de
// Cloudflare, asi que cada visita a /eval o /stats dejaba la clave en texto plano
// en los logs. Medir las dos ramas del experimento la habria escrito dos veces.
// Incoherente con lo que publicamos en /data-policy sobre no guardar secretos.

const DB_FALSA = {
  prepare: () => ({
    bind: () => ({ first: async () => ({}), all: async () => ({ results: [] }), run: async () => ({}) }),
    first: async () => ({}), all: async () => ({ results: [] }), run: async () => ({}),
  }),
};
const ENV_ADMIN = { ...ENV, ADMIN_KEY: "clave-de-prueba-no-real", DB: DB_FALSA };

const pide = (path, headers = {}) =>
  worker.fetch(new Request("https://rc.example" + path, { headers }), ENV_ADMIN);

test("W09: /stats acepta la clave por cabecera, sin escribirla en la URL", async () => {
  const r = await pide("/stats", { authorization: "Bearer clave-de-prueba-no-real" });
  assert.equal(r.status, 200);
});

test("W09: /eval acepta la clave por cabecera", async () => {
  const r = await pide("/eval?count=0", { authorization: "Bearer clave-de-prueba-no-real" });
  assert.equal(r.status, 200);
});

// W05 — el banco tiene que decir de dónde salieron las citas. Una prueba de que
// el campo EXISTE, porque un campo que se cae del volcado no rompe nada: solo
// deja de contestar la pregunta, y nadie se entera hasta la siguiente medición.
test("W05: /eval publica el recuento de citas rescatadas por número", async () => {
  const j = await (await pide("/eval?count=0", { authorization: "Bearer clave-de-prueba-no-real" })).json();
  assert.equal(typeof j.clauses_rescued_by_candidate, "number");
  assert.equal(typeof j.clauses_cited, "number");
});

test("W11: /eval publica el reparto de abstenciones", async () => {
  const j = await (await pide("/eval?count=0", { authorization: "Bearer clave-de-prueba-no-real" })).json();
  assert.equal(typeof j.unknown_breakdown, "object");
});

test("W09: se conserva ?k= — el panel se abre pegando la URL y romperlo hoy no arregla nada", async () => {
  assert.equal((await pide("/stats?k=clave-de-prueba-no-real")).status, 200);
  assert.equal((await pide("/dashboard?k=clave-de-prueba-no-real")).status, 200);
});

test("W09: sin clave sigue siendo 404, y una clave falsa también", async () => {
  assert.equal((await pide("/stats")).status, 404);
  assert.equal((await pide("/stats", { authorization: "Bearer otra-cosa" })).status, 404);
  assert.equal((await pide("/stats?k=otra-cosa")).status, 404);
  assert.equal((await pide("/eval")).status, 404);
});

test("W09: sin ADMIN_KEY configurada no se abre por ninguna de las dos vías", async () => {
  // Un despliegue sin la variable no puede quedar con el panel abierto de par en par.
  const sinClave = { ...ENV, DB: DB_FALSA };
  const r1 = await worker.fetch(new Request("https://rc.example/stats", { headers: { authorization: "Bearer x" } }), sinClave);
  const r2 = await worker.fetch(new Request("https://rc.example/stats?k="), sinClave);
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
});
