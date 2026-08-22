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

  // 1) Autenticación
  const apiKey = bearer(request);
  if (!apiKey) return educated402(env, "Missing API key. Sign up to get one and top up your balance.");
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
      // Ruta de PRUEBA (sin auth, sin cobro). Para validar el motor desde el navegador.
      // TODO: quitar o proteger antes del lanzamiento público.
      if (request.method === "GET" && p === "/demo") {
        const u = url.searchParams.get("url");
        if (!u) return errorResponse("INVALID_INPUT", "Añade ?url=<url_del_producto> (y opcional &condition=unopened&country=US)", 400);
        try {
          const r = await runCheck(env, {
            product_url: u,
            buyer_country: url.searchParams.get("country") || "US",
            item_condition: url.searchParams.get("condition") || undefined,
            purchase_date: url.searchParams.get("purchase_date") || undefined,
          });
          return json(r);
        } catch (e) {
          if (e instanceof EngineError) return errorResponse(e.code, e.message, e.http);
          return errorResponse("INTERNAL", "Unexpected error in demo.", 500);
        }
      }
      if (p === "/") return json({
        name: "ReturnCheck",
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
