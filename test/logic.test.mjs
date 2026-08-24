import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRequest, checkInvariants } from "../src/contract.mjs";
import { applyDeadline } from "../src/decision.mjs";
import { chargeAtomic, markFree } from "../src/billing.mjs";
import { addDays, normalizeUrl, newApiKey } from "../src/util.mjs";
import { cacheKey, clauseInText, clauseSupportsVerdict, focusPolicyText, MAX_POLICY_CHARS,
         policyKeywordHits, policyLinkCandidates, guessedPolicyUrls,
         clauseIsJurisdictionConditional, policyDefersToSeller,
         clausePositiveButUnverifiedForOpenedItem } from "../src/text.mjs";
import { extractLdBlocks, findReturnPolicy, verdictFromCategory } from "../src/jsonld.mjs";

// ---------- Validación de entrada ----------
test("request válida pasa", () => {
  const r = validateRequest({ product_url: "https://x.com/p/1", buyer_country: "US", item_condition: "unopened" });
  assert.equal(r.ok, true);
});
test("rechaza sin product_url y país mal formado", () => {
  assert.equal(validateRequest({ buyer_country: "US" }).ok, false);
  assert.equal(validateRequest({ product_url: "https://x.com", buyer_country: "usa" }).ok, false);
  assert.equal(validateRequest({ product_url: "not-a-url", buyer_country: "US" }).ok, false);
});

// ---------- Invariantes de salida ----------
test("UNKNOWN exige policy/evidence null y reason", () => {
  const good = { schema_version: "1.0", verdict: "UNKNOWN", returnable: null, policy: null, evidence: null, reason: "x" };
  assert.equal(checkInvariants(good).ok, true);
  const bad = { ...good, policy: {} };
  assert.equal(checkInvariants(bad).ok, false);
});
test("veredicto determinante exige policy+evidence con fuente", () => {
  const base = { schema_version: "1.0", verdict: "NO", returnable: false,
    policy: { return_category: "NotPermitted" },
    evidence: { source_url: "u", exact_clause: "c", verified_on: "2026-08-22", policy_version: "abc" } };
  assert.equal(checkInvariants(base).ok, true);
  const noEv = { ...base, evidence: null };
  assert.equal(checkInvariants(noEv).ok, false);
});

// ---------- Fecha límite / ventana vencida ----------
test("recomputa deadline y NO flipea si sigue en ventana", () => {
  const resp = { verdict: "YES_WITH_CONDITIONS", returnable: true, policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, deadline_date: null } };
  const out = applyDeadline(structuredClone(resp), { purchase_date: "2026-08-01" }, "2026-08-10");
  assert.equal(out.policy.deadline_date, "2026-08-31");
  assert.equal(out.verdict, "YES_WITH_CONDITIONS");
});
test("ventana vencida flipea a NO", () => {
  const resp = { verdict: "YES_WITH_CONDITIONS", returnable: true, policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, deadline_date: null } };
  const out = applyDeadline(structuredClone(resp), { purchase_date: "2026-06-01" }, "2026-08-10");
  assert.equal(out.verdict, "NO");
  assert.equal(out.returnable, false);
});
test("deadline cuenta desde delivery_date si existe (no desde purchase_date)", () => {
  const resp = { verdict: "YES_WITH_CONDITIONS", returnable: true, policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, deadline_date: null } };
  // Compra el 1-jul pero entrega el 1-ago -> deadline debe ser 31-ago, no 31-jul.
  const out = applyDeadline(structuredClone(resp), { purchase_date: "2026-07-01", delivery_date: "2026-08-01" }, "2026-08-10");
  assert.equal(out.policy.deadline_date, "2026-08-31");
  assert.equal(out.verdict, "YES_WITH_CONDITIONS"); // sigue en ventana gracias a la entrega
});

// ---------- Verificación LITERAL de la cita (nunca inventar) ----------
test("clauseInText acepta cita presente y rechaza cita ausente", () => {
  const page = "Our Returns Policy: items may be returned within 30 days of delivery for a full refund.";
  assert.equal(clauseInText("returned within 30 days of delivery", page), true);
  // Distinta puntuación/comillas y mayúsculas: se normaliza igual.
  assert.equal(clauseInText('“Returned within 30 DAYS of delivery”', page), true);
  // Cita que el modelo se ha inventado (no está en la página): se rechaza.
  assert.equal(clauseInText("returned within 90 days for store credit", page), false);
});
test("clauseInText acepta paráfrasis de borde si hay un tramo largo literal (caso Apple)", () => {
  const page = "You can return or exchange it with a receipt within 14 days of the date you receive the product from Apple.";
  // El modelo cambia el borde pero conserva un tramo largo literal de la página.
  const paraphrased = "Per policy, you can return or exchange it with a receipt within 14 days of receipt.";
  assert.equal(clauseInText(paraphrased, page), true);
  // Una cita totalmente distinta (sin tramo literal largo) -> rechazada.
  assert.equal(clauseInText("Returns accepted within ninety days for any reason whatsoever", page), false);
});
test("clauseInText rechaza citas demasiado cortas o vacías", () => {
  assert.equal(clauseInText("30 days", "returned within 30 days"), false); // < 12 chars
  assert.equal(clauseInText("", "algo"), false);
  assert.equal(clauseInText("returned within 30 days", ""), false);
});

// ---------- La cita debe SOSTENER el veredicto (fallos reales Allbirds/Olipop) ----------
test("clauseSupportsVerdict rechaza citas de ENVÍOS (caso Allbirds/Olipop)", () => {
  // Estos son los fallos que vimos en producción: citaba una frase de envíos.
  assert.equal(clauseSupportsVerdict("Free ground shipping on orders over $100", { verdict: "YES" }), false);
  assert.equal(clauseSupportsVerdict("Orders $50+ ship FREE", { verdict: "YES_WITH_CONDITIONS", days: 30 }), false);
});
test("clauseSupportsVerdict exige que el nº de días esté en la cita", () => {
  assert.equal(clauseSupportsVerdict("Items may be returned within 30 days.", { verdict: "YES_WITH_CONDITIONS", days: 30 }), true);
  assert.equal(clauseSupportsVerdict("Items may be returned within 30 days.", { verdict: "YES_WITH_CONDITIONS", days: 14 }), false);
});
test("clauseSupportsVerdict exige frase negativa para NO / NotPermitted", () => {
  assert.equal(clauseSupportsVerdict("All sales are final for this item.", { verdict: "NO", category: "NotPermitted" }), true);
  // Un 'NO' citando una cláusula que NO es negativa -> no vale.
  assert.equal(clauseSupportsVerdict("Items may be returned within 30 days.", { verdict: "NO" }), false);
});
test("clauseSupportsVerdict acepta ventana ilimitada si habla de devoluciones", () => {
  assert.equal(clauseSupportsVerdict("You may return items at any time for a refund.", { verdict: "YES", days: null }), true);
});

// ---------- Enfoque del texto de política (arregla el corte a 8000) ----------
test("focusPolicyText devuelve el texto tal cual si cabe", () => {
  const short = "return within 30 days";
  assert.equal(focusPolicyText(short), short);
});
test("focusPolicyText captura la sección de política aunque esté muy al final", () => {
  const filler = "lorem ipsum ".repeat(2000); // >> MAX_POLICY_CHARS, sin palabras clave
  const clause = "Items may be returned within 30 days of delivery for a full refund.";
  const text = filler + clause + filler;
  const focused = focusPolicyText(text);
  assert.ok(focused.length <= MAX_POLICY_CHARS);
  assert.ok(focused.includes("returned within 30 days of delivery"),
    "la ventana debe incluir la cláusula de devolución");
});

// ---------- Clave de caché: no mezclar contextos ----------
test("cacheKey separa por país, comerciante y vendedor", () => {
  const base = { product_url: "https://a.com/p?id=5", buyer_country: "US" };
  const us = cacheKey(base);
  const es = cacheKey({ ...base, buyer_country: "ES" });
  assert.notEqual(us, es); // distinto país -> distinta clave
  const seller = cacheKey({ ...base, seller_name: "ThirdPartyLLC" });
  assert.notEqual(us, seller); // distinto vendedor (marketplace) -> distinta clave
  // Misma petición (con basura de URL normalizada) -> misma clave.
  assert.equal(cacheKey({ product_url: "https://a.com/p?utm_source=x&id=5#f", buyer_country: "US" }), us);
});

// ---------- Utilidades ----------
test("addDays y normalizeUrl", () => {
  assert.equal(addDays("2026-08-01", 30), "2026-08-31");
  assert.equal(normalizeUrl("https://a.com/p?utm_source=x&id=5#frag"), "https://a.com/p?id=5");
});
test("newApiKey formato", () => {
  assert.match(newApiKey(), /^rc_live_[0-9a-f]{48}$/);
});

// ---------- Datos estructurados schema.org (JSON-LD) ----------
test("extrae MerchantReturnPolicy anidada en Product (hasMerchantReturnPolicy)", () => {
  const html = `<html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Shoe",
     "offers":{"@type":"Offer","hasMerchantReturnPolicy":{
       "@type":"MerchantReturnPolicy",
       "returnPolicyCategory":"https://schema.org/MerchantReturnFiniteReturnWindow",
       "merchantReturnDays":30,"applicableCountry":"US","returnFees":"https://schema.org/FreeReturn"}}}
    </script></head><body>x</body></html>`;
  const ld = findReturnPolicy(extractLdBlocks(html));
  assert.ok(ld, "debe encontrar la política");
  assert.equal(ld.policy.return_category, "FiniteReturnWindow");
  assert.equal(ld.policy.merchant_return_days, 30);
  assert.equal(verdictFromCategory(ld.policy.return_category), "YES_WITH_CONDITIONS");
});
test("detecta NotPermitted -> NO", () => {
  const html = `<script type="application/ld+json">{"@type":"MerchantReturnPolicy","returnPolicyCategory":"MerchantReturnNotPermitted"}</script>`;
  const ld = findReturnPolicy(extractLdBlocks(html));
  assert.equal(ld.policy.return_category, "NotPermitted");
  assert.equal(verdictFromCategory("NotPermitted"), "NO");
});
test("ignora JSON-LD roto y páginas sin política", () => {
  assert.equal(findReturnPolicy(extractLdBlocks(`<script type="application/ld+json">{roto,,}</script>`)), null);
  assert.equal(findReturnPolicy(extractLdBlocks(`<script type="application/ld+json">{"@type":"Product","name":"x"}</script>`)), null);
  assert.equal(findReturnPolicy(extractLdBlocks("<html>sin json</html>")), null);
});

// ---------- COBRO ATÓMICO (el bug que arreglamos) ----------
// D1 falso: un solo saldo. El UPDATE con guarda WHERE balance>=coste replica
// la semántica atómica de SQLite (changes=1 solo si había saldo).
function fakeDB(initialBalance) {
  const state = { balance: initialBalance, charged: 0, free: 0 };
  return {
    _state: state,
    prepare(sql) {
      return {
        _sql: sql, _args: [],
        bind(...a) { this._args = a; return this; },
        async run() {
          if (/UPDATE clients SET balance_usd = balance_usd - \?1/.test(this._sql)) {
            const amount = this._args[0];
            if (state.balance >= amount) { state.balance -= amount; state.charged++; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/calls_free = calls_free \+ 1/.test(this._sql)) { state.free++; return { meta: { changes: 1 } }; }
          if (/INSERT INTO ledger/.test(this._sql)) return { meta: { changes: 1 } };
          return { meta: { changes: 0 } };
        },
        async first() {
          if (/SELECT balance_usd FROM clients/.test(this._sql)) return { balance_usd: state.balance };
          return null;
        },
      };
    },
  };
}

test("cobro atómico descuenta una vez y devuelve saldo", async () => {
  const env = { DB: fakeDB(0.02) };
  const r = await chargeAtomic(env, "k", 0.02, "ref");
  assert.equal(r.charged, true);
  assert.equal(Math.round(r.remaining * 1000) / 1000, 0);
});

test("NO permite sobregiro: dos cobros con saldo para uno -> el segundo falla", async () => {
  const env = { DB: fakeDB(0.02) };
  const a = await chargeAtomic(env, "k", 0.02, "r1");
  const b = await chargeAtomic(env, "k", 0.02, "r2");
  assert.equal(a.charged, true);
  assert.equal(b.charged, false);          // <- el saldo nunca queda negativo
  assert.equal(env.DB._state.balance, 0);
  assert.equal(env.DB._state.charged, 1);  // solo se cobró una vez
});

test("markFree no toca saldo", async () => {
  const env = { DB: fakeDB(0.02) };
  await markFree(env, "k");
  assert.equal(env.DB._state.balance, 0.02);
  assert.equal(env.DB._state.free, 1);
});

// ---------- COBERTURA: descubrimiento de página de política ----------
test("policyKeywordHits cuenta señales de política (EN + ES)", () => {
  assert.equal(policyKeywordHits(""), 0);
  assert.equal(policyKeywordHits("Add to cart. Free shipping worldwide."), 0);
  assert.ok(policyKeywordHits("Returns accepted within 30 days. Full refund. Exchange available. Reembolso.") >= 4);
});

test("policyLinkCandidates saca enlaces de política del mismo dominio, ordenados", () => {
  const html = `
    <a href="/cart">Cart</a>
    <a href="/pages/about">About us</a>
    <a href="/policies/refund-policy">Return & Refund Policy</a>
    <a href="/returns">Returns</a>
    <a href="https://otro.com/refund-policy">Otro dominio</a>
    <a href="/blog/refund-story">Historia sobre refund</a>
  `;
  const out = policyLinkCandidates(html, "https://shop.example.com/products/tee");
  // El primero debe ser el refund-policy (score más alto), y todo mismo host.
  assert.equal(out[0], "https://shop.example.com/policies/refund-policy");
  assert.ok(out.every((u) => new URL(u).host === "shop.example.com"));
  // No cuela el dominio externo.
  assert.ok(!out.some((u) => u.includes("otro.com")));
  // Máximo 4.
  assert.ok(out.length <= 4);
});

test("policyLinkCandidates: sin enlaces relevantes -> vacío", () => {
  const html = `<a href="/cart">Cart</a><a href="/login">Login</a>`;
  assert.deepEqual(policyLinkCandidates(html, "https://x.com/p/1"), []);
});

test("guessedPolicyUrls devuelve rutas comunes sobre el origin", () => {
  const g = guessedPolicyUrls("https://shop.example.com/products/tee?variant=1");
  assert.ok(g.includes("https://shop.example.com/policies/refund-policy"));
  assert.ok(g.includes("https://shop.example.com/returns"));
  assert.ok(g.every((u) => u.startsWith("https://shop.example.com/")));
});

test("guessedPolicyUrls con URL inválida -> vacío", () => {
  assert.deepEqual(guessedPolicyUrls("no-es-url"), []);
});

// ---------- Contenido aportado por el agente (page_html / page_text) ----------
test("validateRequest acepta page_text / page_html opcionales", () => {
  const r = validateRequest({ product_url: "https://x.com/p/1", buyer_country: "US", page_text: "Returns within 30 days." });
  assert.equal(r.ok, true);
  assert.equal(r.value.page_text, "Returns within 30 days.");
  const h = validateRequest({ product_url: "https://x.com/p/1", buyer_country: "US", page_html: "<p>Returns within 30 days.</p>" });
  assert.equal(h.ok, true);
  assert.equal(h.value.page_html, "<p>Returns within 30 days.</p>");
});
test("validateRequest rechaza page_html no-string o gigante", () => {
  assert.equal(validateRequest({ product_url: "https://x.com/p/1", buyer_country: "US", page_html: 123 }).ok, false);
  const huge = "a".repeat(4_000_001);
  assert.equal(validateRequest({ product_url: "https://x.com/p/1", buyer_country: "US", page_text: huge }).ok, false);
});

// ---------- SEGURIDAD: cláusula negativa nunca sostiene un veredicto positivo ----------
test("clauseSupportsVerdict: cláusula negativa NO puede apoyar un YES (hueco C02)", () => {
  assert.equal(clauseSupportsVerdict("Final sale items cannot be returned or exchanged for any reason.", { verdict: "YES_WITH_CONDITIONS" }), false);
  assert.equal(clauseSupportsVerdict("This item cannot be returned.", { verdict: "YES" }), false);
  // La misma cláusula negativa SÍ sostiene un NO.
  assert.equal(clauseSupportsVerdict("Final sale items cannot be returned or exchanged for any reason.", { verdict: "NO" }), true);
});


test("validateRequest conserva buyer_state y as_of aditivos", () => {
  const r = validateRequest({
    product_url: "https://x.com/p/1",
    buyer_country: "US",
    buyer_state: "CA",
    as_of: "2026-08-24",
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.buyer_state, "CA");
  assert.equal(r.value.as_of, "2026-08-24");
});

test("validateRequest rechaza buyer_state y as_of mal formados", () => {
  assert.equal(validateRequest({
    product_url: "https://x.com/p/1", buyer_country: "US", buyer_state: "California",
  }).ok, false);
  assert.equal(validateRequest({
    product_url: "https://x.com/p/1", buyer_country: "US", as_of: "24-08-2026",
  }).ok, false);
});

// ---------- SEGURIDAD C09: jurisdicción/ley estatal ----------
test("C09 detecta cláusula condicionada a jurisdicción", () => {
  assert.equal(clauseIsJurisdictionConditional(
    "Returns are not accepted where prohibited by law."
  ), true);
  assert.equal(clauseIsJurisdictionConditional(
    "Eligible items may be returned within 30 days."
  ), false);
});

// ---------- SEGURIDAD W01: política delegada al vendedor ----------
test("W01 detecta 10 formas de delegar la devolución al vendedor", () => {
  const delegated = [
    "Products sold by marketplace partners are governed by the individual seller's return policy.",
    "Third-party sellers set and maintain their own return policies.",
    "Returns are subject to the seller-specific return policy.",
    "Each seller's own policy applies to marketplace purchases.",
    "3rd-party sellers determine their own returns policy.",
    "Marketplace vendors maintain individual refund policies.",
    "Return policies vary by seller for marketplace purchases.",
    "Please check the seller's return policy before buying from a marketplace partner.",
    "Returns for external sellers are governed by the vendor's policy.",
    "Items sold by participating sellers are handled under the seller's specific return policy.",
  ];
  for (const policy of delegated) {
    assert.equal(policyDefersToSeller(policy), true, policy);
  }
});

test("W01 no confunde menciones de terceros con delegación de política", () => {
  const hostPolicyApplies = [
    "Returns are processed by a third-party logistics provider.",
    "All marketplace sellers follow MarketHub's 30-day return policy.",
    "Products sold by MarketHub may be returned within 30 days.",
    "Third-party sellers are eligible for returns within 30 days.",
    "This return policy applies equally to items sold by marketplace sellers.",
  ];
  for (const policy of hostPolicyApplies) {
    assert.equal(policyDefersToSeller(policy), false, policy);
  }
});

// ---------- SEGURIDAD C15: abierto/usado frente a sellado ----------
test("C15 detecta cita positiva que solo cubre artículos sellados", () => {
  const clause = "Factory-sealed items may be returned within 30 days.";
  assert.equal(clausePositiveButUnverifiedForOpenedItem(clause, "opened"), true);
  assert.equal(clausePositiveButUnverifiedForOpenedItem(clause, "used"), true);
  assert.equal(clausePositiveButUnverifiedForOpenedItem(clause, "unopened"), false);
  assert.equal(clausePositiveButUnverifiedForOpenedItem(
    "Opened items are not eligible; factory-sealed items may be returned within 30 days.",
    "opened"
  ), false);
});
