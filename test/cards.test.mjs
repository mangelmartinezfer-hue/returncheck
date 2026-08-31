// W52 — Pruebas de las FICHAS DE EVIDENCIA.
//
// Vigilan tres cosas que, si se rompen, rompen la pieza entera:
//
//  1. LA PUERTA. Una ficha sin publicar da 404 y no asoma por ningun sitio. Es la
//     unica garantia de que nada sale a la calle sin que Miguel lo mire.
//  2. LOS GEMELOS NO DISCREPAN. Lo que se imprime en la pagina y lo que devuelve
//     la ruta .json es el mismo texto, caracter a caracter. Si un dia divergen, la
//     ficha deja de ser evidencia y pasa a ser dos afirmaciones distintas.
//  3. EL MARCADO. Article o Dataset, NUNCA MerchantReturnPolicy. No somos el
//     comercio; marcarnos como tal seria reclamar una politica que no es nuestra.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { CARDS, esPublicable, motivosNoPublicable, fichasPublicadas } from "../src/cards.mjs";

const BASE = "https://rc.example";
const ENV = { PUBLIC_BASE_URL: BASE, PRICE_USD: "0.02" };
const get = (path, env = ENV) => worker.fetch(new Request(BASE + path), env);

// La ficha publicada y una sin publicar, sacadas del registro real: si manana se
// publica la de eBay, estas pruebas fallan y hay que elegir otra. Es lo correcto —
// obliga a mirar.
const PUBLICADA = "rc-card-target-who-sold-it";
const SIN_PUBLICAR = "rc-card-ebay-seller-decides";

// ---------------------------------------------------------------------------
// La puerta
// ---------------------------------------------------------------------------

test("puerta: published es false por defecto — una ficha sin el campo no se sirve", () => {
  assert.equal(esPublicable({ card_id: "rc-card-x", question: "q" }), false);
});

test("puerta: la ficha de eBay esta en el registro pero NO publicada", () => {
  assert.ok(CARDS.has(SIN_PUBLICAR), "el borrador debe existir como fichero");
  assert.equal(esPublicable(CARDS.get(SIN_PUBLICAR)), false);
});

test("puerta: una ficha sin publicar da 404 en HTML, y no un borrador", async () => {
  const r = await get("/cards/" + SIN_PUBLICAR);
  assert.equal(r.status, 404);
  const t = await r.text();
  // Nada del borrador puede asomar: ni el titulo, ni la pregunta, ni el comercio.
  assert.doesNotMatch(t, /seller decides/i);
  assert.doesNotMatch(t, /Money Back Guarantee/i);
});

test("puerta: una ficha sin publicar da 404 tambien en JSON", async () => {
  const r = await get("/cards/" + SIN_PUBLICAR + ".json");
  assert.equal(r.status, 404);
  assert.doesNotMatch(await r.text(), /ebay/i);
});

test("puerta: un card_id inexistente da 404, igual que uno sin publicar", async () => {
  assert.equal((await get("/cards/rc-card-no-existe")).status, 404);
  assert.equal((await get("/cards/rc-card-no-existe.json")).status, 404);
});

test("puerta: published:true NO basta si falta una clausula literal", () => {
  const aMedias = { ...CARDS.get(SIN_PUBLICAR), published: true };
  assert.equal(esPublicable(aMedias), false);
  assert.match(motivosNoPublicable(aMedias).join(" "), /outcomes\[0\]\.clause/);
});

test("integridad: toda ficha publicada esta completa (dice QUE le falta si no)", () => {
  for (const c of fichasPublicadas()) {
    const faltan = motivosNoPublicable(c);
    assert.deepEqual(faltan, [], `${c.card_id} incompleta: ${faltan.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// Las dos caras
// ---------------------------------------------------------------------------

test("ficha publicada: 200 y HTML", async () => {
  const r = await get("/cards/" + PUBLICADA);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/html/);
});

test("ficha publicada: el gemelo JSON responde 200 con el mismo card_id", async () => {
  const r = await get("/cards/" + PUBLICADA + ".json");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /application\/json/);
  const j = JSON.parse(await r.text());
  assert.equal(j.card_id, PUBLICADA);
});

test("LOS GEMELOS NO DISCREPAN: el JSON impreso en la pagina es el de la ruta, letra por letra", async () => {
  const html = await (await get("/cards/" + PUBLICADA)).text();
  const crudo = await (await get("/cards/" + PUBLICADA + ".json")).text();

  const m = html.match(/<pre>([\s\S]*?)<\/pre>/);
  assert.ok(m, "la pagina debe imprimir el gemelo");
  // Deshacer el escapado HTML del bloque <pre> para comparar el texto real.
  const enLaPagina = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

  assert.equal(enLaPagina, crudo);
});

test("la ficha lleva la clausula literal, su fuente y su fecha, en las dos caras", async () => {
  const html = await (await get("/cards/" + PUBLICADA)).text();
  const j = JSON.parse(await (await get("/cards/" + PUBLICADA + ".json")).text());

  assert.match(html, /returned within 90 days will receive a refund or exchange/);
  assert.match(html, /target\.com\/help\/articles\/returns-exchanges\/returns/);
  assert.match(html, /2026-08-20/);

  assert.equal(j.verified_on, "2026-08-20");
  assert.match(j.warning, /policies may change/i);
  const dias = j.outcomes.map((o) => o.days);
  assert.deepEqual(dias, [90, 30, 365]);
});

test("una nota NUNCA se sirve como cita: va en `note`, no en `clause`", async () => {
  const j = JSON.parse(await (await get("/cards/" + PUBLICADA + ".json")).text());
  const abiertos = j.denials.find((d) => /opened/i.test(d.scope));
  assert.ok(abiertos, "debe estar el bloque de articulos abiertos");
  assert.equal(abiertos.clause, undefined);
  assert.match(abiertos.note, /may be denied/i);
});

// ---------------------------------------------------------------------------
// Marcado estructurado
// ---------------------------------------------------------------------------

test("marcado: la ficha se marca como Article, NUNCA como MerchantReturnPolicy", async () => {
  const html = await (await get("/cards/" + PUBLICADA)).text();
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, "debe haber JSON-LD");
  const ld = JSON.parse(m[1].replace(/\\u003c/g, "<"));
  assert.equal(ld["@type"], "Article");
  assert.equal(ld.isBasedOn, "https://www.target.com/help/articles/returns-exchanges/returns");
  assert.equal(ld.about.name, "Target");
  assert.doesNotMatch(html, /MerchantReturnPolicy/);
});

test("marcado: el indice se marca como Dataset, tampoco como MerchantReturnPolicy", async () => {
  const html = await (await get("/cards")).text();
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const ld = JSON.parse(m[1].replace(/\\u003c/g, "<"));
  assert.equal(ld["@type"], "Dataset");
  assert.doesNotMatch(html, /MerchantReturnPolicy/);
});

test("marcado: la pagina declara su gemelo JSON como alternate", async () => {
  const html = await (await get("/cards/" + PUBLICADA)).text();
  assert.match(html, /<link rel="alternate" type="application\/json" href="[^"]*\/cards\/rc-card-target-who-sold-it\.json">/);
});

test("la ficha dice que no somos el comercio", async () => {
  const html = await (await get("/cards/" + PUBLICADA)).text();
  assert.match(html, /independent and not affiliated with Target/i);
});

// ---------------------------------------------------------------------------
// Indice y sitemap
// ---------------------------------------------------------------------------

test("indice: lista la publicada y NO la que esta sin publicar", async () => {
  const html = await (await get("/cards")).text();
  assert.match(html, new RegExp(PUBLICADA));
  assert.doesNotMatch(html, new RegExp(SIN_PUBLICAR));
});

test("indice JSON: mismas fichas, con las dos URLs de cada una", async () => {
  const j = JSON.parse(await (await get("/cards.json")).text());
  assert.equal(j.count, j.cards.length);
  assert.ok(j.cards.some((c) => c.card_id === PUBLICADA));
  assert.ok(!j.cards.some((c) => c.card_id === SIN_PUBLICAR));
  const c = j.cards.find((x) => x.card_id === PUBLICADA);
  assert.equal(c.html_url, BASE + "/cards/" + PUBLICADA);
  assert.equal(c.json_url, BASE + "/cards/" + PUBLICADA + ".json");
});

test("sitemap: solo las URLs publicadas, absolutas y con su fecha", async () => {
  const r = await get("/sitemap.xml");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /xml/);
  const x = await r.text();
  assert.match(x, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(x, new RegExp("<loc>" + BASE + "/cards</loc>"));
  assert.match(x, new RegExp("<loc>" + BASE + "/cards/" + PUBLICADA + "</loc>"));
  assert.match(x, /<lastmod>2026-08-20<\/lastmod>/);
  assert.doesNotMatch(x, new RegExp(SIN_PUBLICAR));
});

// ---------------------------------------------------------------------------
// Lo que estas rutas NO son
// ---------------------------------------------------------------------------

test("gratis y sin clave: sin Authorization y sin base de datos, responde igual", async () => {
  // env SIN DB, sin claves, sin nada. Si alguna de estas rutas tocara el motor, el
  // corpus o el cobro, esto reventaria.
  const r = await worker.fetch(new Request(BASE + "/cards/" + PUBLICADA), { PUBLIC_BASE_URL: BASE });
  assert.equal(r.status, 200);
  const j = await worker.fetch(new Request(BASE + "/cards/" + PUBLICADA + ".json"), {});
  assert.equal(j.status, 200);
});

test("gratis y sin clave: nunca devuelve 402 ni pide pago", async () => {
  for (const ruta of ["/cards", "/cards.json", "/cards/" + PUBLICADA, "/cards/" + PUBLICADA + ".json", "/sitemap.xml"]) {
    const r = await get(ruta);
    assert.notEqual(r.status, 402, ruta);
    assert.equal(r.headers.get("www-authenticate"), null, ruta);
  }
});

test("/llms.txt anuncia las fichas para que un agente las encuentre", async () => {
  const t = await (await get("/llms.txt")).text();
  assert.match(t, /Evidence Cards/);
  assert.match(t, new RegExp(BASE + "/cards"));
  assert.match(t, new RegExp(BASE + "/sitemap\\.xml"));
});
