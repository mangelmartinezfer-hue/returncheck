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

const PUBLICADA = "rc-card-target-who-sold-it";

// EL CANARIO. Una ficha sin publicar, metida en el registro SOLO durante la prueba.
//
// Antes esta prueba usaba la ficha de eBay, que estaba en borrador. Al publicarla
// fallo — que era justo lo que se buscaba, obligar a mirar — pero enseño que atar
// la prueba de la puerta a que exista un borrador de verdad es fragil: el dia que
// todas las fichas esten publicadas, la prueba se queda sin sujeto y el 404 deja de
// comprobarse justo cuando ya nadie se acuerda de el.
//
// Asi se ejercita el enrutador REAL contra una ficha sin publicar, siempre, sin
// depender de que haya trabajo a medias y sin meter datos de mentira en produccion.
const SIN_PUBLICAR = "rc-card-canario-sin-publicar";
CARDS.set(SIN_PUBLICAR, {
  card_id: SIN_PUBLICAR,
  merchant: "canario",
  merchant_name: "Canario",
  country: "US",
  published: false,
  verified_on: "2026-08-20",
  source_url: "https://example.invalid/policy",
  question: "Does an unpublished card leak?",
  answer: "conditional",
  page: { title: "Palabra que no debe salir jamas: cuervopalido", meta_description: "" },
  outcomes: [
    {
      days: 1,
      basis: "delivery",
      when: "never served",
      conditions: [],
      clause: "cuervopalido",
      source_url: "https://example.invalid/policy",
      verified_on: "2026-08-20",
    },
  ],
  denials: [],
});

// ---------------------------------------------------------------------------
// La puerta
// ---------------------------------------------------------------------------

test("puerta: published es false por defecto — una ficha sin el campo no se sirve", () => {
  assert.equal(esPublicable({ card_id: "rc-card-x", question: "q" }), false);
});

test("puerta: el canario esta en el registro pero NO es publicable", () => {
  assert.ok(CARDS.has(SIN_PUBLICAR));
  assert.equal(esPublicable(CARDS.get(SIN_PUBLICAR)), false);
});

test("puerta: una ficha sin publicar da 404 en HTML, y no un borrador", async () => {
  const r = await get("/cards/" + SIN_PUBLICAR);
  assert.equal(r.status, 404);
  // Nada suyo puede asomar: ni el titulo, ni la clausula, ni la pregunta.
  assert.doesNotMatch(await r.text(), /cuervopalido/i);
});

test("puerta: una ficha sin publicar da 404 tambien en JSON", async () => {
  const r = await get("/cards/" + SIN_PUBLICAR + ".json");
  assert.equal(r.status, 404);
  assert.doesNotMatch(await r.text(), /cuervopalido/i);
});

test("puerta: un card_id inexistente da 404, igual que uno sin publicar", async () => {
  assert.equal((await get("/cards/rc-card-no-existe")).status, 404);
  assert.equal((await get("/cards/rc-card-no-existe.json")).status, 404);
});

test("puerta: published:true NO basta si falta una clausula literal", () => {
  const base = CARDS.get(SIN_PUBLICAR);
  const aMedias = {
    ...base,
    published: true,
    outcomes: [{ ...base.outcomes[0], clause: "" }],
  };
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
// Las otras dos fichas — y lo que tienen de raro
// ---------------------------------------------------------------------------

const EBAY = "rc-card-ebay-seller-decides";
const COSTCO = "rc-card-costco-satisfaction-guaranteed";

test("las tres fichas del orden acordado estan publicadas y responden 200", async () => {
  for (const id of [PUBLICADA, EBAY, COSTCO]) {
    assert.equal((await get("/cards/" + id)).status, 200, id);
    assert.equal((await get("/cards/" + id + ".json")).status, 200, id + ".json");
  }
});

test("SIN NUMERO INVENTADO: si la clausula no da plazo, no hay `days` ni `basis`", async () => {
  const j = JSON.parse(await (await get("/cards/" + EBAY + ".json")).text());
  // «lo decide el vendedor» y «even if the seller doesn't offer returns» no dicen
  // ningun plazo. Ausente significa "la politica no lo dice" — un 0 o un null se
  // leerian como cero dias o como un fallo.
  assert.equal("days" in j.outcomes[0], false);
  assert.equal("basis" in j.outcomes[0], false);
  assert.equal(j.outcomes[1].days, 30);
  assert.equal(j.outcomes[1].basis, "delivery");
  assert.equal("days" in j.outcomes[2], false);
});

test("eBay: la clausula que lo hace unico va literal en las dos caras", async () => {
  const literal = "even if the seller doesn't offer returns";
  const j = JSON.parse(await (await get("/cards/" + EBAY + ".json")).text());
  assert.ok(j.outcomes.some((o) => o.clause.includes(literal)));
  // En HTML la comilla simple de "doesn't" no se escapa, pero las comillas dobles
  // del entrecomillado si: comprobamos el texto tal y como se ve.
  const html = await (await get("/cards/" + EBAY)).text();
  assert.match(html, /even if the seller doesn&#39;t offer returns|even if the seller doesn't offer returns/);
  assert.match(html, /30 calendar days after the estimated or actual delivery date/);
});

test("Costco: la regla general no lleva cifra y la pagina pinta una raya", async () => {
  const j = JSON.parse(await (await get("/cards/" + COSTCO + ".json")).text());
  assert.equal("days" in j.outcomes[0], false);
  assert.match(j.outcomes[0].clause, /We guarantee your satisfaction on every product we sell/);
  assert.equal(j.outcomes[1].days, 90);

  const html = await (await get("/cards/" + COSTCO)).text();
  assert.match(html, /<span class="days">—<\/span>/);
  assert.match(html, /<span class="days">90<\/span>/);
});

test("Costco: los metales preciosos son un denial con su cita literal", async () => {
  const j = JSON.parse(await (await get("/cards/" + COSTCO + ".json")).text());
  assert.equal(j.denials.length, 1);
  assert.equal(j.denials[0].scope, "precious metals");
  assert.equal(j.denials[0].clause, "Precious metals are non-refundable.");
});

test("los gemelos no discrepan TAMPOCO en las fichas nuevas", async () => {
  for (const id of [EBAY, COSTCO]) {
    const html = await (await get("/cards/" + id)).text();
    const crudo = await (await get("/cards/" + id + ".json")).text();
    const enLaPagina = html
      .match(/<pre>([\s\S]*?)<\/pre>/)[1]
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    assert.equal(enLaPagina, crudo, id);
  }
});

test("cada ficha nombra al comercio del que NO somos", async () => {
  for (const [id, nombre] of [[EBAY, "eBay"], [COSTCO, "Costco"]]) {
    const html = await (await get("/cards/" + id)).text();
    assert.match(html, new RegExp("independent and not affiliated with " + nombre, "i"));
    assert.doesNotMatch(html, /MerchantReturnPolicy/);
  }
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
  assert.match(x, new RegExp("<loc>" + BASE + "/</loc>"));
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
