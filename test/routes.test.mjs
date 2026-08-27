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

// ---------------------------------------------------------------------------
// W32 — x402 cosido a la ruta.
//
// Lo que vigilan estas pruebas es lo que de verdad da miedo de este cambio: que
// tocar la ruta de cobro rompa algo que hoy funciona. Por eso la primera y la
// última comprueban que CON EL INTERRUPTOR APAGADO no cambia absolutamente nada.
// ---------------------------------------------------------------------------

import { sacarDelSobre } from "../src/x402.mjs";

const ENV_X402 = {
  ...ENV,
  X402_ENABLED: "true",
  X402_NETWORK: "eip155:84532",
  X402_PAY_TO: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b",
  X402_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Sin tramo gratis, para llegar al 402 sin depender de la base de datos.
  FREE_TRIAL_ENABLED: "false",
};

const postCheck = (env, cabeceras = {}) =>
  worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...cabeceras },
    body: JSON.stringify({ product_url: "https://tienda.example/p/1", buyer_country: "US" }),
  }), env);

test("W32 LO MAS IMPORTANTE: con el interruptor APAGADO no cambia nada", async () => {
  // Ni siquiera mandando una firma de pago. Si esto fallara, habriamos cambiado el
  // comportamiento de produccion al desplegar, que es justo lo que no queremos.
  const r = await postCheck({ ...ENV, FREE_TRIAL_ENABLED: "false" },
                            { "PAYMENT-SIGNATURE": "cualquier-cosa" });
  assert.equal(r.headers.get("PAYMENT-REQUIRED"), null);
  assert.equal(r.status, 402);   // el 402 educado de siempre
});

test("W32: el callejón sin salida pasa a ser una puerta", async () => {
  // Antes, agotado el tramo gratis, el 402 decia "no puedes seguir". Ahora dice
  // cuanto cuesta y donde pagar.
  const r = await postCheck(ENV_X402);
  assert.equal(r.status, 402);
  const sobre = r.headers.get("PAYMENT-REQUIRED");
  assert.ok(sobre, "falta la cabecera PAYMENT-REQUIRED");
  const reto = sacarDelSobre(sobre);
  assert.equal(reto.x402Version, 2);
  assert.equal(reto.accepts[0].amount, "20000");
  assert.equal(reto.accepts[0].payTo, "0xbF428071027402E9b0cE85e22146EDdc028cEB3b");
  assert.equal(reto.accepts[0].network, "eip155:84532");
});

test("W32: el cuerpo del 402 lleva el mismo reto que la cabecera", async () => {
  // Un agente que no sepa leer la cabecera todavia puede entenderlo.
  const r = await postCheck(ENV_X402);
  const cuerpo = await r.json();
  assert.equal(cuerpo.x402Version, 2);
  assert.equal(cuerpo.accepts[0].payTo, sacarDelSobre(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo);
});

test("W32: una firma que no cuadra con lo que pedimos NO pasa", async () => {
  // El ataque de W28, ahora por la ruta de verdad: firma perfecta sobre una
  // cantidad rebajada. Ni siquiera se llega a llamar al facilitador.
  const { meterEnSobre } = await import("../src/x402.mjs");
  const trucada = meterEnSobre({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "1",
                asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                payTo: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b" },
    payload: { signature: "0xloquesea", authorization: {} },
  });
  const r = await postCheck(ENV_X402, { "PAYMENT-SIGNATURE": trucada });
  assert.equal(r.status, 402);
  const reto = sacarDelSobre(r.headers.get("PAYMENT-REQUIRED"));
  assert.match(reto.error, /do not match/);
});

test("W32: sin dirección de cobro configurada, no se anuncia precio", async () => {
  // Preferimos el 402 educado de siempre a un reto de pago sin decir a donde.
  const r = await postCheck({ ...ENV_X402, X402_PAY_TO: "" });
  assert.equal(r.status, 402);
  assert.equal(r.headers.get("PAYMENT-REQUIRED"), null);
});
