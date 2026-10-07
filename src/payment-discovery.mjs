// Public, static examples only: never publish a caller's body or signature.
export const CHECK_EXAMPLE = {
  product_url: "https://shop.example/product/1",
  buyer_country: "US",
  item_condition: "unopened",
  page_text: "New and unopened products may be returned within 30 days of delivery with proof of purchase.",
};

export function paymentIdentifierExtension() {
  return {
    info: { required: true },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        required: { type: "boolean" },
        id: { type: "string", minLength: 16, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
      },
      required: ["required"],
    },
  };
}

export function paymentExtensions(url = "/v1/check") {
  const extensions = { "payment-identifier": paymentIdentifierExtension() };
  const path = new URL(url, "https://returncheck.example").pathname;
  // MCP uses another wire format. Do not label JSON-RPC as an HTTP CheckRequest.
  if (!["/v1/check", "/v1/check_return"].includes(path)) return extensions;
  extensions.bazaar = {
    info: { input: { type: "http", method: "POST", bodyType: "json", body: { ...CHECK_EXAMPLE } } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", const: "json" },
            body: {
              type: "object", required: ["product_url", "buyer_country"],
              properties: {
                product_url: { type: "string", format: "uri" },
                buyer_country: { type: "string" },
                item_condition: { type: "string", enum: ["unopened", "opened", "used", "defective"] },
                page_text: { type: "string", description: "Caller-supplied policy text. Additional request fields are documented in OpenAPI." },
              },
            },
          },
          required: ["type", "method", "bodyType", "body"],
        },
      },
      required: ["input"],
    },
  };
  return extensions;
}

export const PAYMENT_INSTRUCTIONS = {
  envelope: {
    encoding: "base64-json",
    required_top_level: ["x402Version", "accepted", "payload", "extensions"],
    accepted_from: "Copy the complete accepts[0] object from the live 402 challenge.",
    payload_shape: "payload directly contains signature and authorization; do not nest another PaymentPayload.",
    client_extensions: ["payment-identifier"],
    do_not_copy_extensions: ["bazaar"],
    resource: "Clients do not need to send resource; ReturnCheck sets the served resource before facilitator verification.",
  },
  identifier_path: 'extensions["payment-identifier"].info.id',
  legacy_identifier_path: 'payload.extensions["payment-identifier"]',
  identifier_required: true,
  identifier_pattern: "^[a-zA-Z0-9_-]{16,128}$",
  legacy_supported: true,
  discovery_probe: "POST /v1/check with no body and no PAYMENT-SIGNATURE returns the live 402 challenge before free-trial accounting. Do not send {} or a real check body for discovery.",
  retry: "After a paid attempt that may have reached settlement, reuse the same endpoint, body, identifier, signature and nonce; never create a second authorization to recover an uncertain outcome. If an authorization expires before any paid attempt is sent, sign a fresh one and use that exact fresh authorization for the later replay.",
  authorization_expiry: "If the authorization expires before the paid call, sign a fresh authorization. If that fresh authorization settles, replay that exact new authorization, signature and nonce.",
  free_trial: "Unsigned requests may use the free allowance. PAYMENT-SIGNATURE enters the payment path directly; no need to exhaust the allowance.",
  unknown: "UNKNOWN is not settled.",
};

// Documentacion de los desenlaces REALES del camino de pago. Cada texto describe
// lo que el codigo devuelve hoy y la instruccion de parada que le corresponde. No
// se promete ausencia de cargo donde el codigo no la puede garantizar: `pending` y
// `unconfirmed` significan que no se sabe, y eso se dice con esas palabras.
const ERROR_BODY = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };

// Los desenlaces del cobro (409, 503, el identificador y el estado de liquidacion)
// SOLO existen cuando x402 esta activo. Documentarlos con x402 apagado seria
// anunciar errores que no pueden ocurrir, asi que se anaden aparte.
export function checkResponses(conPago = false) {
  if (!conPago) {
    return {
      "200": {
        description:
          "Verified answer (contract v1.0). X-ReturnCheck-Cost reports what THIS call charged, " +
          "4 decimals; it is 0.0000 for a free-allowance answer and for UNKNOWN.",
        headers: { "X-ReturnCheck-Cost": CHECK_RESPONSES["200"].headers["X-ReturnCheck-Cost"] },
      },
      "400": {
        description:
          "error.code INVALID_INPUT: the body is not JSON or fails the contract. Nothing is executed; fix the body and retry.",
        content: ERROR_BODY,
      },
      "402": {
        description:
          "Payment required: the free allowance is exhausted or unavailable. With x402 off this is the educated 402, " +
          "which carries no challenge because no payment terms are configured. Besides error.code PAYMENT_REQUIRED " +
          "the body also carries a how_to_pay block describing the prepaid route.",
        content: ERROR_BODY,
      },
      "500": CHECK_RESPONSES["500"],
    };
  }
  return CHECK_RESPONSES;
}

const CHECK_RESPONSES = {
  "200": {
    description:
      "Verified answer (contract v1.0). Consult the payment headers for settlement status. " +
      "X-ReturnCheck-Settlement is confirmed, pending, unconfirmed, not_charged or replay. " +
      "pending and unconfirmed do NOT mean the call was free: they mean neither side knows yet. " +
      "Do not assume you were not charged and do not create a second authorization; reuse the same identifier. " +
      "A replay returns the stored answer with X-ReturnCheck-Replay: true and X-ReturnCheck-Cost: 0.0000, " +
      "which means this call did not settle again — not that the original one did not settle.",
    headers: {
      "X-ReturnCheck-Cost": { description: "Reported USD cost, 4 decimals. A nonzero value does not prove settlement when status is pending or unconfirmed. 0.0000 on replays and on UNKNOWN.", schema: { type: "string" } },
      "X-ReturnCheck-Settlement": { description: "confirmed | pending | unconfirmed | not_charged | replay.", schema: { type: "string", enum: ["confirmed", "pending", "unconfirmed", "not_charged", "replay"] } },
      "X-ReturnCheck-Replay": { description: "Present and true when the stored answer for this identifier is served again.", schema: { type: "string" } },
      "PAYMENT-RESPONSE": { description: "Base64 x402 SettlementResponse. Inspect success and errorReason; its presence alone does not prove payment. An uncertain replay omits this header; confirmed or historical replays require a stored transaction hash.", schema: { type: "string" } },
    },
  },
  "400": {
    description:
      "Invalid input, or a signed call without a usable payment identity. " +
      'error.code INVALID_INPUT: the body is not JSON or fails the contract. ' +
      'error.code PAYMENT_IDENTIFIER_REQUIRED: no valid extensions["payment-identifier"].info.id, ' +
      "or the standard and legacy locations carry different identifiers, which is never resolved by picking one. " +
      "Rejected before the idempotency gate, the engine and the facilitator: nothing was verified and nothing was settled. " +
      "Fix the envelope and retry with the same identifier.",
    content: ERROR_BODY,
  },
  "402": {
    description:
      "Payment required. The body and the PAYMENT-REQUIRED header carry the challenge, including extensions. " +
      "Cases: no PAYMENT-SIGNATURE, a signature that does not match the published terms, failed verification, " +
      "an exhausted free allowance, and a settlement that the facilitator rejected. " +
      "In the rejected-settlement case /settle was already invoked, so that identifier is not retried automatically: " +
      "reconcile before authorizing again, and do not assume the rejected attempt cost nothing.",
  },
  "409": {
    description:
      "Payment identifier conflict. Nothing is settled again in either case. " +
      "error.code CONFLICT: this identifier is already bound to a different request fingerprint " +
      "(same id, different payload), which the payment-identifier extension requires to fail instead of " +
      "replaying or charging twice. Use a new identifier for a genuinely different request. " +
      "error.code PAYMENT_IN_FLIGHT: another request owns this identifier and is still processing. " +
      "Retry the identical request with the same identifier.",
    content: ERROR_BODY,
  },
  "500": {
    description:
      "error.code INTERNAL, or an engine error with its own code. HTTP 500 alone does not establish whether settlement was attempted. " +
      "Stop and reconcile the outcome before retrying; preserve the identical request, identifier and signed authorization. Never create a second authorization to recover from this error.",
    content: ERROR_BODY,
  },
  "503": {
    description:
      "error.code PAYMENT_GATE_UNAVAILABLE. The gate is unavailable or did not grant an authoritative owner, " +
      "the result could not be persisted before settlement, or the result could not be committed for a " +
      "verdict that is never settled. This attempt did not invoke /settle; another attempt may still own the identifier. " +
      "Retry the identical request with the same identifier, never with a second authorization.",
    content: ERROR_BODY,
  },
};

export const ERROR_SCHEMA = {
  type: "object",
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", description: "Stable machine code, e.g. INVALID_INPUT, PAYMENT_IDENTIFIER_REQUIRED, CONFLICT, PAYMENT_IN_FLIGHT, PAYMENT_GATE_UNAVAILABLE, INTERNAL." },
        message: { type: "string" },
        details: { type: "object", description: "Optional, present only when the handler supplies it." },
      },
    },
  },
  required: ["error"],
};
