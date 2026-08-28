// W43 — LA PROMESA QUE HACEMOS A UN AGENTE, FIJADA CON PRUEBAS.
//
// POR QUÉ ESTO ES UNA PRUEBA Y NO UN COMENTARIO. Un texto de marketing no suele
// probarse, y por eso se pudre: nadie se entera cuando deja de ser cierto. El
// nuestro dejó de serlo el 28 de agosto a las 09:36, cuando la sonda de
// adquisición midió que por la vía que anunciábamos como principal —«mándanos una
// URL»— acertamos 17 de 50 tiendas reales.
//
// Prometer lo que se falla dos de cada tres veces es la forma más cara de perder
// a un agente: la primera llamada se gasta una sola vez, y el que se lleva un
// UNKNOWN no vuelve.
//
// Estas pruebas fijan tres cosas en los cinco sitios donde hablamos con máquinas:
//   1. que `page_text` se recomienda, no se esconde como opcional
//   2. que la cobertura se publica MEDIDA y con fecha, no adjetivada
//   3. que el ejemplo que copiará un desarrollador ya la incluye
//
// Si alguien reescribe estos textos y se lleva por delante la honestidad, salta
// aquí y no en una nota pública de alguien que probó el servicio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL } from "../src/mcp.mjs";
import { llmsTxt, agentsJson, aiPluginJson } from "../src/index.mjs";

const ENV = { PUBLIC_BASE_URL: "https://returncheck.example", PRICE_USD: "0.02" };
const texto = async (r) => await r.text();

test("MCP: la herramienta RECOMIENDA mandar la página, no la esconde", () => {
  assert.match(TOOL.description, /BEST RESULTS/);
  assert.match(TOOL.description, /page_text/);
  // Y el campo ya no se presenta como un extra prescindible.
  assert.match(TOOL.inputSchema.properties.page_text.description, /RECOMMENDED/);
  assert.doesNotMatch(TOOL.inputSchema.properties.page_text.description, /^Optional/);
});

test("MCP: la cobertura va con NÚMERO y FECHA, no con adjetivos", () => {
  // "best coverage" no es una afirmacion comprobable. "17 de 50, medido el
  // 2026-08-28" si lo es, y es lo que le exigimos al motor en cada veredicto.
  assert.match(TOOL.description, /17 of 50/);
  assert.match(TOOL.description, /2026-08-28/);
});

test("MCP: sigue diciendo que no inventa, que es lo que nos distingue", () => {
  assert.match(TOOL.description, /[Nn]ever invents/);
  assert.match(TOOL.description, /UNKNOWN/);
});

test("llms.txt: publica la cobertura medida y el tamaño de la muestra", async () => {
  const t = await texto(llmsTxt(ENV));
  assert.match(t, /Coverage, measured/);
  assert.match(t, /50 US retailers/);
  assert.match(t, /17 of 50/);
  assert.match(t, /2026-08-28/);
  // Y dice lo desagradable: que hay quien nos cierra la puerta.
  assert.match(t, /403/);
});

test("llms.txt: EL EJEMPLO ya manda la página", async () => {
  // Es el trozo que un desarrollador copia y pega. Si el ejemplo no la lleva, da
  // igual lo que digan los parrafos de arriba: la integracion nace mal.
  const t = await texto(llmsTxt(ENV));
  const ejemplo = t.slice(t.indexOf("## Example"));
  assert.match(ejemplo, /page_text/);
});

test("agents.json: la cobertura es un CAMPO, no una frase suelta", async () => {
  // Un agente que elige a quien llamar merece leerlo como dato, no interpretarlo
  // de una descripcion en prosa.
  const d = JSON.parse(await texto(agentsJson(ENV)));
  const flujo = d.flows[0];
  assert.deepEqual(flujo.recommended, ["page_text", "page_html"]);
  assert.equal(flujo.coverage.measured_on, "2026-08-28");
  assert.match(flujo.coverage.without_page_supplied, /17 of 50/);
  assert.ok(flujo.coverage.with_page_supplied);
  // Y ya no aparece entre los "por si acaso".
  assert.ok(!flujo.optional.includes("page_text"));
});

test("ai-plugin.json: el modelo que nos lea sabrá cómo llamarnos bien", async () => {
  const m = JSON.parse(await texto(aiPluginJson(ENV)));
  assert.match(m.description_for_model, /strongly recommended/i);
  assert.match(m.description_for_model, /17 of 50/);
  assert.match(m.description_for_model, /NEVER invents/);
});

test("NINGÚN texto promete que leemos la web por ti", async () => {
  // La frase que la medicion desmintio. Si vuelve, salta.
  const todos = [
    TOOL.description,
    JSON.stringify(TOOL.inputSchema),
    await texto(llmsTxt(ENV)),
    await texto(agentsJson(ENV)),
    await texto(aiPluginJson(ENV)),
  ].join("\n");
  assert.doesNotMatch(todos, /best coverage/i,
    "«best coverage» es un adjetivo sin medida: se sustituyó por el número real");
});
