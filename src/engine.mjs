// Motor page_parse: caché -> leer página (navegador) -> IA restringida -> ensamblar
// respuesta del contrato -> recomputar fecha límite por petición.

import puppeteer from "@cloudflare/puppeteer";
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, AI_MODEL, inferenceParams } from "./prompt.mjs";
import { checkInvariants } from "./contract.mjs";
import { applyDeadline, missingInputFor, missingInputHint, classifyPositive } from "./decision.mjs";
import { todayDate, addDays, sha256hex, BUILD } from "./util.mjs";
import { cacheKey, htmlToText, focusPolicyText, clauseInText, clauseSupportsVerdict,
  candidateClauses, candidateBlock, pickClause, usableAnswerHuman,
         policyKeywordHits, policyLinkCandidates,
          clauseIsJurisdictionConditional, policyDefersToSeller,
          clausePositiveButUnverifiedForOpenedItem, conditionExclusionClause,
          negativeClauseWrongCondition, guessedPolicyUrls,
          policyScopedToOtherCountry, stripCandidateIndexPrefix,
          reconcileDays } from "./text.mjs";
import { extractLdBlocks, findReturnPolicy, verdictFromCategory } from "./jsonld.mjs";
import { recordCheck } from "./metrics.mjs";
import { capturePolicy, recordCorpusUse } from "./corpus.mjs";
import { recordAnswer } from "./answerlog.mjs";

class EngineError extends Error {
  constructor(code, http, message) { super(message); this.code = code; this.http = http; }
}

const MAX_HTML_BYTES = 240000;   // techo de HTML crudo a procesar (evita matar el proceso)

// Descubrimiento de página de política: cuántas candidatas probar y cuándo activarlo.
const DISCOVERY_MAX_TRIES = 3;   // nº de páginas de política a intentar (fetch plano)
const WEAK_POLICY_HITS    = 4;   // si el texto de producto trae < N señales de política, buscamos

// Presupuestos de tiempo (ms): el motor NUNCA debe colgarse hasta el timeout de red.
const T_PLAIN_FETCH = 6000;   // fetch HTTP plano
const T_BROWSER     = 15000;  // navegador headless (abrir + cargar + leer)
const T_AI          = 18000;  // llamada al modelo (70B es más lento; navegador off deja margen)

// Corre `promise` con un límite de tiempo; si se pasa, rechaza con EngineError.
function withTimeout(promise, ms, code, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new EngineError(code, 504, message)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Lee el texto de la política. HÍBRIDO: 1) fetch plano rápido; 2) si falla o
// la página es una cáscara JS, usa el navegador headless (más lento).
// Devuelve { text, via, fetch_ms } y NUNCA se cuelga: cada etapa lleva timeout.
export async function fetchPolicyText(env, url, diag = null) {
  const t = Date.now();
  // 1) Intento rápido: petición HTTP normal (con timeout).
  try {
    const res = await withTimeout(
      fetch(url, {
        headers: {
          // UA de navegador real: muchas webs bloquean bots identificados.
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        cf: { cacheTtl: 300, cacheEverything: true },
      }),
      T_PLAIN_FETCH, "UPSTREAM_TIMEOUT", "Plain fetch timed out."
    );
    // W42 — la sonda de adquisicion apunta aqui los hechos crudos. `diag` es
    // opcional y solo lo pasa /admin/adquisicion: sin el, esta funcion se
    // comporta exactamente igual que antes. Se mide el camino REAL, no una copia.
    if (diag) { diag.http_status = res.status; diag.ok = res.ok; }
    if (res.ok) {
      const html = (await res.text()).slice(0, MAX_HTML_BYTES); // cap antes de procesar
      const text = htmlToText(html);
      if (diag) { diag.html_bytes = html.length; diag.text_chars = text.length;
                  diag.policy_hits = policyKeywordHits(text); }
      // El fetch funcionó: devolvemos SIEMPRE el HTML aunque el texto sea pobre.
      // Así, si la página de producto es una cáscara JS, el descubrimiento de la
      // página de devoluciones (que suele ser HTML estático) puede seguir adelante.
      // El navegador solo se usa si el fetch falla del todo (abajo).
      return { text: focusPolicyText(text), via: "structured_data", fetch_ms: Date.now() - t, html };
    }
  } catch (e) { if (diag) diag.fetch_error = (e && (e.code || e.name)) || "fetch_failed"; }

  // 2) Fallback: navegador headless para páginas con mucho JavaScript.
  //    Apagado por defecto (evita cuelgues/latencia). Se activa con USE_BROWSER="true".
  if (String(env.USE_BROWSER || "false") !== "true")
    throw new EngineError("MERCHANT_UNRESOLVED", 422, "Page needs a browser to render (browser fallback disabled).");
  //    Todo el bloque va con timeout: si el navegador tarda, degradamos, no colgamos.
  let browser;
  try {
    const text = await withTimeout((async () => {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: T_BROWSER - 2000 });
      return await page.evaluate(() => document.body.innerText || "");
    })(), T_BROWSER, "UPSTREAM_TIMEOUT", "Headless browser timed out.");
    return { text: focusPolicyText(text.replace(/\s+\n/g, "\n")), via: "page_parse", fetch_ms: Date.now() - t };
  } catch (e) {
    // W42 — el motivo CRUDO del navegador, para la sonda. Sin esto, un binding de
    // navegador no disponible en el plan y una pagina lenta son indistinguibles:
    // la pasada "con navegador" saldria igual que la de "sin" y la leeriamos como
    // "el navegador no ayuda", cuando en realidad no se habria llegado a usar.
    if (diag) diag.browser_error = (e && (e.message || e.name)) || "browser_failed";
    if (e instanceof EngineError) throw e;
    throw new EngineError("UPSTREAM_TIMEOUT", 504, "Could not load the product/policy page in time.");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Fetch HTTP plano (sin navegador), con timeout. Para descubrir la página de
// devoluciones cuando la de producto no trae la política. Devuelve { text, html }
// o null si no se pudo leer. Nunca lanza (bounded, best-effort).
async function fetchPlain(env, url) {
  try {
    const res = await withTimeout(
      fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        cf: { cacheTtl: 300, cacheEverything: true },
      }),
      T_PLAIN_FETCH, "UPSTREAM_TIMEOUT", "Plain fetch timed out."
    );
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    return { text: htmlToText(html), html };
  } catch (_) { return null; }
}

// Busca y lee la página de devoluciones dedicada de la tienda cuando la página de
// producto no trae la política. Prueba primero los enlaces del propio HTML (mejor
// señal) y luego rutas comunes de Shopify/tiendas. Acotado a DISCOVERY_MAX_TRIES.
// Devuelve la MEJOR página encontrada { text, html, url, hits } o null.
export async function discoverPolicyPage(env, productUrl, productHtml) {
  const linked = policyLinkCandidates(productHtml || "", productUrl);
  const guessed = guessedPolicyUrls(productUrl);
  const seen = new Set([productUrl]);
  const candidates = [];
  for (const u of [...linked, ...guessed]) {
    if (seen.has(u)) continue;
    seen.add(u);
    candidates.push(u);
    if (candidates.length >= DISCOVERY_MAX_TRIES) break;
  }
  let best = null;
  for (const url of candidates) {
    const got = await fetchPlain(env, url);
    if (!got) continue;
    const hasLd = /application\/ld\+json/i.test(got.html);
    const hits = policyKeywordHits(got.text);
    // Una página con JSON-LD de política, o con muchas señales, es utilizable.
    if (hasLd || hits >= WEAK_POLICY_HITS) {
      const cand = { text: focusPolicyText(got.text), html: got.html, url, hits, hasLd };
      // Preferimos JSON-LD; si no, la de más densidad de señales.
      if (!best || (cand.hasLd && !best.hasLd) || cand.hits > best.hits) best = cand;
      // Si ya tenemos JSON-LD fuerte, no seguimos gastando fetches.
      if (cand.hasLd) break;
    }
  }
  return best;
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

// W05 — una sola definicion de si las frases candidatas estan encendidas.
// Dos lecturas separadas de la misma variable acabarian divergiendo algun dia.
function candidatesEnabled(env) {
  return String((env && env.USE_CANDIDATES) ?? "true") !== "false";
}

// Llama al modelo con decodificación restringida a esquema. Reintenta una vez si
// el modelo no devuelve JSON limpio (endurecido tras ver 500 en producción).
async function extract(env, policyText, req) {
  // W05: lista determinista de frases candidatas. Vacia si esta desactivado o si
  // el texto no tiene ninguna: en ambos casos el modelo cita libremente, como antes.
  const candidates = candidatesEnabled(env) ? candidateClauses(policyText) : [];
  const candidatesMsg = candidates.length
    ? `CANDIDATE CLAUSES (verbatim from the policy above; pick one by number):\n${candidateBlock(candidates)}\n`
    : "";

  const userMsg =
    `PRODUCT_URL: ${req.product_url}\n` +
    `REQUEST: ${JSON.stringify({ buyer_country: req.buyer_country, item_condition: req.item_condition || null, reason: req.reason || null, membership: req.membership || null, purchase_channel: req.purchase_channel || null })}\n` +
    `TODAY: ${todayDate()}\n` +
    `POLICY TEXT:\n${policyText}\n\n` +
    candidatesMsg;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMsg },
  ];
  const model = env.AI_MODEL || AI_MODEL; // se puede tunear desde el panel sin desplegar
  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try {
      out = await withTimeout(
        env.AI.run(model, {
          messages,
          response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
          max_tokens: 2048,
          ...inferenceParams(env, attempt),   // W05: temperatura explícita, no la del proveedor
        }),
        T_AI, "UPSTREAM_TIMEOUT", "The extraction model did not respond in time."
      );
    } catch (e) {
      // Si el modelo se pasa de tiempo o falla, NO reintentamos (nos mantenemos rápidos):
      // devolvemos null y runCheck lo degrada a UNKNOWN honesto.
      return null;
    }
    const parsed = coerceJson(out);
    if (parsed && typeof parsed === "object") return parsed;
    messages.push({ role: "user", content: "Your previous output was not valid JSON (it may have been cut off). Output ONLY the JSON object, keep exact_clause short, no prose, no markdown, no code fences." });
  }
  return null; // no reventamos: runCheck lo degrada a UNKNOWN
}

// Ensambla la respuesta completa del contrato a partir de lo que devolvió la IA.
// W11 — QUE EL DIAGNOSTICO NO MIENTA.
//
// Los guards deterministas (C06, C09, C15) hacen resp.evidence = null y no
// dejaban ninguna huella. /eval solo sabia mirar meta.degrade, que lo pone un
// unico guard, asi que TODO lo demas se etiquetaba "model returned UNKNOWN".
// El 26 ago eso estuvo a punto de costar una decision equivocada: se leyo esa
// etiqueta como prueba de que el arreglo de C09 no habia hecho nada, cuando en
// realidad el guard si habia actuado. La etiqueta afirmaba mas de lo que sabia.
//
// Ahora cada guard firma. Y guarda la cita que rechazo, que es justo lo que hace
// falta para saber por que un caso se abstiene: no es lo mismo que el modelo no
// conteste a que conteste citando la frase equivocada. Son dos arreglos distintos.
function markGuard(resp, name, rejectedClause) {
  resp.meta = { ...resp.meta, guard: { name, rejected_clause: rejectedClause || null } };
}

// W15 — un host en minusculas y sin "www.", venga como venga.
function hostOf(v) {
  const t = String(v || "").trim();
  if (!t) return null;
  try { return new URL(t).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  try { return new URL("https://" + t).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  return null;
}

async function assemble(ai, req, policyText, meta, sourceUrl) {
  const source = sourceUrl || req.product_url;
  const domainFromUrl = (() => { try { return new URL(req.product_url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const merchant = ai.merchant_resolved || { name: domainFromUrl, domain: domainFromUrl, is_marketplace_third_party: false };
  if (!merchant.domain) merchant.domain = domainFromUrl;
  // W15 — el modelo devuelve a veces la URL entera donde tiene que ir un host.
  // Se vio en el ensayo del corpus: "domain":"https://prueba-corpus-w14.example".
  // La columna del corpus si guarda el host limpio, asi que el borrado por
  // comercio funcionaba — pero un cliente que construya esa peticion a partir de
  // este campo no casaria con nada. Se normaliza aqui, en un solo sitio.
  merchant.domain = hostOf(merchant.domain) || domainFromUrl;
  if (!("seller" in merchant)) merchant.seller = null;
  if (!("country" in merchant)) merchant.country = req.buyer_country || null;

  const determinate = ["YES", "YES_WITH_CONDITIONS", "NO"].includes(ai.verdict);

  // Hallazgo A (doc 65) — la cita manda sobre el número que dio el modelo. Si la
  // ventana de la cita contiene EXACTAMENTE una cifra de días, esa cifra
  // reemplaza a `merchant_return_days` antes de verificar y antes de servirla:
  // es la evidencia que vendemos, no lo que tecleó el modelo. Con dos cifras en
  // la ventana no se decide por el modelo y se conserva su número (podrá seguir
  // abstiene si no encaja).
  if (determinate && ai.policy && ai.evidence && ai.evidence.exact_clause) {
    ai.policy.merchant_return_days = reconcileDays(
      ai.evidence.exact_clause, policyText, ai.policy.merchant_return_days
    );
  }

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

  const clauseOk = determinate && ai.policy && ai.evidence && ai.evidence.source_url &&
                   clauseInText(ai.evidence.exact_clause, policyText) &&
                   clauseSupportsVerdict(ai.evidence.exact_clause, {
                     verdict: ai.verdict,
                     days: ai.policy.merchant_return_days,
                     category: ai.policy.return_category,
                     policyText, // W04: verificar sobre la frase real, no sobre el recorte
                   });
  if (clauseOk) {
    resp.policy = {
      return_category: ai.policy.return_category,
      merchant_return_days: ai.policy.merchant_return_days ?? null,
      window_basis: ai.policy.window_basis ?? null,
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
      source_url: source,
      exact_clause: ai.evidence.exact_clause,
      verified_on: todayDate(),
      freshness_days: 0,
      policy_version: await sha256hex(policyText),
    };
  } else if (determinate) {
    // Veredicto sin cita VERIFICABLE en la página -> degradar a UNKNOWN (nunca inventar).
    // Guardamos por qué falló (diagnóstico): útil para calibrar sin ir a ciegas.
    resp.meta = { ...meta, degrade: {
      rejected_clause: (ai.evidence && ai.evidence.exact_clause) || null,
      in_text: !!(ai.evidence && clauseInText(ai.evidence.exact_clause, policyText)),
      supports: clauseSupportsVerdict((ai.evidence && ai.evidence.exact_clause) || "", {
        verdict: ai.verdict, days: ai.policy && ai.policy.merchant_return_days, category: ai.policy && ai.policy.return_category,
        policyText, // W04: mismo criterio que el guard real, para que el diagnóstico no mienta
      }),
    } };
    markGuard(resp, "clause_unsupported", (ai.evidence && ai.evidence.exact_clause) || null);
    resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
    resp.confidence = 0; resp.policy = null; resp.evidence = null;
    resp.reason = "The cited clause could not be verified as supporting the verdict on the page; not asserting a verdict.";
  }

  // SEGURIDAD W24 (determinista): la politica se declara EXCLUSIVA de otro pais y
  // el comprador no es de ese pais -> no es SU politica. El texto puede decir "30
  // dias" con todas las letras y ser perfectamente valido; responder aqui no es un
  // error de lectura, es contestar la pregunta de otro. Cierra la trampa RC25-13.
  if (resp.verdict !== "UNKNOWN") {
    const ajena = policyScopedToOtherCountry(policyText, req.buyer_country);
    if (ajena) {
      markGuard(resp, "policy_other_country", ajena);
      resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
      resp.confidence = 0; resp.policy = null; resp.evidence = null;
      resp.reason = "The supplied policy states that it applies only to another country; it is not the policy for this buyer.";
      resp.answer_human = "Unknown. The policy on this page applies only to another country, not to this buyer.";
    }
  }

  // SEGURIDAD 3P (determinista, no depende del modelo): si viene un vendedor NOMBRADO
  // y la política dice que los vendedores terceros/marketplace tienen SU PROPIA política,
  // no podemos afirmar la del host -> UNKNOWN honesto. Cierra la trampa C06.
  if (req.seller_name && resp.verdict !== "UNKNOWN" &&
      policyDefersToSeller(policyText)) {
    resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
    resp.confidence = 0; resp.policy = null; resp.evidence = null;
    resp.reason = "Item is sold by a named third-party seller; the page states only the host policy and the seller's own policy is not available.";
    resp.answer_human = "Unknown. This item is sold by a third-party seller whose own return policy is not on this page.";
    markGuard(resp, "third_party_seller", ai.evidence && ai.evidence.exact_clause);
  }


         // SEGURIDAD C09 (determinista): clausula condicionada a la ley del estado y la
         // request no trae el estado del comprador -> no podemos afirmar. Cierra la trampa C09.
         if (resp.verdict !== "UNKNOWN" && resp.evidence &&
             clauseIsJurisdictionConditional(resp.evidence.exact_clause, policyText) && !req.buyer_state) {
                  markGuard(resp, "jurisdiction_conditional", resp.evidence.exact_clause);
                  resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
                  resp.confidence = 0; resp.policy = null; resp.evidence = null;
                  resp.reason = "The cited clause conditions the outcome on state/jurisdiction law, and the buyer's state is not provided.";
                  resp.answer_human = "Unknown. This depends on the buyer's state law, which was not provided.";
         }

         // SEGURIDAD C15 (determinista): item abierto/usado + cita solo "nuevo/sellado" sin
         // excluir esa condicion explicitamente -> no esta demostrado. Cierra la trampa C15.
         if (resp.verdict !== "UNKNOWN" && resp.evidence &&
             clausePositiveButUnverifiedForOpenedItem(resp.evidence.exact_clause, req.item_condition)) {
                  const rejected = resp.evidence.exact_clause;
                  // W12 — antes de abstenernos: ¿la página excluye explícitamente esta
                  // condición en otra frase? Si la hay, la respuesta honesta no es
                  // "no lo sé", es NO. Se le exige el MISMO clauseSupportsVerdict que a
                  // cualquier otra cita: crear un veredicto determinado es lo único que
                  // puede fabricar un error peligroso.
                  const excl = conditionExclusionClause(policyText, req.item_condition);
                  const exclOk = !!excl && clauseSupportsVerdict(excl, {
                    verdict: "NO", days: null, category: "NotPermitted", policyText,
                  });
                  if (exclOk) {
                    markGuard(resp, "opened_item_excluded", rejected);
                    resp.verdict = "NO"; resp.returnable = false; resp.status = "confirmed";
                    resp.confidence = 0.8;
                    resp.policy = {
                      return_category: "NotPermitted", merchant_return_days: null, window_basis: null,
                      deadline_date: null, return_country: req.buyer_country || null,
                      applicable_countries: [], return_method: [], return_fees: null,
                      return_shipping_fees_amount: null, restocking_fee: null, refund_type: null,
                      item_conditions_accepted: [], required_condition: null, exceptions: [],
                      seasonal_override: null,
                    };
                    resp.evidence = {
                      source_url: source, exact_clause: excl, verified_on: todayDate(),
                      freshness_days: 0, policy_version: await sha256hex(policyText),
                    };
                    resp.reason = "The policy explicitly excludes items in this condition from returns; the model had cited a clause that only covers new/sealed items.";
                    resp.answer_human = "No. The merchant's policy excludes items in this condition from returns.";
                  } else {
                    markGuard(resp, "opened_item_unverified", rejected);
                    resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
                    resp.confidence = 0; resp.policy = null; resp.evidence = null;
                    resp.reason = "The cited clause only shows new/sealed-item language; it does not explicitly exclude the opened/used condition of this item.";
                    resp.answer_human = "Unknown. The cited clause does not clearly cover an opened/used item.";
                  }
         }

         // SEGURIDAD W13 (determinista): un NO apoyado en una clausula que excluye una
         // condicion que este articulo NO tiene. La cita es real y niega devoluciones de
         // verdad, asi que clauseSupportsVerdict la da por buena; lo que no comprueba
         // nadie es que hable de OTRA condicion. Encontrado en RC25-17 del holdout.
         if (resp.verdict === "NO" && resp.evidence &&
             negativeClauseWrongCondition(resp.evidence.exact_clause, req.item_condition)) {
                  markGuard(resp, "negative_clause_wrong_condition", resp.evidence.exact_clause);
                  resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
                  resp.confidence = 0; resp.policy = null; resp.evidence = null;
                  resp.reason = "The cited clause excludes a condition this item does not have; it does not establish that this item is non-returnable.";
                  resp.answer_human = "Unknown. The cited exclusion applies to a different item condition than this one.";
         }
  // Reconciliar categoría con veredicto: si es devolvible no puede ser NotPermitted.
  if (resp.policy && resp.verdict !== "NO" && resp.policy.return_category === "NotPermitted") {
    resp.policy.return_category = resp.policy.merchant_return_days != null ? "FiniteReturnWindow" : "UnlimitedWindow";
  }
  // W08 — Texto humano de respaldo. Antes solo miraba la LONGITUD, asi que
  // "YES_WITH_CONDITIONS" (19 caracteres) pasaba el filtro con un veredicto NO.
  // Ahora tambien se sustituye cuando el texto es una fuga de enum o afirma lo
  // contrario del veredicto: nunca puede salir una respuesta que se contradiga.
  if (!usableAnswerHuman(resp.answer_human, resp.verdict)) {
    if (resp.verdict === "NO") resp.answer_human = "No. This item is not returnable under the merchant's published policy for this case.";
    else if (resp.verdict === "UNKNOWN") resp.answer_human = "Unknown. The published policy does not resolve this specific case.";
    else {
      const d = resp.policy && resp.policy.merchant_return_days;
      resp.answer_human = "Yes, with conditions" + (d ? ` — returnable within ${d} days under the merchant's policy.` : " under the merchant's published policy.");
    }
  }
  return resp;
}

// Ensambla una respuesta FUNDAMENTADA a partir de datos estructurados schema.org
// (JSON-LD MerchantReturnPolicy). Sin IA: los datos están literales en la página.
// Devuelve resp o null si no es utilizable (fuera de país, categoría no verificable).
export async function assembleFromJsonLd(ld, req, html, meta, sourceUrl) {
  const source = sourceUrl || req.product_url;
  const p = ld.policy;
  // SEGURIDAD W01b (cierra el hueco de C06 en la ruta JSON-LD): el schema.org
  // MerchantReturnPolicy que encontramos en la página no dice a qué vendedor
  // pertenece -- podría ser la política general del host, que no aplica a un
  // producto de un vendedor tercero. Si el agente nos dice quién es el vendedor,
  // esta ruta "barata" no puede confirmar por sí sola; caemos a la ruta de texto,
  // que sí lee la política completa y aplica el guard de W01 (policyDefersToSeller).
  if (req.seller_name) return null;
  // Alcance por país: si la política declara países y el comprador no está -> no afirmamos.
  if (p.applicable_countries && p.applicable_countries.length &&
      !p.applicable_countries.map((c) => String(c).toUpperCase()).includes((req.buyer_country || "").toUpperCase()))
    return null;
  const category = p.return_category;
  // Verificación literal barata: la categoría aparece de verdad en el HTML crudo.
  if (!String(html).toLowerCase().includes(category.toLowerCase())) return null;

  const verdict = verdictFromCategory(category);
  const days = p.merchant_return_days;
  const domain = (() => { try { return new URL(req.product_url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  const raw = (ld.raw || "").slice(0, 500);

  return {
    schema_version: "1.0",
    verdict,
    returnable: verdict !== "NO",
    confidence: 0.9,
    status: "confirmed",
    answer_human: verdict === "NO"
      ? "No. The merchant's published (structured) return policy marks this as not returnable."
      : (days ? `Yes, with conditions — returnable within ${days} days per the merchant's published return policy.`
              : "Yes, with conditions under the merchant's published return policy."),
    reason: null,
    policy: {
      return_category: category,
      merchant_return_days: days ?? null,
      window_basis: null, // schema.org no declara si cuenta desde compra o entrega
      deadline_date: null,
      return_country: p.return_country ?? (req.buyer_country || null),
      applicable_countries: p.applicable_countries || [],
      return_method: p.return_method || [],
      return_fees: p.return_fees ?? null,
      return_shipping_fees_amount: null,
      restocking_fee: p.restocking_fee ?? null,
      refund_type: p.refund_type ?? null,
      item_conditions_accepted: [],
      required_condition: null,
      exceptions: [],
      seasonal_override: null,
    },
    evidence: {
      source_url: source,
      exact_clause: ("schema.org MerchantReturnPolicy — " + raw).slice(0, 560),
      verified_on: todayDate(),
      freshness_days: 0,
      policy_version: await sha256hex(raw || category),
    },
    merchant_resolved: { name: domain, domain, is_marketplace_third_party: false, seller: null, country: req.buyer_country || null },
    meta,
  };
}

// W17 — CERRAR LA RESPUESTA, y en el orden correcto.
//
// EL FALLO, visto en el primer ensayo real de los avisos (27 ago): el aviso salio
// "text_only" con dias en null y categoria UnlimitedWindow, cuando las dos
// llamadas habian devuelto FiniteReturnWindow y 60 -> 30 dias. El clasificador
// estaba bien; se le entregaban datos vacios.
//
// La causa es de ORDEN, no de logica. `applyDeadline` no es un adorno final: es
// donde la categoria se reconcilia con la cita, donde se rellena el plazo leyendo
// la clausula, y donde un veredicto positivo se convierte en NO si la ventana ya
// venció. Se estaba capturando el corpus ANTES de todo eso, asi que se guardaba
// la salida cruda del modelo en vez de la respuesta que de verdad damos.
//
// Y arrastraba un segundo fallo mas viejo y mas feo: `recordCheck` tambien corria
// antes, o sea que nuestras propias metricas llevan desde siempre contando el
// veredicto PREVIO. Cada caso de "plazo vencido" se apuntaba con su veredicto
// positivo y no como NO. Los numeros del panel estaban sesgados y nadie lo vio.
//
// Regla que deja esto cerrado: NADA se registra hasta que la respuesta esta
// terminada. Una sola funcion, y las tres vias del motor pasan por ella.
async function closeOut(env, resp, req, { capture = null, policyText: textoPolitica = null } = {}) {
  const final = applyDeadline(resp, req, req.as_of || todayDate());

  // W23 — YES vs YES_WITH_CONDITIONS lo decide una regla determinista, no el
  // modelo. Va DESPUES de applyDeadline: si la ventana vencio ya es NO y aqui no
  // entra. Y va antes de missing_input, porque un YES limpio no pide nada.
  // W25 — el texto COMPLETO, no solo la cita: una condicion de resultado casi
  // nunca vive en la misma frase que el permiso.
  const tax = classifyPositive(final, req, textoPolitica);
  if (tax) {
    final.verdict = tax.verdict;
    if (tax.assumed_satisfied.length) final.assumed_satisfied = tax.assumed_satisfied;
  }

  // W21 — que un "no lo se" diga TAMBIEN que haria falta para saberlo. Aditivo:
  // si no falta nada, los campos no aparecen y nadie que ya integro nota el cambio.
  const falta = missingInputFor(final, req);
  if (falta.length) {
    final.missing_input = falta;
    final.missing_input_hint = missingInputHint(falta);
  }

  if (capture && !req.__no_corpus) {
    const corpusId = await capturePolicy(env, {
      ...capture,
      merchantName: final.merchant_resolved && final.merchant_resolved.name,
      country: final.merchant_resolved && final.merchant_resolved.country,
      apiKey: req.__api_key,
      scope: { seller: req.seller_name || null, channel: req.purchase_channel || null, membership: req.membership || null },
      // Lo que de verdad respondimos, ya reconciliado. Es lo que permite decir
      // "paso de 60 a 30 dias" en vez de "algo cambio".
      parsed: final.policy
        ? { days: final.policy.merchant_return_days ?? null, category: final.policy.return_category || null }
        : null,
    });
    if (corpusId) {
      final.meta = { ...final.meta, corpus_id: corpusId };
      await recordCorpusUse(env, corpusId, final.verdict);
    }
  }

  await recordCheck(env, final);

  // W19 — el registro de la respuesta. Va DESPUÉS de todo lo demás y con la
  // respuesta ya cerrada, por la lección de W17: lo que se guarda tiene que ser
  // exactamente lo que dimos, no un estado intermedio. El id se devuelve al
  // cliente para que pueda citarlo en una reclamación.
  // W22 — recordAnswer se salta sola las pasadas de examen (req.__no_corpus).
  const checkId = await recordAnswer(env, {
    resp: final, req, apiKey: req.__api_key, build: BUILD,
    corpusId: final.meta && final.meta.corpus_id,
  });
  if (checkId) final.meta = { ...final.meta, check_id: checkId };

  return final;
}

// Punto de entrada. Devuelve la respuesta del contrato (verdict UNKNOWN incluido).
export async function runCheck(env, req) {
  const t0 = Date.now();
  const key = cacheKey(req);
  const ttlDays = Number(env.CACHE_TTL_DAYS || "7");
  // ¿Nos pasó el agente el contenido de la página? Entonces verificamos SOBRE eso.
  const agentSupplied = !!(req.page_html || req.page_text);

  // 1) Caché — NO se usa cuando el contenido lo aporta el agente (evita que una
  //    página aportada "contamine" el resultado cacheado para otros, y evita mezclar
  //    un veredicto de lectura real con uno de contenido aportado).
  if (!agentSupplied) {
    const cached = await env.DB.prepare(
      "SELECT payload, expires_at FROM policy_cache WHERE cache_key = ?"
    ).bind(key).first().catch(() => null);
    if (cached && cached.expires_at > todayDate()) {
      const resp = JSON.parse(cached.payload);
      resp.meta = { cache_hit: true, response_ms: Date.now() - t0, checked_via: "cache" };
      // Acierto de cache: no se recaptura (ya esta en el corpus de la primera vez).
      return await closeOut(env, resp, req);
    }
  }

  // 2) Obtener el contenido de la página: aportado por el agente, o leído por nosotros.
  let prodText, via, fetch_ms = 0, prodHtml;
  if (agentSupplied) {
    prodHtml = String(req.page_html || "").slice(0, MAX_HTML_BYTES);
    const rawText = req.page_text ? String(req.page_text) : htmlToText(prodHtml);
    prodText = focusPolicyText(rawText);
    via = "agent_supplied";
  } else {
    ({ text: prodText, via, fetch_ms, html: prodHtml } = await fetchPolicyText(env, req.product_url));
  }

  // Ayudante: intenta el camino JSON-LD sobre un HTML dado; si sale, cachea y responde.
  const tryJsonLd = async (html, sourceUrl, checked_via) => {
    const ld = html ? findReturnPolicy(extractLdBlocks(html)) : null;
    if (!ld) return null;
    const built = await assembleFromJsonLd(ld, req, html, {
      cache_hit: false, response_ms: Date.now() - t0, checked_via, fetch_ms,
    }, sourceUrl);
    if (!built || !checkInvariants(built).ok) return null;
    if (!agentSupplied) {   // no cacheamos veredictos basados en contenido aportado
      const toCacheLd = JSON.parse(JSON.stringify(built));
      if (toCacheLd.policy) toCacheLd.policy.deadline_date = null;
      env.DB.prepare(
        "INSERT OR REPLACE INTO policy_cache (cache_key, payload, verified_on, expires_at) VALUES (?,?,?,?)"
      ).bind(key, JSON.stringify(toCacheLd), todayDate(), addDays(todayDate(), ttlDays)).run().catch(() => {});
    }
    return await closeOut(env, built, req, {
      capture: { policyText: html, sourceUrl, via: checked_via },
      policyText: html,
    });
  };

  // 3a) Datos estructurados en la página (fundamentado, sin IA).
  const fromProduct = await tryJsonLd(prodHtml, req.product_url,
    agentSupplied ? "agent_supplied_jsonld" : "structured_data_jsonld");
  if (fromProduct) return fromProduct;

  // 3b) COBERTURA: si la página de producto no trae política clara, buscar la página
  // de devoluciones dedicada de la tienda y leerla. Convierte UNKNOWNs en respuestas.
  // (Solo cuando leemos nosotros: si el agente aportó la página, no salimos a la red.)
  let policyText = prodText, sourceUrl = req.product_url, checked_via = via, discovered_url = null;
  if (!agentSupplied && policyKeywordHits(prodText) < WEAK_POLICY_HITS) {
    const found = await discoverPolicyPage(env, req.product_url, prodHtml);
    if (found) {
      discovered_url = found.url;
      // 3b-i) ¿La página de política trae JSON-LD? Camino fundamentado, citando esa URL.
      const fromPolicy = await tryJsonLd(found.html, found.url, "policy_page_jsonld");
      if (fromPolicy) return fromPolicy;
      // 3b-ii) Si no, usamos su texto (más rico) para el camino IA, citando esa URL.
      if (found.hits > policyKeywordHits(prodText)) {
        policyText = found.text; sourceUrl = found.url; checked_via = "policy_page_parse";
      }
    }
  }

  // 3c) Camino IA sobre texto (si no hubo datos estructurados utilizables)
  if (!policyText || policyText.length < 40)
    throw new EngineError("MERCHANT_UNRESOLVED", 422, "Could not read a usable policy from the page.");
  const tAi = Date.now();
  const ai = (await extract(env, policyText, req)) || {
    verdict: "UNKNOWN", confidence: 0, policy: null, evidence: null, answer_human: "",
    reason: "The engine could not extract a structured answer from this page.",
  };
  const ai_ms = Date.now() - tAi;

  // Hallazgo B (doc 65) — el modelo a veces copia la línea entera de la lista de
  // candidatas, número incluido ("[2] ..."). Ese número es nuestro, no del
  // comercio: si se cuela, o se pierde el caso (la página no contiene "[2] ") o,
  // peor, entregamos como cita literal un texto que el comercio no escribió. Se
  // limpia aquí, antes de cualquier verificación, para que ni pickClause ni
  // clauseInText lo vean.
  if (ai.evidence && ai.evidence.exact_clause) {
    ai.evidence.exact_clause = stripCandidateIndexPrefix(ai.evidence.exact_clause);
  }

  // W05 — si el modelo eligio una frase candidata valida, la cita pasa a ser la
  // frase LITERAL de la pagina, no lo que el modelo tecleo. Si no eligio, o el
  // numero es imposible, cae a su cita libre de siempre: este cambio solo puede
  // mejorar o empatar, nunca empeorar respecto al comportamiento anterior.
  let clause_from_candidate = false;
  if (ai.evidence) {
    const picked = pickClause(ai.evidence, policyText, candidatesEnabled(env));
    if (picked && picked !== ai.evidence.exact_clause) {
      clause_from_candidate = true;
      ai.evidence.exact_clause = picked;
    }
  }

  // 4) Ensamblar + invariantes
  const meta = { cache_hit: false, response_ms: Date.now() - t0, checked_via, fetch_ms, ai_ms, policy_chars: policyText.length,
                 clause_from_candidate };
  if (discovered_url) meta.discovered_policy_url = discovered_url;
  const resp = await assemble(ai, req, policyText, meta, sourceUrl);

  const inv = checkInvariants(resp);
  if (!inv.ok) {
    // Nunca reventamos: si el resultado no es válido, degradamos a UNKNOWN honesto.
    resp.verdict = "UNKNOWN"; resp.returnable = null; resp.status = "indeterminate";
    resp.confidence = 0; resp.policy = null; resp.evidence = null;
    resp.reason = "Engine could not produce a valid grounded answer (" + inv.problems.join("; ") + ").";
  }

  // 5) Cachear el extracto (sin deadline por fecha) y recomputar deadline por petición.
  //    No cacheamos si el contenido lo aportó el agente (no contaminar a otros).
  if (!agentSupplied) {
    const toCache = JSON.parse(JSON.stringify(resp));
    if (toCache.policy) toCache.policy.deadline_date = null;
    env.DB.prepare(
      "INSERT OR REPLACE INTO policy_cache (cache_key, payload, verified_on, expires_at) VALUES (?,?,?,?)"
    ).bind(key, JSON.stringify(toCache), todayDate(), addDays(todayDate(), ttlDays)).run().catch(() => {});
  }

  // W14 — LA PUERTA. La captura va DESPUES de cerrar la respuesta (ver closeOut).
  return await closeOut(env, resp, req, {
    capture: { policyText, sourceUrl, via: checked_via },
    policyText,
  });
}

export { EngineError };
