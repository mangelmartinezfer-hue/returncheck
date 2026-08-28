// W42 — la sonda de adquisición.
//
// Todo se prueba SIN RED: se sustituye `fetch` global. Así se pueden reproducir a
// voluntad los cuatro casos que en la vida real dependen de la tienda que te toque:
// la que te deja leer, la que te manda una cáscara de JavaScript, la que te cierra
// la puerta, y la que te deja entrar pero no publica política donde miramos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sondearUrl, resumir, RESULTADOS } from "../src/adquisicion.mjs";

const ENV = { USE_BROWSER: "false" };

// Una página con política de sobra: supera el umbral de señales.
const CON_POLITICA = `<html><body>
  <h1>Product</h1>
  <div class="policy">
    <h2>Returns &amp; Refunds</h2>
    <p>Eligible items may be returned within 30 days of delivery for a full refund
    to the original payment method. Items must be unused and in their original
    packaging. To start a return, visit your order history. Refunds are issued to
    the original payment method within 5 business days of receiving the returned
    item. Exchanges are available for items in new condition.</p>
  </div>
</body></html>`;

// Una página de producto normal, sin política: texto de sobra, cero señales.
const SIN_POLITICA = `<html><body><h1>Blue Widget</h1>
  <p>${"A very nice widget for your home. ".repeat(40)}</p></body></html>`;

// Una cáscara de JavaScript: responde 200 y viene practicamente vacia.
const CASCARA = `<html><head><title>Shop</title></head>
  <body><div id="root"></div><script src="/app.js"></script></body></html>`;

// Sustituye fetch: `rutas` mapea url -> { status, body } (o funcion).
function conRed(rutas) {
  const pedidas = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    pedidas.push(u);
    const r = typeof rutas === "function" ? rutas(u) : (rutas[u] ?? rutas.__defecto);
    if (!r) return { ok: false, status: 404, text: async () => "" };
    if (r.revienta) throw Object.assign(new Error("boom"), { name: r.revienta });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body || "" };
  };
  return pedidas;
}

const original = globalThis.fetch;
function restaurar() { globalThis.fetch = original; }

// ---------------------------------------------------------------------------

test("texto_obtenido: la política viene en la propia página de producto", async () => {
  conRed({ "https://tienda.example/p/1": { status: 200, body: CON_POLITICA } });
  const f = await sondearUrl(ENV, "https://tienda.example/p/1");
  restaurar();
  assert.equal(f.resultado, "texto_obtenido");
  assert.equal(f.via, "producto");
  assert.equal(f.http_status, 200);
  assert.ok(f.policy_hits >= 4, `señales: ${f.policy_hits}`);
});

test("texto_obtenido: no venía en producto, se encuentra la página de devoluciones", async () => {
  // Es el camino que mas cobertura da en la vida real: la pagina de producto no
  // dice nada, pero /pages/returns si.
  const pedidas = conRed((u) =>
    u.includes("/p/1") ? { status: 200, body: SIN_POLITICA + '<a href="/pages/returns">Returns</a>' }
                       : { status: 200, body: CON_POLITICA });
  const f = await sondearUrl(ENV, "https://tienda.example/p/1");
  restaurar();
  assert.equal(f.resultado, "texto_obtenido");
  assert.equal(f.via, "pagina_devoluciones");
  assert.ok(f.url_politica, "debe anotar DE DONDE salio la politica");
  assert.ok(pedidas.length > 1, "tuvo que salir a buscar una segunda pagina");
});

test("BLOQUEADO no es lo mismo que NECESITA NAVEGADOR — y ese es el punto", async () => {
  // Los dos acaban sin texto, pero uno lo arregla una variable que ya tenemos y el
  // otro no. Agruparlos daria un numero inutil para decidir.
  for (const codigo of [403, 429, 503, 451]) {
    conRed({ "https://tienda.example/p/1": { status: codigo, body: "" } });
    const f = await sondearUrl(ENV, "https://tienda.example/p/1");
    restaurar();
    assert.equal(f.resultado, "bloqueado", `código ${codigo}`);
    assert.equal(f.http_status, codigo);
  }
});

test("necesita_navegador: responde 200 pero es una cáscara de JavaScript", async () => {
  // El caso mas importante del banco: la pagina EXISTE y nos deja pasar, pero el
  // contenido lo monta el navegador. Es lo que nos devolvio rei.com.
  conRed({ __defecto: { status: 200, body: CASCARA } });
  const f = await sondearUrl(ENV, "https://tienda.example/p/1");
  restaurar();
  assert.equal(f.resultado, "necesita_navegador");
  assert.equal(f.http_status, 200);
  assert.ok(f.text_chars < 600, `caracteres: ${f.text_chars}`);
});

test("necesita_navegador: el fetch se cae del todo y el navegador está apagado", async () => {
  conRed({ __defecto: { revienta: "TypeError" } });
  const f = await sondearUrl(ENV, "https://tienda.example/p/1");
  restaurar();
  assert.equal(f.resultado, "necesita_navegador");
  assert.equal(f.error, "MERCHANT_UNRESOLVED");
});

test("sin_politica: entramos, leemos de sobra, y no hay política donde miramos", async () => {
  // Ni bloqueo ni cascara: hay texto largo y cero señales. Es un problema de
  // DESCUBRIMIENTO, no de acceso, y por eso va en su propio cajon.
  conRed({ __defecto: { status: 200, body: SIN_POLITICA } });
  const f = await sondearUrl(ENV, "https://tienda.example/p/1");
  restaurar();
  assert.equal(f.resultado, "sin_politica");
  assert.equal(f.http_status, 200);
  assert.ok(f.text_chars > 600);
});

test("NUNCA LANZA: pase lo que pase, una url devuelve una fila", async () => {
  // Si una tienda rara tumbara la sonda, perderiamos la medicion entera por una
  // fila. Un fallo es un dato, no una excepcion.
  for (const caso of [{ revienta: "TimeoutError" }, { status: 500, body: "" },
                      { status: 200, body: "" }, { status: 301, body: "" }]) {
    conRed({ __defecto: caso });
    const f = await sondearUrl(ENV, "https://tienda.example/p/1");
    restaurar();
    assert.ok(RESULTADOS.includes(f.resultado), JSON.stringify(caso));
    assert.equal(typeof f.ms, "number");
  }
});

test("se guardan los HECHOS CRUDOS, no solo el veredicto", async () => {
  // Para poder revisar la clasificacion sin volver a salir a la red. Estos dias
  // hemos tenido que revisar clasificaciones mas de una vez.
  conRed({ __defecto: { status: 200, body: CON_POLITICA } });
  const f = await sondearUrl(ENV, "https://tienda.example/p/1");
  restaurar();
  for (const campo of ["url", "resultado", "http_status", "html_bytes", "text_chars", "policy_hits", "ms"])
    assert.notEqual(f[campo], undefined, `falta el campo ${campo}`);
});

test("el resumen da la cifra que decide", async () => {
  const filas = [
    { resultado: "texto_obtenido", ms: 100 }, { resultado: "texto_obtenido", ms: 200 },
    { resultado: "necesita_navegador", ms: 300 }, { resultado: "bloqueado", ms: 400 },
  ];
  const r = resumir(filas);
  assert.equal(r.total, 4);
  assert.equal(r.texto_obtenido, 2);
  assert.equal(r.pct_obtenido, 50);
  assert.equal(r.sin_politica, 0);
});
