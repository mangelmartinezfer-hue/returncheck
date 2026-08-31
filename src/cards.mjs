// W52 — FICHAS DE EVIDENCIA (Evidence Cards).
//
// Una ficha responde una pregunta que la gente ya escribe en un buscador —«¿Target
// son 90 dias o 30?»— citando la clausula literal del comercio, su URL y la fecha
// en que se leyo. Y existe DOS VECES: en HTML para una persona y en JSON para un
// agente, bajo el mismo card_id.
//
// LA REGLA DE LA CASA, y es la razon de que este fichero tenga esta forma: las dos
// caras SE DERIVAN DE LA MISMA FUENTE. `gemeloJson()` produce el objeto y la pagina
// HTML no vuelve a escribirlo: lo imprime tal cual, con el mismo `JSON.stringify`.
// Si pudieran discrepar, la ficha no vale nada — es la misma leccion del sobre de
// liquidacion de W51, donde la cabecera y el cuerpo salian del mismo sitio.
//
// LO QUE ESTA RUTA NO ES: no toca el motor, ni los guardianes, ni el contrato v1.0,
// ni /v1/check, ni el MCP, ni x402. Es lectura publica, sin autenticacion y sin
// coste. No escribe en ninguna tabla, no llama al modelo, no cachea nada.
//
// MARCADO ESTRUCTURADO: Article, NUNCA MerchantReturnPolicy. No somos el comercio y
// marcarnos como tal seria decirle a Google que esta politica es nuestra. Lo es de
// Target; nosotros solo la citamos y la fechamos. Hay una prueba que lo vigila.

import cardTarget from "../cards/rc-card-target-who-sold-it.mjs";
import cardEbay from "../cards/rc-card-ebay-seller-decides.mjs";
import cardCostco from "../cards/rc-card-costco-satisfaction-guaranteed.mjs";

// El registro. Anadir una ficha = anadir su fichero y una linea aqui.
const FICHAS = [cardTarget, cardEbay, cardCostco];

export const CARDS = new Map(FICHAS.map((c) => [c.card_id, c]));

const ID_VALIDO = /^[a-z0-9][a-z0-9-]{2,79}$/;

// ---------------------------------------------------------------------------
// LA PUERTA
// ---------------------------------------------------------------------------

// Una ficha es publicable si alguien la marco a mano Y ademas esta completa.
//
// Las dos condiciones, no una. `published: true` es la decision de Miguel; la
// integridad es lo que impide que esa decision publique una ficha a medias. Un
// `clause` vacio es una cita que no existe, y una ficha de evidencia sin cita es
// justo lo contrario de lo que decimos ser.
//
// Falla CERRADO y en silencio hacia fuera (404, nunca un borrador), y RUIDOSO hacia
// dentro: hay una prueba que recorre el registro entero y dice que le falta a cada
// ficha incompleta. Se entera uno en `npm test`, no un lector en produccion.
export function motivosNoPublicable(card) {
  const faltan = [];
  if (!card || typeof card !== "object") return ["no es una ficha"];
  if (!ID_VALIDO.test(String(card.card_id || ""))) faltan.push("card_id");
  if (!card.question) faltan.push("question");
  if (!card.page || !card.page.title) faltan.push("page.title");
  if (!card.source_url) faltan.push("source_url");
  if (!card.verified_on) faltan.push("verified_on");
  if (!Array.isArray(card.outcomes) || !card.outcomes.length) faltan.push("outcomes");
  else
    card.outcomes.forEach((o, i) => {
      if (!o.clause || !String(o.clause).trim()) faltan.push(`outcomes[${i}].clause`);
      if (!o.source_url) faltan.push(`outcomes[${i}].source_url`);
      if (!o.verified_on) faltan.push(`outcomes[${i}].verified_on`);
    });
  (card.denials || []).forEach((d, i) => {
    if (!(d.clause && String(d.clause).trim()) && !(d.note && String(d.note).trim()))
      faltan.push(`denials[${i}]: sin clause ni note`);
  });
  return faltan;
}

export function esPublicable(card) {
  return card.published === true && motivosNoPublicable(card).length === 0;
}

// Solo devuelve la ficha si se puede publicar. Lo demas, undefined -> 404.
export function fichaPublicada(cardId) {
  if (!ID_VALIDO.test(String(cardId || ""))) return undefined;
  const c = CARDS.get(cardId);
  return c && esPublicable(c) ? c : undefined;
}

// Se recorre CARDS y no FICHAS a proposito: el registro es UNO. Si el indice
// mirase una lista y la ruta otra, podrian dejar de coincidir — que es la misma
// clase de error que evita gemeloJson() entre las dos caras de una ficha.
export function fichasPublicadas() {
  return [...CARDS.values()].filter(esPublicable);
}

// ---------------------------------------------------------------------------
// LA FUENTE UNICA: el gemelo JSON
// ---------------------------------------------------------------------------

// Este objeto es la ficha. La pagina HTML es una forma de leerlo; /cards/{id}.json
// es la otra. Nada de lo que se ve en la pagina se escribe dos veces.
export function gemeloJson(card, base) {
  const salida = {
    card_id: card.card_id,
    merchant: card.merchant,
    country: card.country,
    question: card.question,
    answer: card.answer,
    depends_on: card.depends_on || [],
    outcomes: card.outcomes.map((o) => {
      const fila = {};
      // SIN `days` CUANDO LA CLAUSULA NO DA UN NUMERO. En eBay («lo decide el
      // vendedor») y en Costco («sin plazo») no hay cifra que dar, y un 0 o un null
      // se leerian como "cero dias" o como un fallo. Ausente significa: la politica
      // no lo dice. Y `basis` se cae con el, porque contar desde algo exige contar.
      if (o.days !== null && o.days !== undefined) {
        fila.days = o.days;
        fila.basis = o.basis;
      }
      fila.when = o.when;
      fila.conditions = o.conditions || [];
      fila.clause = o.clause;
      return fila;
    }),
    denials: (card.denials || []).map((d) => {
      const fila = { scope: d.scope };
      // Una nota NO es una cita. Va en su propio campo para que un agente no pueda
      // confundir nuestra descripcion con las palabras del comercio.
      if (d.clause) fila.clause = d.clause;
      else fila.note = d.note;
      return fila;
    }),
    source_url: card.source_url,
    verified_on: card.verified_on,
    warning: `Verified on ${card.verified_on}; policies may change.`,
    check_endpoint: base ? base + "/v1/check" : "/v1/check",
  };
  return salida;
}

// El mismo texto exacto que se imprime en la pagina y que se sirve en la ruta .json.
// Con sangria: quien abre el JSON tambien lo lee.
function gemeloTexto(card, base) {
  return JSON.stringify(gemeloJson(card, base), null, 2);
}

// ---------------------------------------------------------------------------
// Pagina HTML
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// JSON dentro de <script>: hay que cerrar la puerta a </script> en un dato.
function jsonParaScript(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

const TONO = { allow: "a", limit: "b", deny: "c" };

const ESTILO = `
:root{
  --paper:#FBFAF7; --card:#FFFFFF; --rule:#DCD6CC;
  --ink:#1A1A17; --ink-soft:#5C574E; --ink-faint:#8B857A;
  --allow:#2C5F45; --limit:#8A5A12; --deny:#8C3A2E; --link:#1F4E79;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);
  font:400 17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  padding:36px 20px 80px}
.sheet{max-width:760px;margin:0 auto}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
.brand{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:26px}
.brand a{color:inherit;text-decoration:none}
.brand a:hover{color:var(--ink-soft)}
h1{font-family:"Newsreader",Georgia,serif;font-weight:500;
  font-size:clamp(30px,5.2vw,44px);line-height:1.15;letter-spacing:-.015em;margin-bottom:16px}
.answer{font-family:"Newsreader",Georgia,serif;font-size:21px;line-height:1.45;
  color:var(--ink-soft);border-left:3px solid var(--limit);padding-left:18px;margin-bottom:38px}
h2{font-family:"Newsreader",Georgia,serif;font-weight:600;font-size:15px;
  letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin:38px 0 16px}
.case{background:var(--card);border:1px solid var(--rule);padding:20px 22px;margin-bottom:12px}
.case .top{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;margin-bottom:10px}
.case .days{font-family:"Newsreader",serif;font-size:30px;font-weight:600;line-height:1}
.case .when{font-size:15px;color:var(--ink-soft)}
.case.a .days{color:var(--allow)} .case.b .days{color:var(--limit)} .case.c .days{color:var(--deny)}
.cond{font-size:15px;color:var(--ink-soft);margin-bottom:14px}
blockquote{font-family:"Newsreader",Georgia,serif;font-size:18px;font-style:italic;
  color:var(--ink);border-left:2px solid var(--rule);padding-left:14px;margin-bottom:10px}
.src{font-size:13px;color:var(--ink-faint)}
.src a{color:var(--link);text-decoration:none;border-bottom:1px solid var(--rule)}
.src a:hover{border-bottom-color:var(--link)}
.never{background:var(--card);border:1px solid var(--rule);
  border-left:3px solid var(--deny);padding:18px 22px;margin-bottom:12px}
.never .lab{font-size:14px;font-weight:600;color:var(--deny);margin-bottom:8px}
.example{background:#F4F1EA;border:1px solid var(--rule);padding:20px 22px;margin-bottom:12px}
.example .q{font-family:"Newsreader",serif;font-size:19px;margin-bottom:10px}
.example .a{font-size:16px;color:var(--ink-soft)}
.cta{background:var(--ink);color:var(--paper);padding:26px;margin:38px 0 12px}
.cta h3{font-family:"Newsreader",serif;font-weight:500;font-size:22px;margin-bottom:8px}
.cta p{font-size:15px;color:#C9C3B8;margin-bottom:16px}
.cta a{display:inline-block;background:var(--paper);color:var(--ink);
  padding:10px 20px;text-decoration:none;font-size:15px;font-weight:600}
.cta a:hover{background:#fff}
.cta a:focus-visible{outline:2px solid var(--limit);outline-offset:3px}
.twin{border:1px solid var(--rule);background:var(--card);padding:20px 22px}
.twin .lab{font-size:14px;color:var(--ink-soft);margin-bottom:12px}
.twin .lab a{color:var(--link)}
pre{font-family:"IBM Plex Mono",monospace;font-size:12.5px;line-height:1.55;
  overflow-x:auto;color:var(--ink-soft);background:#F7F5F0;padding:14px;border:1px solid var(--rule)}
.stamp{margin-top:34px;padding-top:18px;border-top:1px solid var(--rule);
  font-size:13.5px;color:var(--ink-faint);line-height:1.7}
.stamp strong{color:var(--ink-soft);font-weight:600}
.list{background:var(--card);border:1px solid var(--rule);padding:20px 22px;margin-bottom:12px}
.list h3{font-family:"Newsreader",serif;font-weight:600;font-size:21px;margin-bottom:8px}
.list h3 a{color:var(--ink);text-decoration:none}
.list h3 a:hover{color:var(--link)}
.list .q{font-size:15px;color:var(--ink-soft);margin-bottom:10px}
`;

const CABEZA_FUENTES =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">';

function envuelve({ title, description, canonical, alternateJson, jsonld, cuerpo }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
${alternateJson ? `<link rel="alternate" type="application/json" href="${esc(alternateJson)}">` : ""}
${CABEZA_FUENTES}
<style>${ESTILO}</style>
${jsonld ? `<script type="application/ld+json">${jsonParaScript(jsonld)}</script>` : ""}
</head>
<body>
<div class="sheet">
${cuerpo}
</div>
</body>
</html>`;
}

// Marcado estructurado de UNA ficha. Article: esto es un articulo nuestro SOBRE una
// politica ajena, con su fuente citada en isBasedOn y la organizacion de la que
// habla en `about`. Deliberadamente NO MerchantReturnPolicy.
function articleJsonLd(card, base) {
  const url = base + "/cards/" + card.card_id;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": url,
    identifier: card.card_id,
    headline: card.page.title,
    description: card.page.meta_description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    datePublished: card.verified_on,
    dateModified: card.verified_on,
    isBasedOn: card.source_url,
    about: { "@type": "Organization", name: card.merchant_name },
    author: { "@type": "Organization", name: "ReturnCheck", url: base || undefined },
    publisher: { "@type": "Organization", name: "ReturnCheck", url: base || undefined },
    inLanguage: "en",
    isAccessibleForFree: true,
  };
}

// El dominio se saca de la propia URL de la fuente, no de un campo aparte: asi no
// puede haber una ficha que diga "target.com" y enlace a otro sitio.
function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function bloqueOutcome(o) {
  const clase = TONO[o.tone] || "a";
  const cifra = o.days === null || o.days === undefined ? "—" : String(o.days);
  const fuente = `<a href="${esc(o.source_url)}" rel="nofollow noopener">${esc(o.source_label || "source")}</a>`;
  return `<div class="case ${clase}">
  <div class="top"><span class="days">${esc(cifra)}</span><span class="when">${esc(o.when_long || o.when)}</span></div>
  ${o.conditions_text ? `<div class="cond">${esc(o.conditions_text)}</div>` : ""}
  <blockquote>"${esc(o.clause)}"</blockquote>
  <div class="src">${esc(host(o.source_url))} — ${fuente} · verified ${esc(o.verified_on)}</div>
</div>`;
}

function bloqueDenial(d) {
  // La cita va entre comillas; la nota, NO. Es la misma distincion que en el gemelo
  // JSON: lo que dijo el comercio y lo que decimos nosotros no se mezclan.
  const cuerpo = d.clause
    ? `<blockquote>"${esc(d.clause)}"</blockquote>`
    : `<div class="cond">${esc(d.note)}</div>`;
  return `<div class="never">
  <div class="lab">${esc(d.label || d.scope)}</div>
  ${cuerpo}
  <div class="src">${esc(d.source_label || "")} · verified ${esc(d.verified_on)}</div>
</div>`;
}

export function paginaFicha(card, base) {
  const p = card.page;
  const urlJson = base + "/cards/" + card.card_id + ".json";
  const cuerpo = `
<div class="brand"><a href="${esc(base)}/cards">ReturnCheck · Evidence Card</a></div>

<h1>${esc(p.title)}</h1>

<p class="answer">${esc(p.lede)}</p>

<h2>${esc(p.outcomes_heading || "The windows")}</h2>
${card.outcomes.map(bloqueOutcome).join("\n")}

${
  (card.denials || []).length
    ? `<h2>${esc(p.denials_heading || "Where the window disappears")}</h2>\n` +
      card.denials.map(bloqueDenial).join("\n")
    : ""
}

${
  p.example
    ? `<h2>What this looks like in practice</h2>
<div class="example">
  <div class="q">${esc(p.example.q)}</div>
  <div class="a">${esc(p.example.a)}</div>
</div>`
    : ""
}

<div class="cta">
  <h3>Check your exact purchase</h3>
  <p>Product URL, buyer country, item condition. One verified answer, with the merchant's
  clause quoted and dated. We return UNKNOWN instead of guessing, and UNKNOWN is free.</p>
  <a href="${esc(base)}/">Try ReturnCheck</a>
</div>

<div class="twin">
  <div class="lab">The same card, for machines — stable id <span class="mono">${esc(card.card_id)}</span> ·
  <a href="${esc(urlJson)}">${esc(urlJson)}</a></div>
<pre>${esc(gemeloTexto(card, base))}</pre>
</div>

<p class="stamp">
<strong>Verified on ${esc(card.verified_on)}. Policies change — check the source before relying on this.</strong><br>
Every clause above is quoted from ${esc(card.merchant_name)}'s own published policy, with the page it came from
and the date we read it. We do not paraphrase merchant policy, and we do not fill gaps with
assumptions: where the policy does not say, we say so.<br>
ReturnCheck is independent and not affiliated with ${esc(card.merchant_name)}.
</p>`;

  return envuelve({
    title: p.meta_title || p.title,
    description: p.meta_description || "",
    canonical: base + "/cards/" + card.card_id,
    alternateJson: urlJson,
    jsonld: articleJsonLd(card, base),
    cuerpo,
  });
}

// ---------------------------------------------------------------------------
// Indice
// ---------------------------------------------------------------------------

export function paginaIndice(base) {
  const fichas = fichasPublicadas();
  const cuerpo = `
<div class="brand">ReturnCheck · Evidence Cards</div>
<h1>Return policies, quoted and dated</h1>
<p class="answer">One page per question people actually ask. Every answer carries the
merchant's own clause, the page it came from, and the day we read it. Each card exists
twice: this page for you, and the same data as JSON for an agent.</p>
<h2>${fichas.length} published</h2>
${
  fichas.length
    ? fichas
        .map(
          (c) => `<div class="list">
  <h3><a href="${esc(base)}/cards/${esc(c.card_id)}">${esc(c.page.title)}</a></h3>
  <div class="q">${esc(c.question)}</div>
  <div class="src">${esc(c.merchant_name)} · ${esc(c.country)} · verified ${esc(c.verified_on)} ·
  <a href="${esc(base)}/cards/${esc(c.card_id)}.json">JSON</a></div>
</div>`
        )
        .join("\n")
    : `<div class="list"><div class="q">No cards published yet.</div></div>`
}
<p class="stamp">
<strong>Every card is reviewed by hand before it is published.</strong><br>
A card with a missing clause is not served at all. ReturnCheck is independent and not
affiliated with any of the merchants named here.
</p>`;

  return envuelve({
    title: "Evidence Cards — return policies quoted and dated — ReturnCheck",
    description:
      "One page per return-policy question, answered with the merchant's own clause, its source URL and the date it was verified. Readable by people and by agents.",
    canonical: base + "/cards",
    alternateJson: base + "/cards.json",
    jsonld: {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: "ReturnCheck Evidence Cards",
      description:
        "Verified return-policy clauses for named merchants, each with source URL and verification date. Published as HTML pages and as JSON under the same stable identifiers.",
      url: base + "/cards",
      creator: { "@type": "Organization", name: "ReturnCheck", url: base || undefined },
      isAccessibleForFree: true,
      distribution: fichas.map((c) => ({
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: base + "/cards/" + c.card_id + ".json",
      })),
    },
    cuerpo,
  });
}

export function indiceJson(base) {
  const fichas = fichasPublicadas();
  return {
    cards: fichas.map((c) => ({
      card_id: c.card_id,
      merchant: c.merchant,
      country: c.country,
      question: c.question,
      title: c.page.title,
      verified_on: c.verified_on,
      html_url: base + "/cards/" + c.card_id,
      json_url: base + "/cards/" + c.card_id + ".json",
    })),
    count: fichas.length,
    note: "Free, no authentication. Each card is the same data in HTML and JSON under one stable card_id.",
  };
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

// Solo las URLs publicadas, y solo las paginas: un sitemap es para lo que se indexa.
// El gemelo JSON se descubre desde la propia pagina (<link rel="alternate">) y desde
// /llms.txt, que es donde miran los agentes.
export function sitemap(base) {
  const urls = [
    { loc: base + "/cards", lastmod: null },
    ...fichasPublicadas().map((c) => ({
      loc: base + "/cards/" + c.card_id,
      lastmod: c.verified_on,
    })),
  ];
  const cuerpo = urls
    .map(
      (u) =>
        `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}</url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${cuerpo}
</urlset>
`;
}

// 404 de ficha. Es una pagina, no un volcado JSON: quien llega aqui es una persona
// que siguio un enlace. Y dice 404 de verdad — una ficha sin publicar no asoma ni
// como borrador ni como "proximamente".
export function pagina404(base) {
  return envuelve({
    title: "Card not found — ReturnCheck",
    description: "No published evidence card at this address.",
    cuerpo: `<div class="brand"><a href="${esc(base)}/cards">ReturnCheck · Evidence Card</a></div>
<h1>No card here</h1>
<p class="answer">There is no published evidence card at this address.
<a href="${esc(base)}/cards">See the published cards</a>.</p>`,
  });
}
