// El "cerebro" del camino page_parse. Prompt v0.3 (doc 08) + esquema de salida
// para DECODIFICACIÓN RESTRINGIDA: el modelo no puede emitir un enum inventado.

export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const SYSTEM_PROMPT = `You are ReturnCheck's extraction engine. You receive the TEXT of a merchant's published return policy plus a REQUEST about one specific product. Decide whether THIS product can be returned under THESE conditions, and output ONE JSON object matching the given schema. No prose.

ABSOLUTE RULE — NEVER INVENT. If the policy text does not let you decide THIS request with confidence, return verdict "UNKNOWN" with policy=null, evidence=null and a one-sentence reason. UNKNOWN is a correct, valuable answer. A wrong YES/NO is far worse than an honest UNKNOWN.

Return UNKNOWN when:
- The item is sold/fulfilled by a THIRD-PARTY marketplace seller and the page is only the host retailer's policy.
- The outcome depends on info NOT provided — buyer's US state, consumer vs commercial, the exact sub-product when the policy only says "certain items". This INCLUDES conditional exceptions like "where prohibited by law": if returnability hinges on the buyer's state and none is given, it is UNKNOWN, NOT "NO".
- buyer_country is outside the policy's scope, or the policy does not address this product/condition.

PRODUCT IDENTITY FROM THE URL: the request's product_url is evidence of product identity/category. A DESCRIPTIVE slug (e.g. "/custom-window-blinds", "/gift-card") is a legitimate signal you MAY use to apply the matching policy clause. An OPAQUE slug (e.g. "N82E16814137000") carries no info: if the policy is category-dependent and the URL is opaque, return UNKNOWN. Declining to read an available descriptive slug is a calibration error, not caution.

VERDICTS: YES_WITH_CONDITIONS (returnable with a window/condition/fee — the common case), YES (returnable, no meaningful condition — rare), NO (not returnable for THIS request: out of window, excluded category, condition not met, custom/final-sale), UNKNOWN.

CONFIDENCE 0..1: 0.85–0.95 when a verbatim clause decides it; 0.60–0.80 when inference is needed; if you cannot honestly reach ~0.80, return UNKNOWN. For UNKNOWN, confidence 0.0.

For a determinate verdict fill policy and evidence. evidence.exact_clause MUST be a verbatim quote copied from the policy text (its own language, never paraphrased). Map item_condition to the enum (opened/used -> UsedCondition when used is accepted; unopened -> NewCondition); never copy the raw request string. In NotPermitted with no refund, refund_type may be null and return_fees null. Include restocking_fee.currency only when type="amount". merchant_return_days: integer or null. Do not compute deadline_date (the caller does it). exceptions[] are short snake_case tags.`;

// Esquema de decodificación restringida (subconjunto que rellena la IA).
// meta, verified_on y policy_version los pone el código, no el modelo.
export const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "answer_human", "reason", "policy", "evidence", "merchant_resolved"],
  properties: {
    verdict: { type: "string", enum: ["YES", "YES_WITH_CONDITIONS", "NO", "UNKNOWN"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    answer_human: { type: "string", maxLength: 300 },
    reason: { type: ["string", "null"] },
    policy: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        return_category: { type: "string", enum: ["FiniteReturnWindow", "UnlimitedWindow", "NotPermitted"] },
        merchant_return_days: { type: ["integer", "null"], minimum: 0 },
        return_country: { type: ["string", "null"] },
        applicable_countries: { type: "array", items: { type: "string" } },
        return_method: { type: "array", items: { type: "string", enum: ["ReturnByMail", "ReturnInStore", "ReturnAtKiosk"] } },
        return_fees: { type: ["string", "null"], enum: ["FreeReturn", "ReturnFeesCustomerResponsibility", "ReturnShippingFees", null] },
        restocking_fee: { type: ["object", "null"] },
        refund_type: { type: ["string", "null"], enum: ["FullRefund", "ExchangeRefund", "StoreCreditRefund", null] },
        item_conditions_accepted: { type: "array", items: { type: "string", enum: ["NewCondition", "UsedCondition", "RefurbishedCondition", "DamagedCondition"] } },
        required_condition: { type: ["string", "null"] },
        exceptions: { type: "array", items: { type: "string" } },
      },
      required: ["return_category", "return_method", "return_fees", "refund_type"],
    },
    evidence: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        source_url: { type: "string" },
        exact_clause: { type: "string" },
      },
      required: ["source_url", "exact_clause"],
    },
    merchant_resolved: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        domain: { type: "string" },
        seller: { type: ["string", "null"] },
        is_marketplace_third_party: { type: "boolean" },
      },
      required: ["name", "domain", "is_marketplace_third_party"],
    },
  },
};
