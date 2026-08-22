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

// ¿La cita aparece LITERALMENTE en el texto capturado? (normaliza espacios y comillas)
export function clauseInText(clause, text) {
  if (!clause || !text) return false;
  const norm = (s) => s.toLowerCase().replace(/["“”'’]/g, "").replace(/\s+/g, " ").trim();
  const c = norm(clause);
  if (c.length < 12) return false; // demasiado corta para verificar
  return norm(text).includes(c);
}
