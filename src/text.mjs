// Utilidades de texto PURAS (sin dependencias de Cloudflare) -> testeables en Node.
import { normalizeUrl } from "./util.mjs";

export const MAX_POLICY_CHARS = 9000;

// Clave de caché: incluye país, comerciante y vendedor para no mezclar contextos.
export function cacheKey(req) {
  return [
    normalizeUrl(req.product_url),
    (req.buyer_country || "").toUpperCase(),
    req.merchant || "",
    req.seller_name || "",
    req.item_condition || "",
    req.reason || "",
  ].join("|");
}

// Convierte HTML crudo en texto legible (rápido, sin navegador).
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// Palabras que señalan la sección de política de devolución (EN + ES).
const POLICY_KW = /\b(return|returns|refund|refunds|exchange|exchanges|restocking|final sale|money[- ]back|devoluc|reembolso|cambio|garant[íi]a|pol[íi]tica)\b/gi;

// Cuenta cuántas palabras clave de política hay (fuerza del texto como política).
export function policyKeywordHits(text) {
  if (!text) return 0;
  const m = text.match(POLICY_KW);
  return m ? m.length : 0;
}

// A partir del HTML, saca enlaces (mismo dominio) que apunten a la página de
// devoluciones/política, ordenados por probabilidad. Para leer la política cuando
// la página de producto no la trae.
export function policyLinkCandidates(html, baseUrl) {
  if (!html) return [];
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const rx = /return|refund|devoluc|reembols|policy|policies/i;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ");
    if (!rx.test(href) && !rx.test(text)) continue;
    let abs;
    try { abs = new URL(href, base).href.split("#")[0]; } catch { continue; }
    try { if (new URL(abs).host !== base.host) continue; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  const score = (u) => {
    const s = u.toLowerCase();
    if (s.includes("refund-policy") || s.includes("return-policy") || s.includes("return_policy") || s.includes("returns-policy")) return 4;
    if (/\/returns?(\b|\/|$)/.test(s) || s.includes("/pages/returns") || s.includes("help/returns")) return 3;
    if (s.includes("refund") || s.includes("return") || s.includes("devoluc")) return 2;
    return 1;
  };
  out.sort((a, b) => score(b) - score(a));
  return out.slice(0, 4);
}

// Rutas comunes de página de política a probar si no hay enlaces claros.
export function guessedPolicyUrls(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return []; }
  return [
    origin + "/policies/refund-policy",   // Shopify estándar
    origin + "/pages/returns",
    origin + "/returns",
    origin + "/return-policy",
    origin + "/pages/return-policy",
  ];
}

// Enfoca el texto en la sección de política: si es largo, coge la ventana con más
// densidad de palabras clave (arregla el corte que dejaba fuera la cláusula).
export function focusPolicyText(text) {
  if (!text) return "";
  if (text.length <= MAX_POLICY_CHARS) return text;
  const hits = [];
  let m;
  POLICY_KW.lastIndex = 0;
  while ((m = POLICY_KW.exec(text)) !== null) hits.push(m.index);
  if (hits.length === 0) return text.slice(0, MAX_POLICY_CHARS);
  let best = hits[0], bestCount = 0, j = 0;
  for (let i = 0; i < hits.length; i++) {
    while (j < hits.length && hits[j] < hits[i] + MAX_POLICY_CHARS) j++;
    const count = j - i;
    if (count > bestCount) { bestCount = count; best = hits[i]; }
  }
  const start = Math.max(0, best - 400);
  return text.slice(start, start + MAX_POLICY_CHARS);
}

// ¿La cita está anclada LITERALMENTE en la página? Ideal: la frase entera aparece.
// Si el modelo la parafrasea en los bordes, aceptamos si al menos un TRAMO seguido
// de `minRun` caracteres es literal en la página (sigue probando cita real, sin inventar).
export function clauseInText(clause, text, minRun = 40) {
  if (!clause || !text) return false;
  const norm = (s) => s.toLowerCase().replace(/["“”'’]/g, "").replace(/\s+/g, " ").trim();
  const c = norm(clause);
  const t = norm(text);
  if (c.length < 12) return false;          // demasiado corta para verificar
  if (t.includes(c)) return true;            // caso ideal: frase entera literal
  if (c.length <= minRun) return false;      // corta y no está entera -> no vale
  for (let i = 0; i + minRun <= c.length; i += 10) {
    if (t.includes(c.slice(i, i + minRun))) return true; // hay una tirada literal larga
  }
  return false;
}

// ¿La cita SOSTIENE de verdad el veredicto? (no basta con que exista en la página)
// Arregla el fallo de citar frases de ENVÍOS ("Free shipping...") o afirmar días
// que la cita no respalda. Reglas:
//  - La cita debe hablar de DEVOLUCIONES (no solo de envíos).
//  - Si hay días, el número debe aparecer en la cita.
//  - Si el veredicto es NO / NotPermitted, la cita debe contener una frase negativa.
export function clauseSupportsVerdict(clause, { verdict, days, category } = {}) {
  if (!clause) return false;
  const c = clause.toLowerCase();
  const neg = /(final sale|sales? (are )?final|all sales final|non-?returnable|not returnable|cannot be returned|can'?t be returned|no returns?|not eligible|no refund|ineligible|venta final|no se admite|no reembolsable|no se puede devolver)/.test(c);
  // La decisión la manda el VEREDICTO, no la categoría (que el modelo rellena mal a veces).
  // Para un veredicto NO, basta (y hace falta) una frase negativa clara.
  if (verdict === "NO") return neg;
  // SEGURIDAD: un veredicto POSITIVO nunca puede apoyarse en una cláusula NEGATIVA
  // ("cannot be returned", "final sale"). Cierra el hueco que dejaba pasar un YES
  // citando "Final sale items cannot be returned".
  if (neg) return false;
  // Para un veredicto positivo, la cita debe hablar de DEVOLUCIONES (no de envíos)...
  const mentionsReturns =
    /\b(return|returns|returned|returnable|refund|refunds|refunded|exchange|exchanges|exchanged|replace|replacement|replaced|store credit|store-credit)\b/.test(c) ||
    /devoluc|reembols|cambio|garant/.test(c);
  if (!mentionsReturns) return false; // p.ej. "Free ground shipping..." -> no vale
  // ...y si hay un nº de días, ese número debe aparecer en la cita.
  if (days != null && !new RegExp("\\b" + days + "\\b").test(c)) return false;
  return true;
}


// SEGURIDAD C09 (determinista): la cita condiciona el resultado a la ley del
// estado/jurisdiccion del comprador. Si la request no trae ese dato, no podemos
// afirmar nada -> el llamador debe forzar UNKNOWN aunque el modelo diga otra cosa.
const JURISDICTION_CONDITIONAL_RE =
  /(where prohibited by law|except where required by law|subject to (state|local) law|varies by state|as (required|permitted) by (state|applicable) law|where applicable law (requires|permits))/i;

export function clauseIsJurisdictionConditional(clause) {
  if (!clause) return false;
  return JURISDICTION_CONDITIONAL_RE.test(clause);
}

// SEGURIDAD C15 (determinista): para un item abierto/usado, un veredicto positivo
// no puede apoyarse SOLO en lenguaje de "nuevo/sellado" -- la cita debe excluir
// explicitamente esa condicion, o no demuestra lo que el modelo afirma.
const CONDITION_EXCLUSION_RE =
  /(\bopened\b[\s\S]{0,40}\b(not|cannot|can'?t|no longer|ineligible)\b|\bonce opened\b|\bseal(ed)? (must|is) (be intact|unbroken)\b|\bbroken seal\b|\bunsealed\b[\s\S]{0,20}\b(not eligible|excluded|final sale)\b)/i;
const SEALED_NEW_LANGUAGE_RE = /\b(new|sealed|unopened)\b/i;

export function clausePositiveButUnverifiedForOpenedItem(clause, itemCondition) {
  if (!clause) return false;
  const isOpenedOrUsed = itemCondition === "opened" || itemCondition === "used";
  if (!isOpenedOrUsed) return false;
  const hasExclusion = CONDITION_EXCLUSION_RE.test(clause);
  const hasSealedLanguage = SEALED_NEW_LANGUAGE_RE.test(clause);
  return hasSealedLanguage && !hasExclusion;
}
