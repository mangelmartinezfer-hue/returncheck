// Servidor MCP (Streamable HTTP) para ReturnCheck.
// Expone la herramienta `check_return` para que los agentes que hablan MCP nos
// descubran y llamen. Transporte: un solo endpoint POST /mcp con JSON-RPC 2.0.
// Sin estado (no exige sesión). tools/list es libre (descubrimiento);
// tools/call exige API key (mismo cobro que /v1/check).

import { validateRequest } from "./contract.mjs";
import { runCheck, EngineError } from "./engine.mjs";
import { getClient, chargeAtomic, markFree } from "./billing.mjs";
import { freeTrial } from "./freetier.mjs";

const DEFAULT_PROTOCOL = "2025-06-18";

export const TOOL = {
  name: "check_return",
  // W43 — LO QUE LEE UN AGENTE ANTES DE DECIDIR SI NOS LLAMA.
  //
  // Hasta hoy esto decia "manda una URL" y dejaba `page_text` como opcional, el
  // ultimo de la lista. La medicion del 28 de agosto sobre 50 tiendas reales dice
  // que por esa via acertamos 17 de 50. Prometer lo que fallamos dos de cada tres
  // veces es la forma mas cara de perder a un agente: la primera llamada se gasta
  // una sola vez.
  //
  // Se invierte el orden y se publica la cobertura MEDIDA, con su fecha. Es lo
  // mismo que le exigimos al motor: no afirmar mas de lo que sostiene la evidencia.
  description:
    "Answer one question: can this specific product actually be returned? " +
    "BEST RESULTS: send the product page you already have as page_text (or page_html) " +
    "along with product_url — your browser renders JavaScript and is not blocked by " +
    "retailers, so this works on any store and is faster. Without it we fetch the page " +
    "ourselves and reach the policy for about 1 in 3 US retailers (17 of 50 measured " +
    "2026-08-28; mostly Shopify and direct-to-consumer brands — large retailers and " +
    "marketplaces block server-side reads). " +
    "You get a verified verdict — YES / YES_WITH_CONDITIONS / NO / UNKNOWN — with the " +
    "exact policy clause quoted verbatim, source URL, return window/deadline, fees and " +
    "a confidence score. Never invents: returns UNKNOWN instead of guessing, and " +
    "UNKNOWN is free.",
  inputSchema: {
    type: "object",
    properties: {
      product_url: { type: "string", description: "The product page URL (http/https)." },
      buyer_country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. 'US'." },
      item_condition: { type: "string", enum: ["unopened", "opened", "used", "defective"] },
      reason: { type: "string", enum: ["changed_mind", "defective", "wrong_size_or_model", "arrived_late", "other"] },
      purchase_date: { type: "string", description: "YYYY-MM-DD (optional)." },
      delivery_date: { type: "string", description: "YYYY-MM-DD (optional; preferred for the deadline)." },
      merchant: { type: "string" },
      seller_name: { type: "string" },
      page_text: { type: "string", description: "RECOMMENDED. Plain text of the product or returns page you already have open. We verify against this instead of fetching: works on any store, no blocking, no JavaScript problem, and faster. Still never invents: no verifiable clause -> UNKNOWN (free)." },
      page_html: { type: "string", description: "RECOMMENDED (alternative to page_text). Raw HTML of the same page. Slightly better than page_text: we can also read structured data (JSON-LD) from it." },
    },
    required: ["product_url", "buyer_country"],
  },
};

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// Ejecuta la herramienta check_return (tramo gratis sin clave, o con auth + cobro).
async function callCheckReturn(args, env, apiKey, request) {
  const price = Number(env.PRICE_USD || "0.02");
  const chargeOnUnknown = String(env.CHARGE_ON_UNKNOWN || "false") === "true";
  const signup = `${env.PUBLIC_BASE_URL || ""}/v1/signup`;

  // Sin clave: probamos el tramo GRATIS (topes por IP/día y global). Si no queda,
  // pedimos alta. Esto permite que un agente autónomo pruebe sin registrarse.
  if (!apiKey) {
    const trial = await freeTrial(env, request);
    if (trial.allowed) {
      const v = validateRequest(args);
      if (!v.ok) return toolText("Invalid input: " + v.message, true);
      try {
        const resp = await runCheck(env, v.value);
        return { content: [{ type: "text", text: JSON.stringify(resp) }], structuredContent: resp, isError: false };
      } catch (e) {
        if (e instanceof EngineError) return toolText("Engine error (" + e.code + "): " + e.message, true);
        return toolText("Unexpected engine error.", true);
      }
    }
    return toolText(`Free trial limit reached (or disabled). Get a free API key (includes $${Number(env.SIGNUP_FREE_CREDIT_USD || "2").toFixed(2)} of credit) by POSTing your email to ${signup}, then call with 'Authorization: Bearer <key>'. UNKNOWN answers are free; a useful verdict costs $${price}.`, true);
  }
  const client = await getClient(env, apiKey);
  if (!client) return toolText("Unknown API key. Sign up at " + signup, true);
  if (client.status !== "active") return toolText("Account is not active.", true);

  const v = validateRequest(args);
  if (!v.ok) return toolText("Invalid input: " + v.message, true);
  if (client.balance_usd < price) return toolText("Insufficient balance. Top up your prepaid balance to continue.", true);

  let resp;
  try {
    resp = await runCheck(env, v.value);
  } catch (e) {
    if (e instanceof EngineError) return toolText("Engine error (" + e.code + "): " + e.message + " — not charged.", true);
    return toolText("Unexpected engine error — not charged.", true);
  }

  const isUnknown = resp.verdict === "UNKNOWN";
  if (!isUnknown || chargeOnUnknown) {
    const charge = await chargeAtomic(env, apiKey, price, resp.evidence ? resp.evidence.policy_version : null);
    if (!charge.charged) return toolText("Insufficient balance. Please top up.", true);
  } else {
    await markFree(env, apiKey); // UNKNOWN gratis
  }

  // Devolvemos texto legible + el objeto estructurado del contrato.
  return {
    content: [{ type: "text", text: JSON.stringify(resp) }],
    structuredContent: resp,
    isError: false,
  };
}

function toolText(text, isError) {
  return { content: [{ type: "text", text }], isError: !!isError };
}

// Procesa un mensaje JSON-RPC individual. Devuelve el objeto respuesta, o null
// si era una notificación (sin id -> no se responde).
async function handleRpc(msg, env, apiKey, request) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ReturnCheck", version: "1.0.0" },
        instructions: "Call check_return with a product_url and buyer_country. Answers are verified against the merchant's published policy; UNKNOWN is returned instead of guessing.",
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [TOOL] });
    case "tools/call": {
      const name = params && params.name;
      if (name !== "check_return") return rpcError(id, -32602, "Unknown tool: " + name);
      const result = await callCheckReturn((params && params.arguments) || {}, env, apiKey, request);
      return rpcResult(id, result);
    }
    default:
      if (isNotification) return null;             // notificaciones que no manejamos
      return rpcError(id, -32601, "Method not found: " + method);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
};

// Punto de entrada del transporte Streamable HTTP.
export async function handleMcp(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // GET (stream servidor->cliente) opcional: no lo soportamos -> 405 permitido por la spec.
  if (request.method === "GET") return new Response("Method Not Allowed", { status: 405, headers: CORS });
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  let body;
  try { body = await request.json(); }
  catch { return jsonRpcHttp(rpcError(null, -32700, "Parse error"), 400); }

  const apiKey = bearer(request);

  // Lote (array) o mensaje único.
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) {
      const r = await handleRpc(m, env, apiKey, request);
      if (r) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202, headers: CORS });
    return jsonRpcHttp(out, 200);
  }

  const r = await handleRpc(body, env, apiKey, request);
  if (!r) return new Response(null, { status: 202, headers: CORS }); // era notificación
  return jsonRpcHttp(r, 200);
}

function jsonRpcHttp(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
