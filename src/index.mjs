// ReturnCheck — Worker de producción (Fase 1: fiat-first).
// Rutas:
//   POST /v1/signup            -> alta de cliente + crédito de prueba, devuelve API key
//   POST /v1/check             -> la consulta principal (alias: /v1/check_return)
//   GET  /v1/balance           -> saldo del cliente (auth)
//   POST /v1/agent/check       -> x402 DORMIDO: 402 educado (Fase 2)
//   POST /webhooks/stripe      -> recarga de saldo
//   GET  /                     -> info

import { validateRequest } from "./contract.mjs";
import { runCheck, EngineError } from "./engine.mjs";
import { getClient, chargeAtomic, markFree, createClient } from "./billing.mjs";
import { handleStripeWebhook } from "./stripe.mjs";
import { handleMcp } from "./mcp.mjs";
import { freeTrial } from "./freetier.mjs";
import { readMetrics } from "./metrics.mjs";
import { json, errorResponse, todayDate, BUILD } from "./util.mjs";
import { EVAL_CASES } from "./eval-cases.mjs";
import { HOLDOUT_CASES } from "./holdout-cases.mjs";
import { clauseInText } from "./text.mjs";
import { corpusStats, deleteMerchantCorpus, sha256full } from "./corpus.mjs";
import { addWatch, removeWatch, listWatches, changesFor } from "./watch.mjs";
import { findAnswers, answerStats, markAnswerCharged, purgeExpiredAnswers, deleteClientAnswers } from "./answerlog.mjs";
import { inferenceParams } from "./prompt.mjs";

// Marcador de versión único (se usa en / y en /eval para sellar el volcado).

// W09 — Autorizacion de administrador.
//
// Hasta hoy la clave viajaba SOLO como parametro de la URL (?k=...). Las URLs se
// escriben enteras en los registros de Cloudflare, asi que cada visita a /eval o
// /stats dejaba la clave de administracion en texto plano en los logs. Lo detecto
// la sesion local al ver que medir las dos ramas la escribiria dos veces.
//
// Es incoherente con lo que publicamos en /data-policy sobre no guardar secretos,
// y es del tipo de hallazgo que le marcariamos a un cliente en una auditoria.
//
// Ahora se acepta la cabecera Authorization: Bearer <clave>, que NO va al log.
// Se conserva ?k= porque el panel /dashboard se abre pegando la URL en el
// navegador y romperlo hoy no arregla nada. Queda dicho en el README lo que falta:
// el panel sigue dejando rastro, y cerrarlo del todo pide sesion con cookie.
function adminOk(request, url, env) {
  if (!env.ADMIN_KEY) return false;
  const header = bearer(request);
  if (header && header === env.ADMIN_KEY) return true;
  return url.searchParams.get("k") === env.ADMIN_KEY;
}

// Examen ciego v2: pasa el banco de casos por el motor de PRODUCCIÓN (vía agent_supplied)
// y puntúa precisión, cobertura, trampas de honestidad y alucinaciones. Admin-gated.
async function handleEval(request, env, url) {
  if (!adminOk(request, url, env))
    return errorResponse("INVALID_INPUT", "Not found.", 404);
  // W06 — ?set=holdout corre el banco de 25 que NO escribimos nosotros. Por
  // defecto sigue siendo el de 18, para no romper ninguna comparacion anterior.
  const setName = url.searchParams.get("set") === "holdout" ? "holdout" : "own";
  const BANCO = setName === "holdout" ? HOLDOUT_CASES : EVAL_CASES;
  const from = Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0);
  const countRaw = url.searchParams.get("count");
  const count = countRaw === null ? BANCO.length : (parseInt(countRaw, 10) || 0);
  const slice = BANCO.slice(from, from + count);

  const results = [];
  for (const c of slice) {
    const req = {
      product_url: "https://eval.example/p/" + c.id,
      buyer_country: c.request.buyer_country,
      item_condition: c.request.item_condition,
      reason: c.request.reason,
      purchase_date: c.request.purchase_date,
      delivery_date: c.request.delivery_date,
      seller_name: c.request.seller_name,
      // W15 — el banco de pruebas NO entra en el corpus. El corpus es el material
      // con el que se responde y del que saldran los avisos de cambio de politica;
      // llenarlo de casos sinteticos que escribimos nosotros lo contamina justo en
      // la parte que lo hace valioso. Una pasada de /eval son 18 o 25 documentos
      // falsos, y llevamos muchas.
      __no_corpus: true,
      // W06 — el holdout usa campos que el banco propio no tenia. Se pasan solo
      // si el caso los trae, asi que el banco de 18 se comporta exactamente igual.
      as_of: c.request.as_of,
      purchase_channel: c.request.purchase_channel,
      membership: c.request.membership,
      page_text: c.page_text,
    };
    let got = "ERROR", policyDays = null, clause = null, hallucination = false, err = null;
    let via = null, degrade = null, fromCandidate = null, guard = null, reason = null;
    let gotBasis = null, gotDeadline = null;
    try {
      const resp = await runCheck(env, req);
      got = resp.verdict;
      policyDays = resp.policy ? (resp.policy.merchant_return_days ?? null) : null;
      gotBasis = resp.policy ? (resp.policy.window_basis ?? null) : null;
      gotDeadline = resp.policy ? (resp.policy.deadline_date ?? null) : null;
      clause = resp.evidence ? resp.evidence.exact_clause : null;
      via = resp.meta ? resp.meta.checked_via : null;
      degrade = resp.meta && resp.meta.degrade ? resp.meta.degrade : null; // por qué se degradó a UNKNOWN
      // W05 — de dónde salió la cita. Sin este dato no se puede distinguir si la
      // mejora del 25 ago vino de ENSEÑAR la lista numerada al modelo o de
      // RESOLVER el número que eligió. Son dos inversiones distintas: la primera
      // se paga en prompt, la segunda en código. El medidor de varianza ya lo
      // decía por caso suelto; aquí falta para el banco entero.
      fromCandidate = resp.meta ? !!resp.meta.clause_from_candidate : null;
      guard = (resp.meta && resp.meta.guard) || null;   // W11: qué guard abstuvo, si abstuvo alguno
      reason = resp.reason ?? null;
      if (got !== "UNKNOWN" && clause) hallucination = !clauseInText(clause, c.page_text);
    } catch (e) { err = (e && e.message) || "error"; }

    const expected = c.expected.verdict;
    const correct = got === expected;
    const determinate = got !== "UNKNOWN" && got !== "ERROR";
    const daysOk = c.expected.days == null ? null : (policyDays === c.expected.days);
    const basisOk = c.expected.window_basis == null ? null : (gotBasis === c.expected.window_basis);
    const deadlineOk = c.expected.deadline == null ? null : (gotDeadline === c.expected.deadline);
    let errorType = "ok";
    if (!correct) errorType = (got === "UNKNOWN") ? "safe_miss" : "UNSAFE";
    // W06 — puntuacion OPERATIVA: agrupa YES y YES_WITH_CONDITIONS como una sola
    // decision de elegibilidad. Existe porque el motor no emite nunca YES pelado,
    // y sin esta vista una diferencia de ETIQUETA se contaria como error
    // PELIGROSO — que es decir que el motor miente cuando en realidad acierta la
    // decision. Las dos vistas se informan; ninguna sustituye a la otra.
    const pos = (v) => (v === "YES" || v === "YES_WITH_CONDITIONS") ? "POSITIVE" : v;
    const correctOp = pos(got) === pos(expected);
    let errorTypeOp = "ok";
    if (!correctOp) errorTypeOp = (got === "UNKNOWN") ? "safe_miss" : "UNSAFE";
    const taxonomyOnly = !correct && correctOp;
    results.push({
      id: c.id, trap: !!c.trap, expected, got, correct, determinate,
      expected_days: c.expected.days ?? null, got_days: policyDays, daysOk,
      expected_basis: c.expected.window_basis ?? null, got_basis: gotBasis, basisOk,
      expected_deadline: c.expected.deadline ?? null, got_deadline: gotDeadline, deadlineOk,
      correct_op: correctOp, errorType_op: errorTypeOp, taxonomy_only: taxonomyOnly,
      cited_clause: clause,
      clause_from_candidate: fromCandidate,
      // W11 — antes esto decía "model returned UNKNOWN" siempre que no hubiera
      // `degrade`, que solo pone UNO de los cuatro guards. Los otros tres se
      // etiquetaban como abstención del modelo: el diagnóstico afirmaba lo que
      // no sabía, y el 26 ago estuvo a punto de costar una decisión equivocada.
      unknown_reason: (got === "UNKNOWN")
        ? (guard ? ("guard: " + guard.name + " — " + (guard.rejected_clause || "(sin cita)"))
                 : "model returned UNKNOWN")
        : null,
      guard: guard ? guard.name : null,
      guard_rejected_clause: guard ? guard.rejected_clause : null,
      reason,
      hallucination, errorType, via, degrade, error: err, note: c.note,
    });
  }

  const n = results.length;
  const correct = results.filter(r => r.correct).length;
  const det = results.filter(r => r.determinate).length;
  const detCorrect = results.filter(r => r.determinate && r.correct).length;
  const traps = results.filter(r => r.trap);
  const trapsHeld = traps.filter(r => r.got === "UNKNOWN").length;
  const halluc = results.filter(r => r.hallucination).length;
  const safeMiss = results.filter(r => r.errorType === "safe_miss").length;
  const unsafe = results.filter(r => r.errorType === "UNSAFE").length;
  const correctOpN = results.filter(r => r.correct_op).length;
  const detCorrectOp = results.filter(r => r.determinate && r.correct_op).length;
  const unsafeOp = results.filter(r => r.errorType_op === "UNSAFE").length;
  const safeMissOp = results.filter(r => r.errorType_op === "safe_miss").length;
  const taxOnly = results.filter(r => r.taxonomy_only).length;
  const conDeadline = results.filter(r => r.deadlineOk !== null);
  const deadlineOkN = conDeadline.filter(r => r.deadlineOk).length;
  const conBasis = results.filter(r => r.basisOk !== null);
  const basisOkN = conBasis.filter(r => r.basisOk).length;
  // El techo de cobertura de un banco con trampas NO es 100: los casos cuyo
  // resultado correcto es UNKNOWN nunca pueden contar como cobertura. Publicarlo
  // evita perseguir un numero imposible, que es justo lo que paso el 26 de agosto
  // con el banco propio (techo 72,2 %) leido como si fuera un suspenso.
  // Se calcula sobre el BANCO ENTERO, no sobre la tanda: el techo es una propiedad
  // del instrumento, no de cuantos casos se hayan corrido esta vez.
  const techo = BANCO.filter(c => c.expected.verdict !== "UNKNOWN").length;
  // W11 — reparto de las abstenciones. Un banco con 6 UNKNOWN no dice lo mismo si
  // los pone el modelo (falta capacidad) que si los pone un guard (falta cita), y
  // hasta ahora el resumen no permitía distinguirlo de un vistazo.
  const guards = {};
  for (const r of results) {
    if (r.got !== "UNKNOWN") continue;
    const k = r.guard || "model_returned_unknown";
    guards[k] = (guards[k] || 0) + 1;
  }
  const rescued = results.filter(r => r.clause_from_candidate === true).length;
  const cited = results.filter(r => r.cited_clause).length;
  const pct = (a, b) => b ? Math.round((a / b) * 1000) / 10 : 0;

  return json({
    exam: "blind-v2",
    build: BUILD,
    date: todayDate(),
    model: env.AI_MODEL || "default-8b-fast",
    scope: "production engine via agent_supplied (page_text); verdicts vs hand-verified expected. Cases authored and run by the ReturnCheck team (not third-party).",
    set: setName,
    cases: n,
    coverage_ceiling_pct: pct(techo, BANCO.length),  // maximo alcanzable del banco: los UNKNOWN esperados nunca cuentan como cobertura
    accuracy_pct: pct(correct, n),                 // % veredicto correcto sobre el total
    coverage_pct: pct(det, n),                     // % con veredicto determinado (no UNKNOWN)
    precision_determinate_pct: pct(detCorrect, det), // de los determinados, % correctos
    hallucinations: halluc,                        // cláusulas citadas que NO están en el texto (debe ser 0)
    unsafe_errors: unsafe,                          // veredicto determinado EQUIVOCADO (lo peligroso)
    safe_misses: safeMiss,                          // debía ser determinado pero dijo UNKNOWN (conservador)
    traps_total: traps.length,
    traps_held: trapsHeld,                          // trampas resueltas con UNKNOWN (bien)
    // W05 — cuántas citas se salvaron resolviendo el número de la lista, sobre
    // cuántas respuestas llegaron a citar algo. 0/N y N/N significan cosas muy
    // distintas y hasta ahora el banco no lo decía.
    clauses_rescued_by_candidate: rescued,
    clauses_cited: cited,
    unknown_breakdown: guards,               // W11: quién abstuvo — cada guard por su nombre, y el modelo por el suyo
    // W06 — la MISMA tanda puntuada de las dos maneras. Estricta arriba, operativa aquí.
    operational: {
      accuracy_pct: pct(correctOpN, n),
      precision_determinate_pct: pct(detCorrectOp, det),
      unsafe_errors: unsafeOp,
      safe_misses: safeMissOp,
      taxonomy_only_diffs: taxOnly,          // aciertan la decisión, fallan la etiqueta YES vs YES_WITH_CONDITIONS
    },
    window_accuracy: {
      deadline_ok: deadlineOkN, deadline_total: conDeadline.length,
      basis_ok: basisOkN, basis_total: conBasis.length,
    },
    results,
  }, { headers: { "access-control-allow-origin": "*" } });
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 402 "educado": dice CÓMO pagar por las dos vías (fiat ahora, x402 en Fase 2).
function educated402(env, note) {
  const base = env.PUBLIC_BASE_URL || "";
  return json({
    error: { code: "PAYMENT_REQUIRED", message: note || "Payment required." },
    how_to_pay: {
      fiat_prepaid: {
        description: "Top up your prepaid balance and call /v1/check with your API key.",
        signup: `${base}/v1/signup`,
        price_usd_per_call: Number(env.PRICE_USD || "0.02"),
        note: "UNKNOWN answers are free — you only pay for a useful verdict.",
      },
      x402_agentic: {
        description: "Autonomous agent-to-agent payment (USDC on Base). Coming in Phase 2.",
        status: "not_yet_enabled",
      },
    },
  }, { status: 402 });
}

// ---------------------------------------------------------------------------
// Aviso de datos y fuentes.
//
// Va PRIMERO, antes de que exista una sola línea de código de captura: decisión
// de Miguel del 25 ago 2026 (doc 40). Guardar avisando y guardar sin avisar son
// dos situaciones distintas, y lo capturado antes del aviso se captura sin él.
//
// Cada frase de este texto describe lo que el código HACE, no lo que queremos
// que haga. Si algo de aquí deja de ser cierto, se cambia el aviso el mismo día.
// Deliberadamente NO contiene la promesa "no vendemos estos datos": el corpus es
// un activo y atarse a eso hoy sería prometer lo que quizá no se cumpla.
// ---------------------------------------------------------------------------
function dataPolicyText(env) {
  const base = env.PUBLIC_BASE_URL || "";
  const contact = env.CONTACT_EMAIL || "";
  const months = Number(env.DATA_RETENTION_MONTHS || "48");
  const answerMonths = Number(env.ANSWER_RETENTION_MONTHS || "12");
  return `# ReturnCheck — Data & Sources Notice

Last updated: 2026-08-25

ReturnCheck reads return-policy text and answers whether a specific product can
actually be returned. This notice says what we keep, why, and how to get it removed.

## What we store

- The return-policy text we read, or that a client sends us as page_text /
  page_html, kept as received.
- Where it came from: the source URL when there is one, how it reached us
  (fetched by us / supplied by a client / supplied by a calling agent), and the
  date we captured it.
- A one-way reference to the API client whose request triggered the capture.
  That reference is a hash. Never the API key itself. Never an email address.

## What we store about our own answers

One record per query, so that we can audit and reproduce what we told you:

- The verdict we gave, the clause we quoted, the return window and deadline we
  computed, which safety check (if any) stopped us, and the build of our code.
- A link to the exact version of the policy text we read.
- The structured inputs that changed the verdict: country, buyer state, item
  condition, return reason, membership, purchase channel, seller, and the
  purchase or delivery date you sent us. Never free-form text you send us.
- The product URL with everything after the "?" removed.

Each answer has an id, returned to you as meta.check_id. Quote it and we can
look up exactly what we did and why.

## What we do not store

- Buyer personal data. Requests should not contain it. Text that appears to
  contain personal information is flagged, withheld from use, and reviewed by a
  person or deleted.
- Payment details, credentials, or client secrets.

## Why we store it

To verify our own answers, correct our errors, and improve coverage. Stored text
is never used to answer another user's query unless a person has reviewed it first.

## Merchants — removal

If this text is from your site and you want it removed, email ${contact} with your
domain. We delete it. If you also want us to stop storing your site's policy text
going forward, say so in the same email and we will.

## Retention

Policy text: ${months} months by default, or until deletion is requested —
whichever comes first.

Answer records: ${answerMonths} months. Shorter on purpose. A merchant's policy
text ages well as a record; a log of who asked what does not.

## Contact

${contact}
${base ? "\n" + base + "/data-policy\n" : ""}`;
}

function dataPolicy(env) {
  return new Response(dataPolicyText(env), {
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

// Manifiesto en texto para agentes/LLMs que rastrean el dominio.
function llmsTxt(env) {
  const base = env.PUBLIC_BASE_URL || "";
  const price = Number(env.PRICE_USD || "0.02");
  const body =
`# ReturnCheck

> Can this specific product actually be returned? ReturnCheck gives AI shopping
> agents a verified verdict (YES / YES_WITH_CONDITIONS / NO / UNKNOWN) with the
> exact policy clause quoted verbatim, source URL, return window and confidence.
> It never invents: if it cannot verify a clause on the page, it returns UNKNOWN.

## Use it
- MCP endpoint (Streamable HTTP): ${base}/mcp  (tool: check_return)
- HTTP: POST ${base}/v1/check  {"product_url":"...","buyer_country":"US"}
- Free trial: a few calls per day with no API key. Then $${price}/verified query; UNKNOWN is free.
- Sign up for an API key (free credit): POST ${base}/v1/signup {"email":"..."}
- OpenAPI: ${base}/openapi.json

## Input
- product_url (required), buyer_country (required, ISO alpha-2)
- optional: item_condition, reason, purchase_date, delivery_date, merchant, seller_name, buyer_state, as_of, membership, purchase_channel
- optional: page_html or page_text — if you already have the product/policy page
  rendered, pass it and we verify against it (best coverage; bypasses sites that
  block server-side reads). We still never invent: no verifiable clause -> UNKNOWN.

## Example (HTTP)
Request:  POST ${base}/v1/check
  {"product_url":"https://store.example/p/shoe","buyer_country":"US","item_condition":"unopened"}
Response: {"verdict":"YES_WITH_CONDITIONS","returnable":true,"confidence":0.9,
  "policy":{"merchant_return_days":30,...},
  "evidence":{"source_url":"...","exact_clause":"Items may be returned within 30 days...","verified_on":"..."}}

## Why call it
- Verified, not guessed: every YES/NO carries the exact clause + source URL, or it is UNKNOWN (free).
- Built for agent-to-agent commerce: MCP tool + x402-friendly micro-pricing ($${price}/verified answer).
- Neutral: works across merchants; we sell to every shopping agent, we don't compete with them.

## Discovery
- MCP manifest (tool list): ${base}/mcp
- OpenAPI: ${base}/openapi.json  ·  Plugin manifest: ${base}/.well-known/ai-plugin.json
- Agents manifest: ${base}/agents.json

## Data & sources
- What we store, why, and how merchants get it removed: ${base}/data-policy
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
}

// Manifiesto estilo "plugin" (lo leen varios frameworks/crawlers de agentes).
function aiPluginJson(env) {
  const base = env.PUBLIC_BASE_URL || "";
  const price = Number(env.PRICE_USD || "0.02");
  const manifest = {
    schema_version: "v1",
    name_for_model: "return_check",
    name_for_human: "ReturnCheck",
    description_for_model:
      "Check whether a specific product can actually be returned. Call check_return with a product_url and buyer_country (ISO alpha-2). Returns a verified verdict (YES / YES_WITH_CONDITIONS / NO / UNKNOWN) with the exact policy clause quoted from the page, the source URL, the return window and a confidence score. It NEVER invents: if it cannot verify a clause it returns UNKNOWN (free). If you already have the product/policy page rendered, pass it as page_html or page_text for best coverage. Priced at " + price + " USD per verified answer; UNKNOWN is free; a keyless free trial is available.",
    description_for_human: "Verified return-policy answers for AI shopping agents. Never guesses.",
    auth: { type: "none" },
    api: { type: "openapi", url: base + "/openapi.json" },
    logo_url: base + "/favicon.ico",
    contact_email: env.CONTACT_EMAIL || "",
    legal_info_url: base + "/data-policy",
    pricing: { model: "per_call", amount_usd: price, unknown_is_free: true, free_trial: String(env.FREE_TRIAL_ENABLED || "false") === "true" },
  };
  return json(manifest, { headers: { "access-control-allow-origin": "*" } });
}

// Manifiesto "agents.json": describe la acción para agentes que lo descubren.
function agentsJson(env) {
  const base = env.PUBLIC_BASE_URL || "";
  const price = Number(env.PRICE_USD || "0.02");
  const doc = {
    schema_version: "0.1",
    name: "ReturnCheck",
    description: "Verified return-policy answers for AI shopping agents. Never invents: returns UNKNOWN instead of guessing.",
    url: base,
    openapi: base + "/openapi.json",
    data_policy: base + "/data-policy",
    // W16 — si no se anuncia, no se descubre; y si no se descubre, no existe.
    change_alerts: {
      watch: base + "/v1/watch",
      watchlist: base + "/v1/watchlist",
      changes: base + "/v1/changes",
      note: "Register the merchant domains you care about; poll /v1/changes for policy changes since your last check.",
    },
    contact_email: env.CONTACT_EMAIL || "",
    mcp: { transport: "streamable_http", url: base + "/mcp", tools: ["check_return"] },
    pricing: { unit: "per_verified_answer", amount_usd: price, currency: "USD", unknown_is_free: true, payment: ["x402", "prepaid_api_key"] },
    flows: [{
      name: "check_return",
      description: "Can this specific product actually be returned for this buyer?",
      endpoint: "POST " + base + "/v1/check",
      required: ["product_url", "buyer_country"],
      optional: ["item_condition", "reason", "purchase_date", "delivery_date", "merchant", "seller_name", "buyer_state", "as_of", "membership", "purchase_channel", "page_html", "page_text"],
      returns: ["verdict", "returnable", "confidence", "policy", "evidence.exact_clause", "evidence.source_url"],
    }],
  };
  return json(doc, { headers: { "access-control-allow-origin": "*" } });
}

// OpenAPI mínimo (descubrimiento para agentes/herramientas).
function openapi(env) {
  const base = env.PUBLIC_BASE_URL || "";
  const spec = {
    openapi: "3.1.0",
    info: { title: "ReturnCheck", version: "1.0.0", description: "Verified return-policy answers for AI shopping agents. Never invents: returns UNKNOWN instead of guessing." },
    servers: [{ url: base }],
    paths: {
      "/v1/check": {
        post: {
          operationId: "check_return",
          summary: "Can this specific product actually be returned?",
          description: "Returns a verified verdict with the exact policy clause. No API key = limited free trial; with an API key it costs " + Number(env.PRICE_USD || "0.02") + " USD per useful verdict (UNKNOWN is free).",
          security: [{}, { bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CheckRequest" } } } },
          responses: { "200": { description: "Verified answer (contract v1.0)." }, "402": { description: "Payment required / free trial exhausted." } },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        CheckRequest: {
          type: "object",
          required: ["product_url", "buyer_country"],
          properties: {
            product_url: { type: "string", description: "Product page URL (http/https)." },
            buyer_country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. US." },
            item_condition: { type: "string", enum: ["unopened", "opened", "used", "defective"] },
            reason: { type: "string", enum: ["changed_mind", "defective", "wrong_size_or_model", "arrived_late", "other"] },
            purchase_date: { type: "string" },
            delivery_date: { type: "string" },
            merchant: { type: "string" },
            seller_name: { type: "string" },
            buyer_state: { type: "string", description: "2-letter uppercase subdivision code, e.g. CA. Needed to resolve state-conditional clauses (e.g. 'where prohibited by law') instead of falling back to UNKNOWN." },
            as_of: { type: "string", description: "YYYY-MM-DD. The date to evaluate the return window against, if not today." },
            membership: { type: "string", description: "Optional: the buyer's membership/loyalty tier with this merchant (e.g. 'Plus'), for policies with membership-conditional terms." },
            purchase_channel: { type: "string", enum: ["online", "store", "phone", "marketplace"], description: "Optional: where the purchase was made, for policies with channel-conditional terms." },
            page_html: { type: "string", description: "Optional: raw HTML of the product/policy page you already have. If provided, ReturnCheck verifies against it instead of fetching (best coverage; bypasses anti-bot blocking). Max 4,000,000 chars." },
            page_text: { type: "string", description: "Optional: plain text of the page (alternative to page_html). Max 4,000,000 chars." },
          },
        },
      },
    },
  };
  return json(spec, { headers: { "access-control-allow-origin": "*" } });
}

// ---- Panel de control: métricas reales del proyecto ----
async function handleStats(request, env, url) {
  if (!adminOk(request, url, env))
    return errorResponse("INVALID_INPUT", "Not found.", 404);

  const price = Number(env.PRICE_USD || "0.02");
  const cl = await env.DB.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(calls_charged),0) charged, COALESCE(SUM(calls_free),0) free, COALESCE(SUM(balance_usd),0) bal FROM clients"
  ).first().catch(() => ({ c: 0, charged: 0, free: 0, bal: 0 }));
  const cache = await env.DB.prepare("SELECT COUNT(*) c FROM policy_cache").first().catch(() => ({ c: 0 }));
  const freeToday = await env.DB.prepare("SELECT value v FROM free_usage WHERE bucket = ?")
    .bind("global:" + todayDate()).first().catch(() => null);
  const m = await readMetrics(env);

  const v = {
    YES: m.verdict_YES || 0,
    YES_WITH_CONDITIONS: m.verdict_YES_WITH_CONDITIONS || 0,
    NO: m.verdict_NO || 0,
    UNKNOWN: m.verdict_UNKNOWN || 0,
  };
  const checks = m.checks_total || 0;
  const determinate = v.YES + v.YES_WITH_CONDITIONS + v.NO;

  return json({
    updated: todayDate(),
    clients: cl.c || 0,
    checks_total: checks,
    verdicts: v,
    determinate_rate: checks ? Math.round((determinate / checks) * 100) : 0,
    unknown_rate: checks ? Math.round((v.UNKNOWN / checks) * 100) : 0,
    via: {
      structured_data: m.via_structured_data || 0,
      structured_data_jsonld: m.via_structured_data_jsonld || 0,
      policy_page_jsonld: m.via_policy_page_jsonld || 0,
      policy_page_parse: m.via_policy_page_parse || 0,
      page_parse: m.via_page_parse || 0,
      agent_supplied: m.via_agent_supplied || 0,
      agent_supplied_jsonld: m.via_agent_supplied_jsonld || 0,
      cache: m.via_cache || 0,
    },
    cache_hits: m.cache_hits || 0,
    cached_policies: cache.c || 0,
    calls_charged: cl.charged || 0,
    calls_free: cl.free || 0,
    free_trial_today: freeToday ? freeToday.v : 0,
    metered_revenue_usd: Math.round((cl.charged || 0) * price * 100) / 100,
    balance_outstanding_usd: Math.round((cl.bal || 0) * 100) / 100,
  }, { headers: { "access-control-allow-origin": "*" } });
}

// Página HTML del panel (la sirve el propio Worker para poder leer /stats).
function dashboardPage(env, url) {
  const k = url.searchParams.get("k") || "";
  if (!env.ADMIN_KEY || k !== env.ADMIN_KEY)
    return errorResponse("INVALID_INPUT", "Not found.", 404);
  const html = DASHBOARD_HTML.replace("__KEY__", encodeURIComponent(k));
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handleSignup(request, env) {
  let body;
  try { body = await request.json(); } catch { return errorResponse("INVALID_INPUT", "Body must be JSON.", 400); }
  const email = body && body.email;
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return errorResponse("INVALID_INPUT", "A valid email is required.", 400);
  const freeCredit = Number(env.SIGNUP_FREE_CREDIT_USD || "2.00");
  const apiKey = await createClient(env, email, freeCredit);
  return json({
    api_key: apiKey,
    free_credit_usd: freeCredit,
    price_usd_per_call: Number(env.PRICE_USD || "0.02"),
    note: "Send this key as 'Authorization: Bearer <key>' to /v1/check. UNKNOWN answers are free.",
    data_policy: (env.PUBLIC_BASE_URL || "") + "/data-policy",
  });
}

async function handleCheck(request, env) {
  const price = Number(env.PRICE_USD || "0.02");
  const chargeOnUnknown = String(env.CHARGE_ON_UNKNOWN || "false") === "true";

  // 1) Autenticación — o tramo de prueba SIN clave (para agentes autónomos).
  const apiKey = bearer(request);
  if (!apiKey) {
    const trial = await freeTrial(env, request);
    if (!trial.allowed)
      return educated402(env, "Free trial not available (limit reached or disabled). Sign up for an API key with free credit.");
    // Entrada válida y consulta gratis (con topes). No se cobra.
    let body;
    try { body = await request.json(); } catch { return errorResponse("INVALID_INPUT", "Body must be JSON.", 400); }
    const v = validateRequest(body);
    if (!v.ok) return errorResponse(v.code, v.message, 400);
    let resp;
    try { resp = await runCheck(env, v.value); }
    catch (e) {
      if (e instanceof EngineError) return errorResponse(e.code, e.message, e.http);
      return errorResponse("INTERNAL", "Unexpected error.", 500);
    }
    return json(resp, { headers: {
      "X-ReturnCheck-Free": "true",
      "X-Free-Remaining-Today": String(trial.remaining),
      "X-ReturnCheck-Cost": "0.0000",
    }});
  }
  const client = await getClient(env, apiKey);
  if (!client) return errorResponse("INVALID_INPUT", "Unknown API key.", 401);
  if (client.status !== "active") return errorResponse("INVALID_INPUT", "Account is not active.", 403);

  // 2) Entrada
  let body;
  try { body = await request.json(); } catch { return errorResponse("INVALID_INPUT", "Body must be JSON.", 400); }
  const v = validateRequest(body);
  if (!v.ok) return errorResponse(v.code, v.message, 400);

  // 3) ¿Tiene saldo para al menos una consulta? Si no, 402 (no gastamos cómputo).
  if (client.balance_usd < price) return educated402(env, "Insufficient balance. Please top up.");

  // 4) Motor (errores de proceso -> NO se cobra)
  let resp;
  try {
    resp = await runCheck(env, { ...v.value, __api_key: apiKey });
  } catch (e) {
    if (e instanceof EngineError) return errorResponse(e.code, e.message, e.http);
    return errorResponse("INTERNAL", "Unexpected error.", 500);
  }

  // 5) Cobro: UNKNOWN es gratis (decisión 22 ago). Determinante -> cobro atómico.
  let cost = 0, remaining = client.balance_usd;
  const isUnknown = resp.verdict === "UNKNOWN";
  const shouldCharge = !isUnknown || chargeOnUnknown;
  if (shouldCharge) {
    const charge = await chargeAtomic(env, apiKey, price, resp.evidence ? resp.evidence.policy_version : null);
    if (!charge.charged) return educated402(env, "Insufficient balance. Please top up.");
    cost = price; remaining = charge.remaining;
    // W19 — que el registro sepa si esto se cobro. "Me cobrasteis por una
    // respuesta mala" es la reclamacion que mas importa poder mirar.
    await markAnswerCharged(env, resp.meta && resp.meta.check_id, price, true);
  } else {
    await markFree(env, apiKey); // UNKNOWN gratis
    await markAnswerCharged(env, resp.meta && resp.meta.check_id, 0, false);
  }

  return json(resp, {
    headers: {
      "X-ReturnCheck-Cost": cost.toFixed(4),
      "X-Client-Remaining-Balance": (remaining ?? 0).toFixed(4),
    },
  });
}

async function handleBalance(request, env) {
  const apiKey = bearer(request);
  const client = await getClient(env, apiKey);
  if (!client) return errorResponse("INVALID_INPUT", "Unknown API key.", 401);
  return json({
    balance_usd: client.balance_usd,
    calls_charged: client.calls_charged,
    calls_free: client.calls_free,
  });
}

const DASHBOARD_HTML = `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ReturnCheck — Panel</title>
<style>
:root{--bg:#0d1014;--card:#161b22;--ink:#e7ebf0;--mut:#9ba6b4;--hair:#242b34;--acc:#2fbda5;
--yes:#37c08d;--cond:#e0a24a;--no:#f27363;--unk:#9ba6b4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:960px;margin-inline:auto}
h1{font-size:1.5rem;margin:0 0 2px}.sub{color:var(--mut);font-size:.85rem;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--hair);border-radius:12px;padding:14px 16px}
.card .n{font-size:1.9rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.card .l{color:var(--mut);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.sec{margin-top:26px}.sec h2{font-size:1rem;color:var(--mut);font-weight:600;margin:0 0 10px}
.bar{display:flex;height:26px;border-radius:8px;overflow:hidden;border:1px solid var(--hair)}
.bar>div{display:flex;align-items:center;justify-content:center;font-size:.72rem;color:#04140f;font-weight:700;min-width:0}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:.8rem;color:var(--mut)}
.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:middle}
button{background:var(--acc);color:#04140f;border:0;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:6px}
td{padding:6px 4px;border-bottom:1px solid var(--hair)}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.err{color:var(--no);margin-top:14px}
</style></head><body>
<div class="row"><div><h1>ReturnCheck — Panel</h1><div class="sub" id="upd">cargando…</div></div>
<button onclick="load()">Actualizar</button></div>
<div class="grid" id="cards"></div>
<div class="sec"><h2>Veredictos</h2><div class="bar" id="bar"></div><div class="legend" id="legend"></div></div>
<div class="sec"><h2>Cómo se resolvió (vía)</h2><table id="via"></table></div>
<div id="err" class="err"></div>
<script>
const K="__KEY__";
function card(n,l){return '<div class="card"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
async function load(){
 try{
  const r=await fetch('/stats?k='+K); if(!r.ok)throw new Error('HTTP '+r.status);
  const d=await r.json();
  document.getElementById('upd').textContent='Actualizado: '+d.updated;
  document.getElementById('err').textContent='';
  document.getElementById('cards').innerHTML=[
   card(d.checks_total,'Consultas totales'),
   card(d.determinate_rate+'%','Con veredicto (no UNKNOWN)'),
   card(d.clients,'Clientes dados de alta'),
   card(d.cached_policies,'Políticas en caché'),
   card(d.free_trial_today,'Pruebas gratis hoy'),
   card('$'+d.metered_revenue_usd,'Ingreso medido (no real)')
  ].join('');
  const v=d.verdicts, tot=Math.max(1,d.checks_total);
  const seg=[['YES',v.YES,'#37c08d'],['YES_WITH_CONDITIONS',v.YES_WITH_CONDITIONS,'#2fbda5'],['NO',v.NO,'#f27363'],['UNKNOWN',v.UNKNOWN,'#9ba6b4']];
  document.getElementById('bar').innerHTML=seg.map(s=>{const p=(s[1]/tot*100);return p>0?'<div style="width:'+p+'%;background:'+s[2]+'">'+(p>=8?Math.round(p)+'%':'')+'</div>':''}).join('');
  document.getElementById('legend').innerHTML=seg.map(s=>'<span><span class="dot" style="background:'+s[2]+'"></span>'+s[0]+': '+s[1]+'</span>').join('');
  const via=d.via;
  document.getElementById('via').innerHTML=[
   ['Datos estructurados (texto)',via.structured_data],
   ['schema.org JSON-LD',via.structured_data_jsonld],
   ['Navegador (page_parse)',via.page_parse],
   ['Caché',d.cache_hits]
  ].map(x=>'<tr><td>'+x[0]+'</td><td>'+x[1]+'</td></tr>').join('');
 }catch(e){document.getElementById('err').textContent='Error cargando /stats: '+e.message}
}
load();
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (request.method === "POST" && p === "/v1/signup") return await handleSignup(request, env);
      if (request.method === "POST" && (p === "/v1/check" || p === "/v1/check_return")) return await handleCheck(request, env);
      if (request.method === "GET" && p === "/v1/balance") return await handleBalance(request, env);
      if (request.method === "POST" && p === "/v1/agent/check")
        return educated402(env, "Agentic x402 endpoint is wired but not yet enabled (Phase 2). Use /v1/check with an API key.");
      if (request.method === "POST" && p === "/webhooks/stripe") return await handleStripeWebhook(request, env);
      // Servidor MCP (Streamable HTTP): descubrimiento y llamada de check_return por agentes.
      if (p === "/mcp") return await handleMcp(request, env);
      // Manifiestos de descubrimiento para agentes/crawlers.
      if (request.method === "GET" && p === "/llms.txt") return llmsTxt(env);
      if (request.method === "GET" && p === "/data-policy") return dataPolicy(env);
      if (request.method === "GET" && (p === "/openapi.json" || p === "/.well-known/openapi.json")) return openapi(env);
      if (request.method === "GET" && (p === "/.well-known/ai-plugin.json" || p === "/ai-plugin.json")) return aiPluginJson(env);
      if (request.method === "GET" && (p === "/agents.json" || p === "/.well-known/agents.json")) return agentsJson(env);
      // Panel de control (protegido con clave de administrador).
      if (request.method === "GET" && p === "/stats") return await handleStats(request, env, url);
      // W16 — AVISOS DE CAMBIO DE POLITICA. Se PIDEN, no se empujan: un agente es
      // un programa que pregunta, no un buzon que recibe. Sin webhooks no hay
      // entregas perdidas ni reintentos. Requiere clave: es para clientes, y el
      // cliente se identifica por el hash de su clave, nunca por su correo.
      if (p === "/v1/watch" || p === "/v1/watchlist" || p === "/v1/changes") {
        const k = bearer(request);
        if (!k) return errorResponse("INVALID_INPUT", "An API key is required for change alerts.", 401);
        const cliente = await getClient(env, k);
        if (!cliente) return errorResponse("INVALID_INPUT", "Unknown API key.", 401);
        const ref = await sha256full(k);   // el MISMO hash que usa el corpus

        if (request.method === "POST" && p === "/v1/watch") {
          const b = await request.json().catch(() => ({}));
          const r = await addWatch(env, ref, b && b.domain);
          if (!r.ok) return errorResponse("INVALID_INPUT", r.error, 400);
          return json(r);
        }
        if (request.method === "DELETE" && p === "/v1/watch") {
          const b = await request.json().catch(() => ({}));
          const r = await removeWatch(env, ref, b && b.domain);
          if (!r.ok) return errorResponse("INVALID_INPUT", r.error, 400);
          return json(r);
        }
        if (request.method === "GET" && p === "/v1/watchlist") {
          return json({ watching: await listWatches(env, ref) });
        }
        if (request.method === "GET" && p === "/v1/changes") {
          return json(await changesFor(env, ref, {
            since: url.searchParams.get("since"),
            limit: url.searchParams.get("limit"),
          }));
        }
        return errorResponse("INVALID_INPUT", "Method not allowed for this path.", 405);
      }

      if (request.method === "GET" && p === "/eval") return await handleEval(request, env, url);

      // W14 — Administracion del corpus. La via de borrado por comercio existe
      // ANTES de que haga falta: es la contrapartida de haber decidido guardarlo
      // todo (doc 40). Si un comercio reclama, esto tiene que funcionar a la
      // primera y sin improvisar.
      // W19 — consulta del registro de respuestas. Es la herramienta de
      // reclamaciones: se entra por el check_id que el cliente cita, o por
      // comercio y fechas cuando no lo tiene. Clave en cabecera, nunca en la URL.
      if (request.method === "GET" && p === "/admin/answers") {
        if (!adminOk(request, url, env)) return errorResponse("UNAUTHORIZED", "Admin key required.", 401);
        const q = url.searchParams;
        if (q.get("stats") === "1") return json(await answerStats(env));
        return json(await findAnswers(env, {
          id: q.get("id"), clientRef: q.get("client_ref"), domain: q.get("domain"),
          since: q.get("since"), until: q.get("until"), verdict: q.get("verdict"),
          limit: q.get("limit") || 50,
        }));
      }
      // Barrido de retencion. Prometer 12 meses y no tener el boton es peor que
      // no prometerlo (doc 40, punto 3).
      if (request.method === "POST" && p === "/admin/answers/purge") {
        if (!adminOk(request, url, env)) return errorResponse("UNAUTHORIZED", "Admin key required.", 401);
        const body = await request.json().catch(() => ({}));
        if (body && body.client_ref) return json(await deleteClientAnswers(env, body.client_ref));
        return json(await purgeExpiredAnswers(env));
      }
      if (request.method === "GET" && p === "/admin/corpus") {
        if (!adminOk(request, url, env)) return errorResponse("INVALID_INPUT", "Not found.", 404);
        return json(await corpusStats(env));
      }
      if (request.method === "POST" && p === "/admin/corpus/delete") {
        if (!adminOk(request, url, env)) return errorResponse("INVALID_INPUT", "Not found.", 404);
        const body = await request.json().catch(() => ({}));
        if (!body || !body.domain)
          return errorResponse("INVALID_INPUT", "domain is required.", 400);
        // El purgado fisico se pide a proposito: un borrado por error se puede
        // deshacer mientras siga siendo logico.
        const r = await deleteMerchantCorpus(env, body.domain, { purge: body.purge === true });
        if (!r.ok) return errorResponse("INVALID_INPUT", r.error, 400);
        return json(r);
      }
      if (request.method === "GET" && p === "/dashboard") return dashboardPage(env, url);
      // Ruta de PRUEBA (sin cobro), PROTEGIDA con clave. Para enseñar la demo sin abuso.
      // TODO: quitar del todo antes del lanzamiento público.
      if (request.method === "GET" && p === "/demo") {
        if (!env.DEMO_KEY || url.searchParams.get("k") !== env.DEMO_KEY)
          return errorResponse("INVALID_INPUT", "Not found.", 404); // oculta la ruta si falta la clave
        const u = url.searchParams.get("url");
        if (!u) return errorResponse("INVALID_INPUT", "Añade ?url=<url_del_producto> (y opcional &condition=unopened&country=US&delivery_date=YYYY-MM-DD)", 400);
        try {
          const r = await runCheck(env, {
            product_url: u,
            buyer_country: url.searchParams.get("country") || "US",
            item_condition: url.searchParams.get("condition") || undefined,
            purchase_date: url.searchParams.get("purchase_date") || undefined,
            delivery_date: url.searchParams.get("delivery_date") || undefined,
            seller_name: url.searchParams.get("seller") || undefined,
            membership: url.searchParams.get("membership") || undefined,
            purchase_channel: url.searchParams.get("purchase_channel") || undefined,
            page_text: url.searchParams.get("page_text") || undefined,
          });
          return json(r);
        } catch (e) {
          // Debug de /demo: devolvemos el error real (status 200 para poder leerlo).
          return json({
            demo_error: true,
            code: e && e.code,
            name: e && e.name,
            message: e && e.message,
            stack: String((e && e.stack) || "").split("\n").slice(0, 6),
          }, { status: 200 });
        }
      }
      if (p === "/") return json({
        name: "ReturnCheck",
        build: BUILD,      // marcador de versión para verificar el deploy
        model: env.AI_MODEL || "default-8b-fast",
        temperature: inferenceParams(env).temperature,   // W05: qué rama del experimento está viva
        candidate_clauses: String(env.USE_CANDIDATES ?? "true") !== "false",
        mcp_endpoint: (env.PUBLIC_BASE_URL || "") + "/mcp",
        data_policy: (env.PUBLIC_BASE_URL || "") + "/data-policy",
        free_trial: String(env.FREE_TRIAL_ENABLED || "false") === "true",
        browser_fallback: String(env.USE_BROWSER || "false") === "true",
        question: "Can this specific product actually be returned?",
        endpoints: { check: "POST /v1/check", signup: "POST /v1/signup", balance: "GET /v1/balance" },
        price_usd_per_call: Number(env.PRICE_USD || "0.02"),
        unknown_is_free: true,
      });
      return errorResponse("INVALID_INPUT", "Not found.", 404);
    } catch (e) {
      return errorResponse("INTERNAL", "Unexpected error.", 500);
    }
  },
};
