// Motor page_parse: caché -> leer página (navegador) -> IA restringida -> ensamblar
// respuesta del contrato -> recomputar fecha límite por petición.

import puppeteer from "@cloudflare/puppeteer";
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, AI_MODEL } from "./prompt.mjs";
import { checkInvariants } from "./contract.mjs";
import { applyDeadline } from "./decision.mjs";
import { todayDate, addDays, sha256hex, normalizeUrl } from "./util.mjs";

class EngineError extends Error {
  constructor(code, http, message) { super(message); this.code = code; this.http = http; }
}

const MAX_POLICY_CHARS = 12000; // techo de tokens de entrada (coste + límites del modelo)

function cacheKey(req) {
  return [normalizeUrl(req.product_url), req.item_condition || "", req.reason || ""].join("|");
}

// Convierte HTML crudo en texto legible (rápido, sin navegador).
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// Lee el texto de la política. HÍBRIDO: 1) fetch plano rápido; 2) si falla o
// la página es una cáscara JS, usa el navegador headless (más lento).
async function fetchPolicyText(env, url) {
  // 1) Intento rápido: petición HTTP normal.
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; ReturnCheckBot/1.0; +https://returncheck.dev)",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (res.ok) {
      const html = await res.text();
      const text = htmlToText(html);
      if (text && text.length > 200) return { text: text.slice(0, MAX_POLICY_CHARS), via: "structured_data" };
    }
  } catch (_) { /* seguimos al navegador */ }

  // 2) Fallback: navegador headless para páginas con mucho JavaScript.
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    const text = await page.evaluate(() => document.body.innerText || "");
    return { text: text.replace(/\s+\n/g, "\n").slice(0, MAX_POLICY_CHARS), via: "page_parse" };
  } catch (e) {
    throw new EngineError("UPSTREAM_TIMEOUT", 504, "Could not load the product/policy page in time.");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Extrae un objeto JSON de la salida del modelo, tolerante a fences y prosa.
function coerceJson(out) {
  let obj = out && (out.response ?? out);
  if (obj && typeof obj === "object") return obj;
  if (typeof obj !== "string") return null;
  let s = obj.trim().replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

// Llama al modelo con decodificación restringida a esquema. Reintenta una vez si
// el modelo no devuelve JSON limpio (endurecido tras ver 500 en producción).
async function extract(env, policyText, req) {
  const userMsg =
    `PRODUCT_URL: ${req.product_url}\n` +
    `REQUEST: ${JSON.stringify({ buyer_country: req.buyer_country, item_condition: req.item_condition || null, reason: req.reason || null })}\n` +
    `TODAY: ${todayDate()}\n` +
    `POLICY TEXT:\n${policyText}`;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMsg },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try {
      out = await env.AI.run(AI_MODEL, {
        messages,
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
        max_tokens: 2048,
      });
    } catch (e) {
      if (attempt === 1) throw new EngineError("UPSTREAM_TIMEOUT", 504, "The extraction model did not respond in time.");
      continue;
    }
    const parsed = coerceJson(out);
    if (parsed && typeof parsed === "object") return parsed;
    messages.push({ role: "user", content: "Your previous output was not valid JSON (it may have been cut off). Output ONLY the JSON object, keep exact_clause short, no prose, no markdown, no code fences." });
  }
  return null; // no reventamos: runCheck lo degrada a UNKNOWN
}

// Ensambla la respuesta completa del contrato a partir de lo que devolvió la IA.
async function assemble(ai, req, policyText, meta) {
  const domainFromUrl = (() => { try { return new URL(req.product_url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const merchant = ai.merchant_resolved || { name: domainFromUrl, domain: domainFromUrl, is_marketplace_third_party: false };
  if (!merchant.domain) merchant.domain = domainFromUrl;
  if (!("seller" in merchant)) merchant.seller = null;
  if (!("country" in merchant)) merchant.country = req.buyer_country || null;

  const determinate = ["YES", "YES_WITH_CONDITIONS", "NO"].includes(ai.verdict);
  const resp = {
    schema_version: "1.0",
    verdict: ai.verdict,
    returnable: ai.verdict === "UNKNOWN" ? null : ai.verdict !== "NO",
    confidence: typeof ai.confidence === "number" ? ai.confidence : (determinate ? 0.8 : 0),
    status: ai.verdict === "UNKNOWN" ? "indeterminate" : "confirmed",
    answer_human: (ai.answer_human || "").slice(0, 300),
    reason: ai.reason ?? null,
    policy: null,
    evidence: null,
    merchant_resolved: merchant,
    meta,
  };

  if (determinate && ai.policy && ai.evidence) {
    resp.policy = {
      return_category: ai.policy.return_category,
      merchant_return_days: ai.policy.merchant_return_days ?? null,
      deadline_date: null, // se recomputa por petición más abajo
      return_country: ai.policy.return_country ?? (req.buyer_country || null),
      applicable_countries: ai.policy.applicable_countries || [],
      return_method: ai.policy.return_method || [],
      return_fees: ai.policy.return_fees ?? null,
      return_shipping_fees_amount: null,
      restocking_fee: ai.policy.restocking_fee ?? null,
      refund_type: ai.policy.refund_type ?? null,
      item_conditions_accepted: ai.policy.item_conditions_accepted || [],
      required_condition: ai.policy.required_condition ?? null,
      exceptions: ai.policy.exceptions || [],
      seasonal_override: null,
    };
    resp.evidence = {
      source_url: ai.evidence.source_url || req.product_url,
      exact_clause: ai.evidence.exact_clause,
      verified_on: todayDate(),
      freshness_days: 0,
      policy_version: await sha256hex(policyText),
    };
  } else if (determinate) {
    // El modelo dio un veredicto sin prueba -> por seguridad, degradar a UNKNOWN.
    resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
    resp.confidence = 0; resp.policy = null; resp.evidence = null;
    resp.reason = resp.reason || "The policy text did not provide a verifiable clause for this case.";
  }

  // Reconciliar categoría con veredicto: si es devolvible no puede ser NotPermitted.
  if (resp.policy && resp.verdict !== "NO" && resp.policy.return_category === "NotPermitted") {
    resp.policy.return_category = resp.policy.merchant_return_days != null ? "FiniteReturnWindow" : "UnlimitedWindow";
  }
  // Texto humano de respaldo si el modelo se queda demasiado corto.
  if (!resp.answer_human || resp.answer_human.trim().length < 12) {
    if (resp.verdict === "NO") resp.answer_human = "No. This item is not returnable under the merchant's published policy for this case.";
    else if (resp.verdict === "UNKNOWN") resp.answer_human = "Unknown. The published policy does not resolve this specific case.";
    else {
      const d = resp.policy && resp.policy.merchant_return_days;
      resp.answer_human = "Yes, with conditions" + (d ? ` — returnable within ${d} days under the merchant's policy.` : " under the merchant's published policy.");
    }
  }
  return resp;
}

// Punto de entrada. Devuelve la respuesta del contrato (verdict UNKNOWN incluido).
export async function runCheck(env, req) {
  const t0 = Date.now();
  const key = cacheKey(req);
  const ttlDays = Number(env.CACHE_TTL_DAYS || "7");

  // 1) Caché
  const cached = await env.DB.prepare(
    "SELECT payload, expires_at FROM policy_cache WHERE cache_key = ?"
  ).bind(key).first().catch(() => null);
  if (cached && cached.expires_at > todayDate()) {
    const resp = JSON.parse(cached.payload);
    resp.meta = { cache_hit: true, response_ms: Date.now() - t0, checked_via: "cache" };
    return applyDeadline(resp, req);
  }

  // 2) Leer página + 3) IA restringida
  const { text: policyText, via } = await fetchPolicyText(env, req.product_url);
  if (!policyText || policyText.length < 40)
    throw new EngineError("MERCHANT_UNRESOLVED", 422, "Could not read a usable policy from the page.");
  const ai = (await extract(env, policyText, req)) || {
    verdict: "UNKNOWN", confidence: 0, policy: null, evidence: null, answer_human: "",
    reason: "The engine could not extract a structured answer from this page.",
  };

  // 4) Ensamblar + invariantes
  const meta = { cache_hit: false, response_ms: Date.now() - t0, checked_via: via };
  const resp = await assemble(ai, req, policyText, meta);
  const inv = checkInvariants(resp);
  if (!inv.ok) throw new EngineError("INTERNAL", 500, "Engine produced an invalid response: " + inv.problems.join("; "));

  // 5) Cachear el extracto (sin deadline por fecha) y recomputar deadline por petición
  const toCache = JSON.parse(JSON.stringify(resp));
  if (toCache.policy) toCache.policy.deadline_date = null;
  env.DB.prepare(
    "INSERT OR REPLACE INTO policy_cache (cache_key, payload, verified_on, expires_at) VALUES (?,?,?,?)"
  ).bind(key, JSON.stringify(toCache), todayDate(), addDays(todayDate(), ttlDays)).run().catch(() => {});

  return applyDeadline(resp, req);
}

export { EngineError };
