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

// Normalización compartida (misma que clauseInText): minúsculas, sin comillas
// tipográficas, espacios colapsados. Trabajar siempre en este espacio evita
// desalineaciones de offsets entre la cita del modelo y el texto de la página.
function normText(s) {
  return (s || "").toLowerCase().replace(/["“”'’]/g, "").replace(/\s+/g, " ").trim();
}

// Parte un texto en frases (aproximación suficiente para prosa de políticas).
export function splitSentences(text) {
  if (!text) return [];
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// W04 — Localiza en el TEXTO REAL de la página la frase que contiene la cita del
// modelo, y una ventana de ±`neighbors` frases alrededor.
//
// Por qué existe: el modelo suele citar bien pero RECORTADO. En producción vimos
// dos fallos reales de esta clase (docs 33/36):
//   · RC25-12: citó "within 90 calendar days of purchase" — el trozo del plazo,
//     sin el "ClubMarket Plus members may return..." que lo precede.
//   · RC25-21: citó la frase del método de devolución; el "7 calendar days" estaba
//     en la frase anterior.
// En ambos la prueba SÍ estaba publicada en la página; simplemente no cabía en el
// recorte. Ampliar la verificación al texto real que rodea la cita no inventa nada:
// sigue siendo texto del comercio, y `clauseInText` ya ha probado que la cita existe.
//
// Devuelve { sentence, window } en texto normalizado, o null si no se localiza.
export function evidenceContext(clause, policyText, neighbors = 1) {
  const c = normText(clause);
  if (c.length < 12 || !policyText) return null;
  const sentences = splitSentences(normText(policyText));
  if (!sentences.length) return null;

  // 1) Caso ideal: alguna frase contiene la cita entera.
  let idx = sentences.findIndex((s) => s.includes(c));

  // 2) Si el modelo parafraseó los bordes, anclamos por tramo literal largo
  //    (mismo criterio que clauseInText, para no ser más laxos que él).
  if (idx < 0) {
    const RUN = 40;
    outer:
    for (let i = 0; i < sentences.length; i++) {
      for (let j = 0; j + RUN <= c.length; j += 10) {
        if (sentences[i].includes(c.slice(j, j + RUN))) { idx = i; break outer; }
      }
    }
  }
  if (idx < 0) return null;

  const from = Math.max(0, idx - neighbors);
  const to = Math.min(sentences.length - 1, idx + neighbors);
  return { sentence: sentences[idx], window: sentences.slice(from, to + 1).join(" ") };
}

const NEGATIVE_RE = /(final sale|sales? (are )?final|all sales final|non-?returnable|not returnable|cannot be returned|can'?t be returned|no returns?|not eligible|no refund|ineligible|venta final|no se admite|no reembolsable|no se puede devolver)/;
const RETURNS_RE = /\b(return|returns|returned|returnable|refund|refunds|refunded|exchange|exchanges|exchanged|replace|replacement|replaced|store credit|store-credit)\b/;
const RETURNS_ES_RE = /devoluc|reembols|cambio|garant/;

// ¿La cita SOSTIENE de verdad el veredicto? (no basta con que exista en la página)
// Arregla el fallo de citar frases de ENVÍOS ("Free shipping...") o afirmar días
// que la cita no respalda. Reglas:
//  - La FRASE de la que sale la cita debe hablar de DEVOLUCIONES (no solo de envíos).
//  - Si hay días, el número debe aparecer en esa frase o en una contigua.
//  - Si el veredicto es NO / NotPermitted, la CITA debe contener una frase negativa.
//
// `policyText` es opcional. Sin él, el comportamiento es exactamente el anterior
// (se juzga la cita a secas), así que ningún llamador antiguo cambia de conducta.
export function clauseSupportsVerdict(clause, { verdict, days, category, policyText } = {}) {
  if (!clause) return false;
  const c = normText(clause);

  // La decisión la manda el VEREDICTO, no la categoría (que el modelo rellena mal a veces).
  // Para un veredicto NO, basta (y hace falta) una frase negativa clara EN LA CITA.
  // Deliberadamente NO se amplía aquí: ampliar podría dejar que una frase negativa
  // vecina sostenga un "no devolvible" que la cita real no afirma.
  if (verdict === "NO") return NEGATIVE_RE.test(c);

  // W04: para veredictos positivos juzgamos sobre la frase real de la página.
  const ctx = evidenceContext(clause, policyText);
  const sentence = ctx ? ctx.sentence : c;   // frase que contiene la cita
  const window = ctx ? ctx.window : c;       // esa frase ± 1 contigua

  // SEGURIDAD: un veredicto POSITIVO nunca puede apoyarse en una cláusula NEGATIVA
  // ("cannot be returned", "final sale"). Cierra el hueco que dejaba pasar un YES
  // citando "Final sale items cannot be returned".
  // Se evalúa sobre la FRASE, no sobre el recorte: si el modelo cita un fragmento
  // inocuo de una frase negativa, el fragmento no debe blanquearla.
  if (NEGATIVE_RE.test(sentence)) return false;

  // La frase debe hablar de DEVOLUCIONES (no de envíos). Este es el guard
  // anti-Allbirds/Olipop y se mantiene ceñido a la frase citada: NO se amplía a
  // las vecinas, porque entonces citar "Free ground shipping..." junto a una frase
  // de devoluciones volvería a colar.
  if (!RETURNS_RE.test(sentence) && !RETURNS_ES_RE.test(sentence)) return false;

  // El nº de días sí puede estar en una frase contigua: las políticas reales
  // separan a menudo el plazo ("...within 7 calendar days of purchase.") de sus
  // condiciones ("They must be returned in person...").
  if (days != null && !new RegExp("\\b" + days + "\\b").test(window)) return false;
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

// SEGURIDAD W01 (determinista): algunas plataformas publican una política del
// marketplace, pero dejan la devolución real en manos de cada vendedor. La
// política del host no demuestra entonces que el producto sea devolvible.
//
// Buscamos lenguaje de vendedor/marketplace y, cerca de él, una señal explícita
// de que la política pertenece al vendedor o es decidida por él. Exigir ambas
// señales evita falsos positivos como "third-party logistics provider" o
// "marketplace sellers follow our standard return policy".
const SELLER_SCOPE_RE = /\b(?:third[- ]?party sellers?|3rd[- ]?party sellers?|marketplace sellers?|marketplace partners?|marketplace vendors?|individual sellers?|external sellers?|sold by[^.!?\n]{0,80}sellers?|sellers?'?s?)\b/gi;
const SELLER_POLICY_DEFERRAL_RE = /(?:\b(?:each|individual|the)?\s*seller'?s?\s+(?:own|individual|separate|specific)\s+polic(?:y|ies)\b|\b(?:each|individual|the)?\s*seller'?s?\s+(?:own|individual|separate|specific)?\s*(?:return|refund)s?\s+polic(?:y|ies)\b|\b(?:their|its)\s+(?:own|individual|separate|specific)\s+(?:return|refund)s?\s+polic(?:y|ies)\b|\b(?:seller|vendor|partner)s?\b[^.!?\n]{0,90}\b(?:sets?|provides?|determines?|manages?|governs?|handles?|maintains?|has|have)\b[^.!?\n]{0,70}\b(?:own|separate|individual|specific)?\s*(?:return|refund)s?\s+polic(?:y|ies)\b|\b(?:return|refund)s?\s+polic(?:y|ies)\b[^.!?\n]{0,90}\b(?:var(?:y|ies)|differ|set|provided|determined|managed|governed|handled)\b[^.!?\n]{0,70}\b(?:seller|vendor|partner)s?\b|\b(?:subject to|governed by|determined by|set by|handled by|refer to|check|contact)\b[^.!?\n]{0,100}\b(?:seller|vendor|partner)'?s?\b[^.!?\n]{0,80}\b(?:return|refund)?\s*polic(?:y|ies)\b)/i;

export function policyDefersToSeller(policyText) {
  if (!policyText) return false;
  const text = String(policyText).replace(/\s+/g, " ");
  SELLER_SCOPE_RE.lastIndex = 0;
  for (const match of text.matchAll(SELLER_SCOPE_RE)) {
    const start = Math.max(0, match.index - 180);
    const end = Math.min(text.length, match.index + match[0].length + 220);
    if (SELLER_POLICY_DEFERRAL_RE.test(text.slice(start, end))) return true;
  }
  return false;
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
