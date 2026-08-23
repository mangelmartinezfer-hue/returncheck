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
import { json, errorResponse } from "./util.mjs";

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
- optional: item_condition, reason, purchase_date, delivery_date, merchant, seller_name
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
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
          },
        },
      },
    },
  };
  return json(spec, { headers: { "access-control-allow-origin": "*" } });
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
    resp = await runCheck(env, v.value);
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
  } else {
    await markFree(env, apiKey); // UNKNOWN gratis
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
      if (request.method === "GET" && (p === "/openapi.json" || p === "/.well-known/openapi.json")) return openapi(env);
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
        build: "2026-08-23-jsonld",         // marcador de versión para verificar el deploy
        model: env.AI_MODEL || "default-8b-fast",
        mcp_endpoint: (env.PUBLIC_BASE_URL || "") + "/mcp",
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
