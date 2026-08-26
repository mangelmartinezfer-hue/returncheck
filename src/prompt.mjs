// El "cerebro" del camino page_parse. Prompt v0.3 (doc 08) + esquema de salida
// para DECODIFICACIÓN RESTRINGIDA: el modelo no puede emitir un enum inventado.

// Modelo por defecto: RÁPIDO (8B) — ~2s y en pruebas elige bien la cláusula.
// La corrección la blindan clauseInText (la cita existe, por tramo literal) +
// clauseSupportsVerdict (la cita respalda el veredicto). Se puede sobrescribir
// desde Cloudflare con la variable AI_MODEL (p.ej. probar 70B) sin tocar código.
export const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

// W05 — PARÁMETROS DE INFERENCIA. Aquí estaba el agujero.
//
// Hasta hoy la llamada a env.AI.run() no pasaba `temperature`. Workers AI usa
// 0.6 por defecto en generación de texto, así que el motor estaba MUESTREANDO
// AL AZAR en cada llamada, a propósito, sin que nadie lo hubiera decidido.
// El holdout del 24 ago midió 11 casos estables de 25 en cinco pasadas; esta es
// la primera candidata a explicarlo, y nadie la había mirado en cinco días.
//
// NO se afirma que sea LA causa: hay más fuentes de variación (enrutado del
// modelo, lotes, coma flotante). Por eso queda CONFIGURABLE desde el panel de
// Cloudflare: se puede volver a 0.6 sin desplegar y medir las dos ramas contra
// el mismo build. Un experimento con una sola variable, que es lo que faltaba.
export const AI_TEMPERATURE = 0;

// Construye los parámetros de muestreo. Función aparte y exportada A PROPÓSITO:
// que esto sea comprobable por una prueba es justo lo que faltó para que un
// parámetro ausente pasara desapercibido cinco días.
export function inferenceParams(env, attempt = 0) {
  const params = {};

  const raw = env && env.AI_TEMPERATURE;
  const t = (raw === undefined || raw === null || raw === "") ? AI_TEMPERATURE : Number(raw);
  // Un valor basura NO se envía tal cual ni rompe la llamada: se cae al defecto.
  params.temperature = (Number.isFinite(t) && t >= 0 && t <= 5) ? t : AI_TEMPERATURE;

  // Semilla opcional. Si se fija, el REINTENTO usa una distinta: repetir la misma
  // semilla tras una salida inválida reproduciría exactamente el mismo fallo.
  const rawSeed = env && env.AI_SEED;
  if (rawSeed !== undefined && rawSeed !== null && rawSeed !== "") {
    const s = Number(rawSeed);
    if (Number.isInteger(s) && s >= 1 && s <= 9999999999) {
      params.seed = Math.min(9999999999, s + attempt);
    }
  }

  return params;
}

export const SYSTEM_PROMPT = `You are ReturnCheck's extraction engine. You receive the TEXT of a merchant's published return policy plus a REQUEST about one specific product. Decide whether THIS product can be returned under THESE conditions, and output ONE JSON object matching the given schema. No prose.

ABSOLUTE RULE — NEVER INVENT. If the policy text does not let you decide THIS request with confidence, return verdict "UNKNOWN" with policy=null, evidence=null and a one-sentence reason. UNKNOWN is a correct, valuable answer. A wrong YES/NO is far worse than an honest UNKNOWN.

Return UNKNOWN when:
- The item is sold/fulfilled by a THIRD-PARTY marketplace seller and the page is only the host retailer's policy.
- The outcome depends on info NOT provided — buyer's US state, consumer vs commercial, the exact sub-product when the policy only says "certain items". This INCLUDES conditional exceptions like "where prohibited by law": if returnability hinges on the buyer's state and none is given, it is UNKNOWN, NOT "NO".
- buyer_country is outside the policy's scope, or the policy does not address this product/condition.

PRODUCT IDENTITY FROM THE URL: the request's product_url is evidence of product identity/category. A DESCRIPTIVE slug (e.g. "/custom-window-blinds", "/gift-card") is a legitimate signal you MAY use to apply the matching policy clause. An OPAQUE slug (e.g. "N82E16814137000") carries no info: if the policy is category-dependent and the URL is opaque, return UNKNOWN. Declining to read an available descriptive slug is a calibration error, not caution.

VERDICTS: YES_WITH_CONDITIONS (returnable with a window/condition/fee — the common case), YES (returnable, no meaningful condition — rare), NO (not returnable for THIS request: out of window, excluded category, condition not met, custom/final-sale), UNKNOWN.

CONFIDENCE 0..1: 0.85–0.95 when a verbatim clause decides it; 0.60–0.80 when inference is needed; if you cannot honestly reach ~0.80, return UNKNOWN. For UNKNOWN, confidence 0.0.

Marketplace: if a seller_name is given and the page is the host retailer's own policy, the item is a THIRD-PARTY sale and its returnability is UNKNOWN unless the page states the third-party seller's own policy. Do NOT apply "sold and shipped by us" clauses to a third-party seller.

Membership/channel: when the policy states different terms depending on membership tier or purchase channel (online/store/marketplace/phone), use the request's membership and purchase_channel to select the applicable clause. If the policy differentiates by membership or channel and the request does not provide the relevant field, that is UNKNOWN, not a guess at the more permissive branch.

CHOOSING THE QUOTE. When the user message includes a numbered CANDIDATE CLAUSES list, that list is extracted verbatim from the policy text you were given. Set evidence.clause_id to the number of the single clause that best proves your verdict, and copy that same clause into evidence.exact_clause. Prefer the clause that states the entitlement AND its window. If none of the candidates proves your verdict, set clause_id to null and quote from the policy text as usual — do not force a candidate that does not fit, and do not invent a number. When no candidate list is given, set clause_id to null.

For a determinate verdict fill policy and evidence. evidence.exact_clause MUST be a verbatim quote copied from the policy text (its own language, never paraphrased). Quote the COMPLETE sentence that grants the return and states its window — never a bare fragment like "within 90 calendar days of purchase". If the entitlement and the window live in different sentences, quote the sentence that grants the return. Map item_condition to the enum (opened/used -> UsedCondition when used is accepted; unopened -> NewCondition); never copy the raw request string. In NotPermitted with no refund, refund_type may be null and return_fees null. Include restocking_fee.currency only when type="amount". merchant_return_days: integer or null. window_basis: "purchase_date" only when the quoted clause explicitly counts from purchase/order, "delivery_date" only when it explicitly counts from delivery/receipt, otherwise null. Never guess the basis from which request dates happen to be present. Do not compute deadline_date (the caller does it). exceptions[] are short snake_case tags.`;

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
        window_basis: { type: ["string", "null"], enum: ["purchase_date", "delivery_date", null] },
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
      required: ["return_category", "window_basis", "return_method", "return_fees", "refund_type"],
    },
    evidence: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        source_url: { type: "string" },
        exact_clause: { type: "string" },
        // W05: numero de la candidata elegida (base 1), o null si ninguna sirve.
        // El codigo resuelve el numero contra la lista deterministica, asi que la
        // cita deja de depender de que el modelo la copie bien.
        clause_id: { type: ["integer", "null"] },
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
