import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const BASE = "https://rc.example";
const PATH = "/cards/rc-card-ebay-seller-decides";
const get = (suffix = "") => worker.fetch(new Request(BASE + PATH + suffix), { PUBLIC_BASE_URL: BASE });

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
  assert.match(html, /2026-08-20/); // No nueva fecha de verificacion inventada.
});
