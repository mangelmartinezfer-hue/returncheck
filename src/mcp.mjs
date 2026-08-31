// Servidor MCP (Streamable HTTP) para ReturnCheck.
// Expone la herramienta `check_return` para que los agentes que hablan MCP nos
// descubran y llamen. Transporte: un solo endpoint POST /mcp con JSON-RPC 2.0.
// Sin estado (no exige sesión). tools/list es libre (descubrimiento);
// tools/call exige API key (mismo cobro que /v1/check).

import { validateRequest } from "./contract.mjs";
import { runCheck, EngineError } from "./engine.mjs";
import { getClient, chargeAtomic, markFree } from "./billing.mjs";
import { freeTrial } from "./freetier.mjs";
import { x402Activo, validarSobreDePago, sacarDelSobre, cabeceraLiquidacion } from "./x402.mjs";
import { retoConPuertaHumana, cobrarConX402 } from "./cobro-x402.mjs";

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
      // W48 — PAGO SIN CUENTA, POR AQUI DENTRO.
      //
      // MCP va sobre JSON-RPC y ahi no hay cabeceras: la cabecera
      // PAYMENT-SIGNATURE que usa /v1/check no tiene donde viajar. El sobre es el
      // mismo, solo cambia el vehiculo, asi que entra como argumento.
      //
      // OPCIONAL A PROPOSITO: es una adicion, no una ruptura. Un agente que ya
      // nos llamaba sigue llamando igual, el contrato v1.0 no se toca, y este
      // campo nunca llega al motor (validateRequest solo deja pasar los campos
      // del contrato).
      payment_signature: {
        type: "string",
        description:
          "OPTIONAL. x402 payment authorization, base64 — the same envelope the PAYMENT-SIGNATURE header carries over HTTP. " +
          "Use it to pay per call with no account and no signup. How: call once without it; if the free trial is exhausted " +
          "you get the payment terms in structuredContent (x402Version, accepts[]); sign that authorization and call again " +
          "with payment_signature set. Terms are also published at /.well-known/x402. UNKNOWN verdicts are never settled: " +
          "the authorization simply expires unused.",
      },
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

  // W48 — CAMINO DE PAGO. Se mira ANTES del tramo gratis, exactamente por la misma
  // razon que en /v1/check: quien ofrece pagar no debe gastar su cuota gratuita
  // sin querer.
  if (x402Activo(env) && typeof args.payment_signature === "string" && args.payment_signature.trim())
    return await pagarConX402(args, env, request);

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
    // W48 — AQUI ESTABA EL CALLEJON SIN SALIDA, todavia. En W32 el 402 de
    // /v1/check dejo de ser un muro y paso a ser una puerta; este mismo momento,
    // en MCP, seguia devolviendo un parrafo pidiendo un correo. Un agente
    // autonomo no tiene correo. Con x402 encendido, aqui va el reto de pago.
    // El interruptor manda, igual que en /v1/check: con x402 apagado aqui no
    // cambia absolutamente nada. Y si `retoMcp` no puede construirlo (falta
    // direccion de cobro), se cae al mensaje de alta de siempre: sin direccion de
    // cobro no se anuncia precio.
    if (x402Activo(env)) {
      const reto = retoMcp(env, request, "Free trial exhausted. Payment required.");
      if (reto) return reto;
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

// ---------------------------------------------------------------------------
// W48 — EL RETO DE PAGO, TRADUCIDO AL PROTOCOLO.
//
// EL PROBLEMA DE PROTOCOLO. Sobre HTTP el reto viaja en un codigo 402 y en la
// cabecera PAYMENT-REQUIRED. En MCP no hay ni una cosa ni la otra: todo va por
// JSON-RPC, y una respuesta de herramienta solo tiene `content`, `isError` y
// `structuredContent`. Asi que el CONTENIDO del reto se mueve entero a
// `structuredContent`, que es el sitio que el protocolo tiene para datos que la
// maquina lee. El `content` en texto queda para quien lo lea un humano.
//
// Es el MISMO objeto que el cuerpo del 402 de HTTP —se construye con la misma
// funcion— asi que un agente que ya sepa leer nuestro 402 no tiene que aprender
// nada nuevo: reconoce `x402Version` y `accepts` igual que alli.
//
// Devuelve null si falta configuracion de cobro. Quien llama decide a que se cae.
// ---------------------------------------------------------------------------
function retoMcp(env, request, motivo) {
  const precio = String(env.PRICE_USD || "0.02");
  const r = retoConPuertaHumana(env, { url: request.url, motivo, precio });
  if (!r) return null;

  const base = env.PUBLIC_BASE_URL || "";
  const texto =
    "Payment required: " + motivo + " There are two ways to pay, and both are open.\n\n" +
    "1) x402 (no account, no signup — for autonomous agents). The payment terms are in " +
    "structuredContent.accepts: amount, asset, network and payTo. Sign that authorization and call " +
    "check_return again with the base64 envelope in the 'payment_signature' argument. Terms are also " +
    "published at " + (base ? base : "") + "/.well-known/x402.\n\n" +
    "2) Email signup (for a human developer). POST your email to " + (base ? base : "") + "/v1/signup " +
    "to get an API key with free credit, then call with 'Authorization: Bearer <key>'. " +
    "Details in structuredContent.human_next_steps.\n\n" +
    "UNKNOWN answers are free on both paths: we do not settle a payment for an answer we could not verify.";

  return {
    content: [{ type: "text", text: texto }],
    structuredContent: r.cuerpo,
    // La llamada NO ha producido un veredicto: para el agente que solo mira esta
    // bandera, esto es un fallo con instrucciones, no una respuesta.
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// W49 — LA PRUEBA DE QUE SE PAGO, VISIBLE POR MCP.
//
// EL HUECO QUE CIERRA. Por HTTP, despues de pagar, el cliente recibe tres
// cabeceras: PAYMENT-RESPONSE (el sobre con el hash de la transaccion),
// X-ReturnCheck-Cost y X-ReturnCheck-Settlement. Por MCP no habia nada:
// `cobrarConX402` ya calculaba las tres cosas y `pagarConX402` las TIRABA, y
// jsonRpcHttp solo pone content-type y CORS. Resultado: por MCP el hash de la
// transaccion era inaccesible y una respuesta PAGADA era indistinguible de una
// del TRAMO GRATIS. Eso rompia la cadena de evidencia justo por la puerta que
// abrimos en W48.
//
// POR QUE VA DENTRO DE structuredContent, Y NO COMO CAMPO HERMANO DE `content`.
// Esto es deliberado y tiene un coste conocido: structuredContent deja de ser
// byte a byte identico al cuerpo de /v1/check. NO LO "ARREGLES" SACANDOLO FUERA.
// La alternativa era ponerlo como hermano de content/structuredContent, lo que
// mantendria esa identidad, pero un SDK de MCP con tipos estrictos puede
// DESCARTAR SILENCIOSAMENTE un campo que no conoce — y una evidencia que el
// cliente no recibe no es una evidencia. Se prefiere perder la identidad byte a
// byte (que hoy no depende nada de ella) antes que perder el dato.
// El cuerpo de /v1/check NO cambia: el contrato v1.0 sigue congelado y esto solo
// existe en el resultado de la herramienta MCP.
//
// LA REGLA QUE NO SE PUEDE ROMPER: el bloque aparece SOLO si hubo liquidacion de
// verdad. Estamos eliminando la ambiguedad "pagado o gratis"; introducirla del
// reves —que algo gratuito parezca pagado— seria peor que el hueco original.
// Por eso:
//   · tramo gratis  -> nunca pasa por aqui, no hay bloque
//   · reto 402      -> no hay bloque
//   · UNKNOWN       -> SE PRESENTO UNA AUTORIZACION DE PAGO, PERO NO SE PRODUJO
//                      LIQUIDACION porque el resultado fue UNKNOWN. La
//                      autorizacion caduca sin usarse y no se mueve un centimo,
//                      asi que no hay pago que demostrar y no hay bloque.
//                      Presentar una autorizacion NO es haber pagado, y ese es
//                      justo el matiz que este bloque no puede difuminar.
//   · confirmed / pending / unconfirmed -> bloque, porque el dinero se movio o
//                      esta en vuelo, y en los dos casos hay algo que cotejar
//   · reintento     -> bloque, con la transaccion del cobro ORIGINAL y coste 0
// ---------------------------------------------------------------------------

// Los estados en los que existe una liquidacion real. "not_charged" NO esta, y
// esa ausencia es la regla de arriba hecha codigo. "replay" si esta: la
// liquidacion existio, fue la del cobro original, y su transaccion es cotejable.
const LIQUIDACION_REAL = new Set(["confirmed", "pending", "unconfirmed", "replay"]);

/**
 * El bloque de evidencia de pago. Se construye A PARTIR DEL SOBRE, no en
 * paralelo: asi `transaction`, `network` y `payer` no pueden discrepar de lo que
 * dice `payment_response`, que es el mismo base64 que viaja por la cabecera
 * PAYMENT-RESPONSE en HTTP. Devuelve null cuando no hay liquidacion real.
 */
function bloqueX402({ estado, cabecera, coste, redPorDefecto }) {
  if (!LIQUIDACION_REAL.has(estado) || !cabecera) return null;
  const sobre = sacarDelSobre(cabecera) || {};
  return {
    settlement: estado,
    transaction: sobre.transaction || null,
    network: sobre.network || redPorDefecto || null,
    payer: sobre.payer || null,
    cost_usd: Number(coste || 0).toFixed(4),
    // El sobre crudo, para que la evidencia por MCP sea identica a la de HTTP.
    payment_response: cabecera,
  };
}

/** Resultado de herramienta con el veredicto y, si la hubo, la prueba del pago. */
function resultadoConPago(resp, x402) {
  const cuerpo = x402 ? { ...resp, x402 } : resp;
  const texto = JSON.stringify(cuerpo);
  return { content: [{ type: "text", text: texto }], structuredContent: cuerpo, isError: false };
}

// ---------------------------------------------------------------------------
// W48 — EL COBRO. No hay logica de pago aqui: la que hay esta en cobro-x402.mjs
// y es LA MISMA que ejecuta /v1/check. Esta funcion solo traduce entrada y salida.
// ---------------------------------------------------------------------------
async function pagarConX402(args, env, request) {
  const precio = String(env.PRICE_USD || "0.02");

  // 1) La firma, por el MISMO verificador del HTTP — incluida la comprobacion de
  //    que lo aceptado coincide con lo que pedimos, que no se delega en el
  //    facilitador. Si no cuadra, se devuelve el reto otra vez con el motivo.
  const firma = validarSobreDePago(args.payment_signature, env, { precio });
  if (!firma.ok) return retoMcp(env, request, firma.error) || toolText("Payment required: " + firma.error, true);
  const aceptado = firma.pago.accepted;

  // 2) La peticion, contra el contrato v1.0 sin tocar. `payment_signature` no
  //    sobrevive a validateRequest: el motor nunca lo ve.
  const v = validateRequest(args);
  if (!v.ok) return toolText("Invalid input: " + v.message, true);

  // 3) El cobro compartido.
  const r = await cobrarConX402(env, {
    pago: firma.pago, aceptado, peticion: v.value,
    ruta: new URL(request.url).pathname, precio,
  });

  if (r.tipo === "conflicto")
    return toolText("This payment identifier was already used for a different request.", true);

  // Reintento: se devuelve lo ya servido y NO se ha vuelto a cobrar. La
  // liquidacion existio —fue la del cobro original— asi que la prueba se
  // devuelve igual, con su transaccion y coste 0. Es lo mismo que hace HTTP, que
  // en este caso manda PAYMENT-RESPONSE junto a X-ReturnCheck-Cost: 0.0000.
  if (r.tipo === "repetido") {
    let resp = null;
    try { resp = JSON.parse(r.cuerpo); } catch (_) { resp = null; }
    if (!resp) return toolText("Replay of a previous paid call, but the stored answer could not be read.", true);
    const x402 = r.transaccion
      ? bloqueX402({
          estado: "replay",
          cabecera: cabeceraLiquidacion({
            success: true, transaction: r.transaccion, network: aceptado.network, payer: null }),
          coste: 0,
          redPorDefecto: aceptado.network,
        })
      : null;
    return resultadoConPago(resp, x402);
  }

  // Verificacion o liquidacion caida: se vuelve a pedir pago, con el motivo.
  if (r.tipo === "reto") return retoMcp(env, request, r.motivo) || toolText("Payment required: " + r.motivo, true);

  if (r.tipo === "error") return toolText("Engine error (" + r.code + "): " + r.message + " — not charged.", true);

  // Servida. El bloque solo va si hubo liquidacion real. Con veredicto UNKNOWN
  // `estadoLiquidacion` vale "not_charged": se presento una autorizacion de pago,
  // pero NO se produjo liquidacion, asi que aqui no se adjunta nada. Decirlo al
  // reves —"un UNKNOWN pagado"— seria afirmar un pago que no ocurrio.
  return resultadoConPago(r.resp, bloqueX402({
    estado: r.estadoLiquidacion,
    cabecera: r.cabeceraPago,
    coste: r.coste,
    redPorDefecto: aceptado.network,
  }));
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
