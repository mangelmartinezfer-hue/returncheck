import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.mjs";
import ficha from "../cards/rc-card-ebay-seller-decides.mjs";

const BASE = "https://rc.example";
const PATH = "/cards/rc-card-ebay-seller-decides";
const get = (suffix = "") => worker.fetch(new Request(BASE + PATH + suffix), { PUBLIC_BASE_URL: BASE });

// ---------- las tres citas, literales contra las capturas del 11-oct-2026 ----------
//
// Por que existe esto: la primera cita publicaba «see the seller's full return
// policy» y la pagina dice «... for the seller's full return policy». El verbo
// era nuestro. Nadie lo habia notado porque ninguna prueba cotejaba las citas de
// eBay contra una captura: solo se comprobaba el HTML y el JSON que generamos.
// Esa es la laguna que cierra este bloque, con el mismo criterio que la ficha de
// IKEA. Si alguien retoca una cita para que suene mejor, esto se pone rojo.
const returningItem = readFileSync(
  new URL("./fixtures/ebay-returning-item-2026-10-11.txt", import.meta.url), "utf8");
const moneyBack = readFileSync(
  new URL("./fixtures/ebay-money-back-guarantee-2026-10-11.txt", import.meta.url), "utf8");

// Que captura respalda cada cita, por la fuente que la propia ficha declara.
const capturaDe = (sourceUrl) =>
  sourceUrl.includes("id=4041") ? returningItem
  : sourceUrl.includes("id=4210") ? moneyBack
  : null;

test("eBay: cada cita publicada esta LITERAL en la captura de su fuente", () => {
  assert.equal(ficha.outcomes.length, 3, "la ficha debe seguir teniendo tres ramas");
  for (const o of ficha.outcomes) {
    const captura = capturaDe(o.source_url);
    assert.ok(captura, `fuente sin captura archivada: ${o.source_url}`);
    assert.ok(
      captura.includes(o.clause),
      `la cita no aparece literal en la captura de ${o.source_label}: ${o.clause}`,
    );
  }
});

test("eBay: la cita corregida es el fragmento literal, no la parafrasis", () => {
  const primera = ficha.outcomes[0].clause;
  assert.equal(primera, "for the seller's full return policy");
  assert.ok(returningItem.includes(primera));
  // La parafrasis anterior no puede volver por la puerta de atras.
  assert.ok(!returningItem.includes("see the seller's full return policy"),
    "si la fuente llegara a decir esto, hay que revisar la ficha a mano");
  for (const o of ficha.outcomes) {
    assert.ok(!o.clause.startsWith("see "), `cita con verbo anadido: ${o.clause}`);
  }
});

test("eBay: las tres citas llevan la fecha de la captura que las respalda", () => {
  for (const o of ficha.outcomes) assert.equal(o.verified_on, "2026-10-11");
});

test("eBay: ninguna rama exporta una ventana numerica incompleta", async () => {
  const response = await get(".json");
  assert.equal(response.status, 200);
  const card = await response.json();
  for (const outcome of card.outcomes) {
    assert.equal("days" in outcome, false, outcome.when);
    assert.equal("basis" in outcome, false, outcome.when);
  }
  assert.match(card.outcomes[1].clause, /30 calendar days after the estimated or actual delivery date/);
  assert.match(card.outcomes[1].when, /eligible/i);
  assert.match(card.outcomes[2].when, /eligible/i);
});

test("eBay: HTML conserva el matiz y evita promesas universales", async () => {
  const html = await (await get()).text();
  assert.doesNotMatch(html, /it runs 30 days from delivery|days from delivery —|guarantee overrides|policy stops deciding|when it stops mattering/i);
  assert.doesNotMatch(html, /<span class="days">30<\/span>/);
  assert.match(html, /estimated or actual delivery date/);
  assert.match(html, /eligibility requirements/i);
  assert.match(html, /seller.*longer window/i);
  assert.match(html, /exclusions/i);
  // Recaptura propia del 11-oct-2026, archivada en test/fixtures/. No es una fecha inventada.
  assert.match(html, /2026-10-11/);
});
