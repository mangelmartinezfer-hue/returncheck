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
  // "vary" además de "varies": lo destapó una prueba de W10 al dar por hecho que
  // "Refunds vary by state." ya estaba cubierto. No lo estaba — solo entraba la
  // forma en singular. Un hueco de una letra, invisible hasta que se escribe la
  // prueba con el caso real delante.
  /(where prohibited by law|except where required by law|subject to (state|local) law|var(?:y|ies) by state|as (required|permitted) by (state|applicable) law|where applicable law (requires|permits))/i;

// W10 — POR QUÉ ESTO NO BASTABA. C09 falló 5 de 5 pasadas el 26 ago, siempre con
// YES_WITH_CONDITIONS donde tocaba UNKNOWN. La causa no era el razonamiento: la
// página parte la condición en dos frases,
//
//   "Returns ... are not accepted where prohibited by law."     <- la condición
//   "Where returns are permitted, unopened bottles may be ..."  <- lo que cita
//
// y el modelo citaba la segunda, que por sí sola no contiene ninguna marca de
// jurisdicción. El guard miraba solo la cita, así que nunca se disparaba.
//
// Una frase que empieza por "Where returns are permitted" NO demuestra nada por
// sí misma: su propia condición está sin resolver. Pero tampoco basta con
// prohibir ese giro —"Where permitted, we offer free return shipping" habla de
// portes, no de si se puede devolver— así que se exigen las dos señales: la cita
// está condicionada Y su vecindad contiene la condición legal. Es la vecindad
// (±1 frase, mismo criterio que W04) y no la página entera, para que una cláusula
// de tarjetas regalo en otro párrafo no tumbe un veredicto correcto.
const PERMISSION_HEDGE_RE =
  /\b(?:where|wherever|if|unless|except where|to the extent)\b[^.!?\n]{0,40}\b(?:permitted|allowed|prohibited|permissible)\b/i;

export function clauseIsJurisdictionConditional(clause, policyText) {
  if (!clause) return false;
  if (JURISDICTION_CONDITIONAL_RE.test(clause)) return true;
  if (!policyText || !PERMISSION_HEDGE_RE.test(clause)) return false;
  const ctx = evidenceContext(clause, policyText, 1);
  return !!ctx && JURISDICTION_CONDITIONAL_RE.test(ctx.window);
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

// W12 — LA OTRA MITAD DEL GUARD DE C15.
//
// Medido el 26 ago: C11_software_opened_NO era el UNICO safe_miss del banco, y
// con la firma de W11 se vio de donde venia. Su politica solo produce dos frases:
//
//   [1] "Opened software ... cannot be returned or refunded once the seal is broken..."
//   [2] "Unopened physical software may be returned within 15 days."
//
// El articulo es ABIERTO. El modelo cita la [2], el guard de C15 ve lenguaje de
// "sin abrir" sin exclusion y se abstiene. Correcto por lo que mira, pero
// incompleto: la pagina SI resuelve el caso, y lo resuelve en la frase [1].
// Nos abstenamos con la respuesta escrita dos frases mas arriba.
//
// Asi que antes de abstenernos, buscamos si la politica excluye EXPLICITAMENTE
// la condicion del articulo. Si la hay, el veredicto honesto no es "no lo se":
// es NO, y con su cita.
//
// Convertir un UNKNOWN en un veredicto determinado es lo unico que puede crear un
// error peligroso, asi que el filtro es estrecho a proposito: la MISMA frase debe
// nombrar la condicion del articulo Y negar la devolucion, y ademas tiene que
// pasar el mismo clauseSupportsVerdict que exigimos a cualquier otra cita.
// "Unopened items may be returned" no entra: \bopened\b no casa dentro de
// "Unopened", y aunque casara, no hay negacion.
//
// LIMITE CONOCIDO, escrito aqui para que no se descubra en produccion: esto no
// entiende de CATEGORIAS. Una pagina que diga "opened cosmetics cannot be
// returned" firmaria ese NO tambien para un portatil abierto. Lo que estrecha el
// riesgo no es esta funcion sino donde se la llama: solo se llega aqui cuando la
// cita del propio modelo era de ambito "nuevo/sellado", asi que la pagina ya
// estaba hablando de esa condicion. No es imposible equivocarse, es improbable.
// Si algun dia aparece un falso NO, el arreglo es acotar por categoria, no
// ensanchar este filtro.
const CONDITION_MENTION_RE =
  /\b(?:opened|unsealed|activated|used|worn)\b|\bseal(?:s)? (?:is|are|has been|have been) broken\b|\bbroken seal\b/i;

export function conditionExclusionClause(policyText, itemCondition) {
  if (!policyText) return null;
  if (itemCondition !== "opened" && itemCondition !== "used") return null;
  for (const raw of splitSentences(policyText)) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (s.length < 20) continue;
    if (!CONDITION_MENTION_RE.test(s)) continue;
    if (!NON_RETURN.test(s)) continue;
    return s;
  }
  return null;
}

// W13 — LA IMAGEN EN EL ESPEJO DE C15.
//
// Encontrado en el holdout de 25 (RC25-17, 26 ago), que es justo lo que el banco
// propio no podia ver. Politica de un cepillo electrico:
//
//   "...may be returned within 14 calendar days ... only when the retail seal is unbroken."
//   "Opened hygiene products are not eligible for return."     <- lo que cita
//
// El articulo viene SIN ABRIR. El modelo cita la segunda frase y firma NO. Y el
// guard de siempre la acepta, porque la frase ES una negacion de devolucion de
// verdad: clauseSupportsVerdict(cita, NO) da true. Lo que nadie miraba es que esa
// frase habla de articulos ABIERTOS y este no lo esta. La cita es real, la
// negacion es real, y aun asi no demuestra nada sobre ESTE articulo.
//
// C15 protege el caso contrario —una frase de "sin abrir" usada para un articulo
// abierto—. Este es su espejo, y no estaba cubierto.
//
// La salida es UNKNOWN, no darle la vuelta al veredicto: que la exclusion no
// aplique no prueba que se pueda devolver, solo que esa cita no lo resuelve.
const OPENED_SCOPE_RE =
  /\b(?:opened|used|worn|unsealed|activated)\b|\bseal(?:s)? (?:is|are|has been|have been) broken\b|\bbroken seal\b/i;
const SEALED_SCOPE_RE = /\b(?:unopened|unused|new|sealed|intact|unbroken)\b/i;

export function negativeClauseWrongCondition(clause, itemCondition) {
  if (!clause) return false;
  // Solo para articulos sellados: es la direccion en la que un NO indebido hace dano.
  if (itemCondition !== "unopened" && itemCondition !== "new") return false;
  if (!NON_RETURN.test(clause)) return false;      // tiene que ser una negacion
  if (!OPENED_SCOPE_RE.test(clause)) return false; // acotada a abierto/usado
  // Si la MISMA frase tambien nombra lo sellado ("opened or unopened, ... cannot
  // be returned"), entonces si cubre este articulo y no hay nada que corregir.
  if (SEALED_SCOPE_RE.test(clause)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// W05 — FRASES CANDIDATAS.
//
// El hallazgo del 25 ago (doc 44): con la temperatura ya a 0, las 10 respuestas
// útiles de dos tandas salieron IDÉNTICAS —mismo plazo, misma base, misma fecha,
// misma cláusula—. El motor no duda cuando razona. Toda la varianza es binaria:
// o el modelo da con la frase que hay que citar, o no da y el guard degrada a
// UNKNOWN. No es un modelo aleatorio: es un modelo que a veces no encuentra la
// frase.
//
// Así que dejamos de pedirle que la ESCRIBA y pasamos a que la ELIJA. Extraemos
// por código las frases plausibles de la política, se las damos numeradas, y
// devuelve un número. La cita deja de depender de que copie bien: queda
// garantizada por construcción, no rescatada por un guard a posteriori.
//
// Es la misma jugada que W01, W02, W04 y W07: mover una decisión del modelo al
// código. Aquí la decisión movida es "¿existe esta frase?".
// ---------------------------------------------------------------------------

const RETURN_VOCAB = /\b(?:returns?|returned|returnable|returning|refunds?|refunded|refundable|exchanges?|exchanged|restocking|final sale|store credit|money back)\b/i;
const NON_RETURN = /\b(?:non-?returnable|not returnable|cannot be returned|no returns?|final sale|not eligible for return)\b/i;
const DAYS_IN_SENTENCE = /\b\d{1,3}\s*(?:calendar\s+|business\s+|working\s+)?days?\b/i;

// Extrae las frases de la política que PODRÍAN ser la cita. Determinista: mismo
// texto -> misma lista, siempre. Eso es lo que permite resolver un índice más
// tarde sin arrastrar estado entre funciones.
// max = 12 a proposito, no por casualidad: la lista se ANADE al texto de la
// politica en el mismo mensaje, asi que cada candidata cuesta prompt, latencia y
// dinero. Y para un modelo de 8B, veinte opciones no son mas ayuda que doce: son
// mas sitios donde equivocarse. Si la medicion dice que se queda corta, se sube.
export function candidateClauses(policyText, { max = 12, minLen = 30, maxLen = 400 } = {}) {
  if (!policyText) return [];

  const found = [];
  const seen = new Set();
  const sentences = splitSentences(policyText);

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].replace(/\s+/g, " ").trim();
    // Fuera títulos sueltos ("Returns") y párrafos gigantes que no son una cláusula.
    if (s.length < minLen || s.length > maxLen) continue;
    const hasDays = DAYS_IN_SENTENCE.test(s);
    const hasVocab = RETURN_VOCAB.test(s);
    if (!hasDays && !hasVocab) continue;

    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // La puntuación solo decide QUÉ se recorta cuando sobran candidatas.
    // Una frase con plazo vale más que una que solo menciona devoluciones:
    // es la que los guards necesitan para verificar el veredicto.
    let score = 0;
    if (hasDays && hasVocab) score += 3;
    else if (hasDays) score += 2;
    else score += 1;
    if (NON_RETURN.test(s)) score += 1;   // las exclusiones deciden NOes

    found.push({ i, s, score });
  }

  if (found.length <= max) return found.map((f) => f.s);

  // Nos quedamos con las mejores, pero devolvemos en ORDEN DE LECTURA: una lista
  // desordenada respecto a la página confunde al modelo y a quien depure esto.
  const keep = found.slice().sort((a, b) => b.score - a.score || a.i - b.i).slice(0, max);
  keep.sort((a, b) => a.i - b.i);
  return keep.map((f) => f.s);
}

// Formatea el bloque numerado que se le enseña al modelo. Base 1: un "0" ambiguo
// entre "el primero" y "ninguno" es justo el tipo de detalle que cuesta una tarde.
export function candidateBlock(candidates) {
  if (!candidates || !candidates.length) return "";
  return candidates.map((c, n) => `[${n + 1}] ${c}`).join("\n");
}

// Resuelve qué cita usar. El orden importa y es deliberado:
//   1. Si el modelo eligió una candidata válida -> esa, literal de la página.
//   2. Si no eligió, o eligió un número imposible -> su cita libre de siempre.
// Nunca puede empeorar respecto al comportamiento anterior: en el peor caso
// cae exactamente en él. Un despliegue que solo puede mejorar o empatar.
export function pickClause(evidence, policyText, enabled = true) {
  const free = (evidence && evidence.exact_clause) || null;
  if (!enabled || !evidence) return free;

  const id = evidence.clause_id;
  if (!Number.isInteger(id) || id < 1) return free;

  const candidates = candidateClauses(policyText);
  if (id > candidates.length) return free;   // índice inventado: no lo premiamos
  return candidates[id - 1];
}

// ---------------------------------------------------------------------------
// W08 — ¿Es utilizable el texto humano de la respuesta?
//
// Fallo real visto en produccion el 26 ago: verdict "NO" con
// answer_human "YES_WITH_CONDITIONS". El modelo devolvio el NOMBRE DEL ENUM como
// si fuera prosa, y contradice el veredicto de la misma respuesta.
//
// El respaldo que habia solo sustituia el texto si media menos de 12 caracteres.
// "YES_WITH_CONDITIONS" mide 19: pasaba el filtro y salia a produccion. Un cliente
// que lea answer_human lee lo contrario de lo que dice verdict. Es la misma familia
// que el "si" falso de W07: la respuesta se contradice a si misma, y encima en el
// campo que lee una persona.
//
// Criterio deliberadamente CONSERVADOR: no corregimos la prosa del modelo en
// general, solo la sustituimos cuando es demostrablemente inservible. Dos clases:
//   1. Fuga de enum: el texto ES el nombre de un valor del contrato.
//   2. Polaridad opuesta: empieza afirmando lo contrario del veredicto.
// Fuera de esos dos casos se respeta lo que escribio el modelo, aunque sea flojo.
// ---------------------------------------------------------------------------

const ENUM_LEAK = new Set(["yes", "no", "unknown", "yes with conditions"]);

function opener(text) {
  // La polaridad de una respuesta se declara al principio. Solo miramos la
  // primera palabra, y solo si va seguida de puntuacion o es el texto entero:
  // asi "No restocking fee applies" NO cuenta como negacion, porque ahi "no"
  // es un adjetivo, no la respuesta. Ese matiz es la diferencia entre arreglar
  // el fallo y romper respuestas correctas.
  const m = String(text || "").trim().toLowerCase().match(/^([a-z]+)\s*([.,;:!—-]|$)/);
  return m ? m[1] : null;
}

export function usableAnswerHuman(text, verdict) {
  const t = String(text || "").trim();
  if (t.length < 12) return false;                       // criterio anterior, se conserva

  const flat = t.toLowerCase().replace(/_/g, " ").replace(/[.,;:!?"'—-]/g, "").replace(/\s+/g, " ").trim();
  if (ENUM_LEAK.has(flat)) return false;                 // 1. fuga de enum

  const head = opener(t);                                // 2. polaridad opuesta
  if (!head) return true;
  if (verdict === "NO" && head === "yes") return false;
  if ((verdict === "YES" || verdict === "YES_WITH_CONDITIONS") && head === "no") return false;
  if (verdict !== "UNKNOWN" && head === "unknown") return false;
  if (verdict === "UNKNOWN" && (head === "yes" || head === "no")) return false;

  return true;
}
