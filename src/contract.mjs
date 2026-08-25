// Validación de entrada y verificación de invariantes de salida del contrato v1.0.
// No usamos librerías de JSON-Schema para mantener el Worker ligero; validamos
// a mano exactamente las reglas del contrato.

const ITEM_CONDITIONS = ["unopened", "opened", "used", "defective"];
const REASONS = ["changed_mind", "defective", "wrong_size_or_model", "arrived_late", "other"];
const PURCHASE_CHANNELS = ["online", "store", "phone", "marketplace"];

// Devuelve { ok:true, value } o { ok:false, code, message }.
export function validateRequest(body) {
  if (!body || typeof body !== "object")
    return { ok: false, code: "INVALID_INPUT", message: "Body must be a JSON object." };

  const { product_url, buyer_country, merchant, item_condition, purchase_date, delivery_date, reason, seller_name,
          buyer_state, as_of, page_html, page_text, membership, purchase_channel } = body;

  if (typeof product_url !== "string" || !/^https?:\/\//i.test(product_url))
    return { ok: false, code: "INVALID_INPUT", message: "product_url is required and must be an http(s) URL." };
  try { new URL(product_url); } catch { return { ok: false, code: "INVALID_INPUT", message: "product_url is not a valid URL." }; }

  if (typeof buyer_country !== "string" || !/^[A-Z]{2}$/.test(buyer_country))
    return { ok: false, code: "INVALID_INPUT", message: "buyer_country is required (ISO 3166-1 alpha-2, e.g. 'US')." };

  if (buyer_state !== undefined && (typeof buyer_state !== "string" || !/^[A-Z]{2}$/.test(buyer_state)))
    return { ok: false, code: "INVALID_INPUT", message: "buyer_state must be a 2-letter uppercase subdivision code, e.g. 'CA'." };

  if (item_condition !== undefined && !ITEM_CONDITIONS.includes(item_condition))
    return { ok: false, code: "INVALID_INPUT", message: "item_condition must be one of " + ITEM_CONDITIONS.join(", ") };

  if (reason !== undefined && !REASONS.includes(reason))
    return { ok: false, code: "INVALID_INPUT", message: "reason must be one of " + REASONS.join(", ") };

  if (purchase_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(purchase_date))
    return { ok: false, code: "INVALID_INPUT", message: "purchase_date must be YYYY-MM-DD." };

  if (delivery_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(delivery_date))
    return { ok: false, code: "INVALID_INPUT", message: "delivery_date must be YYYY-MM-DD." };

  if (as_of !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(as_of))
    return { ok: false, code: "INVALID_INPUT", message: "as_of must be YYYY-MM-DD." };

  if (merchant !== undefined && typeof merchant !== "string")
    return { ok: false, code: "INVALID_INPUT", message: "merchant must be a string." };

  if (seller_name !== undefined && typeof seller_name !== "string")
    return { ok: false, code: "INVALID_INPUT", message: "seller_name must be a string." };

  // ADITIVO v1.1 (W03): señales de membresía/canal, para políticas que dan plazos
  // distintos según el nivel de socio o dónde se compró. String libre para membership
  // (cada comercio nombra sus niveles distinto: Plus, Prime, Elite...); enum cerrado
  // para purchase_channel porque el motor sí necesita distinguir estos valores concretos.
  if (membership !== undefined && typeof membership !== "string")
    return { ok: false, code: "INVALID_INPUT", message: "membership must be a string." };

  if (purchase_channel !== undefined && !PURCHASE_CHANNELS.includes(purchase_channel))
    return { ok: false, code: "INVALID_INPUT", message: "purchase_channel must be one of " + PURCHASE_CHANNELS.join(", ") };

  // ADITIVO v1.0 (no rompe): el agente comprador puede pasarnos el contenido de la
  // página que YA tiene delante (su navegador sí renderiza JS y no está bloqueado).
  // Si viene, el motor VERIFICA sobre ese contenido en vez de leer la web.
  const MAX_PAGE = 4_000_000; // 4M caracteres (el motor recorta a MAX_HTML_BYTES)
  if (page_html !== undefined && (typeof page_html !== "string" || page_html.length > MAX_PAGE))
    return { ok: false, code: "INVALID_INPUT", message: "page_html must be a string under 4,000,000 chars." };
  if (page_text !== undefined && (typeof page_text !== "string" || page_text.length > MAX_PAGE))
    return { ok: false, code: "INVALID_INPUT", message: "page_text must be a string under 4,000,000 chars." };

  return { ok: true, value: { product_url, buyer_country, merchant, item_condition, purchase_date, delivery_date, reason, seller_name, buyer_state, as_of, page_html, page_text, membership, purchase_channel } };
}

// Invariantes del contrato (sección 7). Defensa antes de responder: si el motor
// produce algo que los viola, es un fallo interno, no una respuesta que enviar.
export function checkInvariants(r) {
  const problems = [];
  if (r.schema_version !== "1.0") problems.push("schema_version must be '1.0'");

  const determinate = ["YES", "YES_WITH_CONDITIONS", "NO"].includes(r.verdict);
  if (r.verdict === "UNKNOWN") {
    if (r.policy !== null) problems.push("UNKNOWN must have policy=null");        // inv.1
    if (r.evidence !== null) problems.push("UNKNOWN must have evidence=null");    // inv.1
    if (!r.reason) problems.push("UNKNOWN must include reason");                  // inv.1
    if (r.returnable !== null) problems.push("UNKNOWN must have returnable=null");// inv.3
  } else if (determinate) {
    if (!r.policy) problems.push("determinate verdict must have policy");         // inv.2
    if (!r.evidence) problems.push("determinate verdict must have evidence");     // inv.2
    if (r.evidence) {
      for (const f of ["source_url", "exact_clause", "verified_on", "policy_version"])
        if (!r.evidence[f]) problems.push("evidence missing " + f);              // inv.2
    }
    const want = r.verdict === "NO" ? false : true;
    if (r.returnable !== want) problems.push("returnable must match verdict");    // inv.3
  } else {
    problems.push("verdict must be YES / YES_WITH_CONDITIONS / NO / UNKNOWN");
  }
  return { ok: problems.length === 0, problems };
}

