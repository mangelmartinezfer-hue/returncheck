// Lógica de decisión pura (sin dependencias de Cloudflare) -> testeable en Node.
import { todayDate, addDays } from "./util.mjs";

const PURCHASE_BASIS_RE = /(?:\b(?:of|from|after|following|or)\s+(?:the\s+)?(?:date\s+of\s+)?(?:purchase|order)\b|\b(?:purchase|order)\s+date\b|\bdate\s+of\s+(?:purchase|order)\b)/i;
const DELIVERY_BASIS_RE = /(?:\b(?:of|from|after|following|or|upon)\s+(?:the\s+)?(?:date\s+of\s+)?(?:delivery|receipt|receiving)\b|\b(?:delivery|receipt)\s+date\b|\bdate\s+(?:the\s+customer\s+|you\s+)?receiv(?:e|es|ed)\b|\b(?:after|from)\s+(?:the\s+customer\s+|you\s+)receiv(?:e|es|ed)\b|\bdeliver(?:y|ed)\s+to\s+(?:the\s+customer|you)\b)/i;
const CALENDAR_DAYS_RE = /\bwithin\s+(\d{1,3})\s+(?:calendar\s+)?days?\b/i;

export function windowBasisFromClause(clause) {
  if (!clause) return null;
  const purchase = PURCHASE_BASIS_RE.test(clause);
  const delivery = DELIVERY_BASIS_RE.test(clause);
  if (purchase === delivery) return null; // ninguna señal o cláusula ambigua
  return purchase ? "purchase_date" : "delivery_date";
}

export function windowDaysFromClause(clause) {
  if (!clause) return null;
  const match = String(clause).match(CALENDAR_DAYS_RE);
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isInteger(days) && days >= 0 ? days : null;
}

// Recomputa deadline_date y convierte a NO si la ventana finita ya venció.
// La base debe estar explícita en la cita verificada o, para objetos internos sin
// evidencia, declarada en policy.window_basis. Nunca se elige delivery_date solo
// porque esté disponible: ese era el fallo que desplazaba RC25-05 cinco días.
// W07 — La FINITUD de la ventana la manda el número de días, no la etiqueta del modelo.
//
// Por qué existe esto: la comprobación de vencimiento de más abajo solo dispara cuando
// return_category === "FiniteReturnWindow". Si el modelo etiqueta mal una ventana finita
// como "UnlimitedWindow" (visto en producción con plazos de 90 y 7 días), una ventana
// YA CADUCADA no se convierte en NO y respondemos "sí, devolvible" a un comprador fuera
// de plazo. No es un campo feo: es un SÍ falso, la peor clase de error de este producto.
//
// Demostrado: misma política de 90 días, compra 2026-04-01, hoy 2026-08-25 ->
//   FiniteReturnWindow -> NO (correcto)   ·   UnlimitedWindow -> YES_WITH_CONDITIONS (falso)
//
// Regla determinista: si conocemos un plazo — declarado por el modelo o extraído de la
// cita verificada — la ventana es finita. No se toca cuando el veredicto ya es NO.
function reconcileFiniteCategory(resp, clause) {
  if (!resp.policy || resp.verdict === "NO") return;
  const days = resp.policy.merchant_return_days != null
    ? resp.policy.merchant_return_days
    : windowDaysFromClause(clause);
  if (days != null) resp.policy.return_category = "FiniteReturnWindow";
}

// W18 — EL PLAZO TAMBIÉN ES PROPIEDAD DE LA POLÍTICA, NO DEL COMPRADOR.
//
// El fallo, visto en el segundo ensayo de avisos contra producción: el número de
// días solo se rellenaba DESPUÉS de dos salidas tempranas que dependen de las
// fechas del COMPRADOR (la base de cómputo y su fecha de compra o entrega). Sin
// esas fechas, `merchant_return_days` se quedaba en null aunque la cita verificada
// dijera "within 60 days" con todas las letras. El corpus guardaba ese null, y el
// aviso de cambio no podía decir "pasó de 60 a 30 días" porque no tenía los dos
// números que comparar.
//
// En W17 saqué la CATEGORÍA de ese camino y dejé dentro los DÍAS. Mismo fallo,
// misma función, arreglado a medias. La regla que lo cierra: lo que describe la
// POLÍTICA se fija siempre; lo que describe al COMPRADOR (deadline_date, y el
// vencimiento) solo cuando hay fechas suyas.
export function applyDeadline(resp, req, today = todayDate()) {
  if (!resp.policy) return resp;
  const clause = resp.evidence && resp.evidence.exact_clause;
  // Antes de cualquier salida temprana: el plazo y la categoría son propiedades de
  // la POLÍTICA. Deben quedar fijados aunque falten las fechas del comprador.
  if (resp.policy.merchant_return_days == null) {
    const desdeCita = windowDaysFromClause(clause);
    if (desdeCita != null) resp.policy.merchant_return_days = desdeCita;
  }
  reconcileFiniteCategory(resp, clause);
  const inferredBasis = windowBasisFromClause(clause);
  const declaredBasis = ["purchase_date", "delivery_date"].includes(resp.policy.window_basis)
    ? resp.policy.window_basis : null;
  // Si hay evidencia, la cita manda y evita aceptar una base inventada por el modelo.
  const basis = clause ? inferredBasis : declaredBasis;
  resp.policy.window_basis = basis;
  resp.policy.deadline_date = null;
  if (!basis) return resp;
  const start = req[basis];
  if (!start) return resp;
  // Ya está fijado arriba: aquí solo se lee.
  const days = resp.policy.merchant_return_days;
  if (days == null) return resp;
  const deadline = addDays(start, days);
  resp.policy.deadline_date = deadline;
  if (resp.policy.return_category === "FiniteReturnWindow" && deadline < today && resp.verdict !== "NO") {
    resp.verdict = "NO";
    resp.returnable = false;
    resp.reason = `Return window elapsed: deadline was ${deadline}.`;
  }
  return resp;
}

// ---------------------------------------------------------------------------
// W21 — QUÉ DATO FALTA. (Decisión de Miguel, 27 ago 2026.)
//
// El planteamiento que traíamos era falso: «nunca equivocarse» contra «resolver
// más», como si fuera un dial con dos extremos y hubiera que elegir cuánto
// riesgo comprar. No lo es, y esto es lo que lo cambia: nuestros UNKNOWN no
// salen de que el modelo dude. Salen de GUARDIANES DETERMINISTAS que disparan
// por una causa concreta que conocemos con nombre y apellidos desde W11.
//
// Si sabemos exactamente por qué no pudimos responder, podemos decir qué haría
// falta para poder. Y entonces resolver más no exige aflojar la seguridad ni un
// punto: exige PEDIR EL DATO QUE FALTA.
//
// Lo que cambia para el cliente: 434 de 1.148 consultas acaban hoy en UNKNOWN
// —gratis para él, trabajo hecho para nosotros— y el agente que lo recibe se
// queda en un callejón sin salida. Con esto vuelve a preguntar con el campo que
// le decimos y obtiene respuesta. Un callejón se convierte en una segunda
// consulta útil, y de paso cobrable.
//
// NO es una sugerencia del modelo: es una tabla determinista guardián -> campo.
// Si algún día un guardián nuevo no tiene campo que lo desbloquee, no inventa
// ninguno; devuelve lista vacía, que es la respuesta honesta.
// ---------------------------------------------------------------------------

const PISTAS = {
  buyer_state:
    "The cited clause depends on state law. Send buyer_state (2-letter code) to resolve it.",
  seller_policy_text:
    "This item is sold by a third-party seller. Send that seller's own return policy as page_text to get a verdict.",
  purchase_date:
    "The policy counts its window from the purchase date. Send purchase_date (YYYY-MM-DD) to get a deadline.",
  delivery_date:
    "The policy counts its window from the delivery date. Send delivery_date (YYYY-MM-DD) to get a deadline.",
};

export function missingInputFor(resp, req = {}) {
  const falta = [];
  const guard = (resp && resp.meta && resp.meta.guard && resp.meta.guard.name) || null;

  // Guardianes que un dato del agente SÍ desbloquea.
  if (guard === "jurisdiction_conditional" && !req.buyer_state) falta.push("buyer_state");
  if (guard === "third_party_seller") falta.push("seller_policy_text");

  // Y el caso que no es un UNKNOWN pero deja la respuesta a medias: sabemos desde
  // qué fecha cuenta la ventana, pero no tenemos esa fecha, así que no podemos
  // decir hasta cuándo. Para un agente de compras eso es media respuesta.
  const base = resp && resp.policy && resp.policy.window_basis;
  if (base && (base === "purchase_date" || base === "delivery_date") && !req[base]) falta.push(base);

  return falta;
}

export function missingInputHint(campos) {
  if (!campos || !campos.length) return null;
  return campos.map((c) => PISTAS[c]).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// W23 — YES SIGNIFICA «YA CUMPLE», NO «LA POLÍTICA TIENE LETRA PEQUEÑA».
// (Decisión de Miguel, 27 ago 2026.)
//
// EL PROBLEMA MEDIDO: en 250 evaluaciones el motor no ha emitido ni un `YES`
// pelado. Un campo que siempre vale lo mismo no es un campo. Y el holdout —que
// escribió el equipo de ChatGPT, no nosotros— espera `YES` en 4 de 25 casos, así
// que esos 4 estaban perdidos de antemano: 68% estricto contra un criterio del
// 80%.
//
// LA DEFINICIÓN QUE ADOPTAMOS:
//   YES  = la cláusula permite la devolución, la ventana está abierta, y toda
//          condición que la cláusula nombra está cubierta por lo que nos han
//          dicho.
//   YWC  = queda al menos una condición que NO podemos dar por cumplida.
//
// LAS TRES FAMILIAS DE CONDICIÓN, y la distinción es el corazón de esto:
//
//  1. ESTADO FÍSICO (sin usar, sin llevar, etiquetas puestas, sello intacto,
//     accesorios, embalaje original). Si el artículo viene declarado `unopened`
//     o `new`, se dan por CUMPLIDAS — un artículo sin abrir tiene por fuerza sus
//     etiquetas y sus accesorios dentro. Pero no en silencio: van a
//     `assumed_satisfied` para que el YES enseñe sobre qué se apoya. Nunca
//     inventar, siempre enseñar la base.
//
//  2. RESULTADO (vale de tienda en vez de reembolso, solo cambio, solo
//     reposición, comisión de reposición). NUNCA se dan por cumplidas. No
//     dependen del comprador: dependen del comercio, y cambian lo que recibe.
//     Aquí es donde YWC sigue significando algo.
//
//  3. ELEGIBILIDAD QUE NO PODEMOS COMPROBAR (final sale, «algunas categorías
//     varían», liquidación). Tampoco. No sabemos si este artículo cae dentro.
//
// Y funciona en los dos sentidos: si el modelo dice YES pero la política impone
// una condición de RESULTADO, se BAJA a YWC. Eso es seguridad nueva, no solo
// cobertura.
// ---------------------------------------------------------------------------

const ESTADO_FISICO = [
  [/\bunused\b/i, "item is unused"],
  [/\bunworn\b/i, "item is unworn"],
  [/\bunopened\b|\bnot been opened\b/i, "item is unopened"],
  [/\boriginal packaging\b/i, "item is in its original packaging"],
  [/\b(?:original )?tags?\b[^.!?\n]{0,30}\battached\b|\bwith tags\b/i, "original tags are still attached"],
  [/\bseal(?:s)?\b[^.!?\n]{0,20}\bintact\b/i, "the seal is intact"],
  [/\b(?:all )?original accessories\b/i, "all original accessories are included"],
  [/\bnew condition\b/i, "item is in new condition"],
];

// Condiciones sobre lo que el comprador RECIBE. Nunca se dan por cumplidas.
const CONDICION_RESULTADO =
  /\bstore credit\b|\bmerchandise credit\b|\bexchange only\b|\breplacement only\b|\brestocking fee\b|\bcash refunds?\s+(?:are|is)\s+not\b|\bno cash refunds?\b/i;

// PROCEDIMIENTO que el comprador tiene que cumplir y que no podemos comprobar.
// Encontrado por una prueba que ya existía: «Unopened bottles may be returned
// within 30 days WITH RECEIPT». El artículo viene sin abrir, sí — pero que tenga
// el recibo no lo entraña estar sin abrir, y sin recibo no hay devolución. Sin
// esta familia habríamos dado un YES sobre algo que no sabemos.
const PROCEDIMIENTO_OPACO =
  /\bwith (?:the |your )?(?:original )?receipt\b|\bproof of purchase\b|\breturn (?:authorization|merchandise authorization)\b|\bRMA\b|\bmust (?:first )?contact\b|\bcontact us (?:first|before)\b|\bpacking slip\b/i;

// Elegibilidad que no podemos comprobar para ESTE artículo.
const ELEGIBILIDAD_OPACA =
  /\bfinal sale\b|\bclearance\b|\bsome categories\b|\bcertain (?:categories|items)\b|\bmay have different\b|\bas noted on the product page\b|\bvary by (?:category|product|item)\b/i;

const CONDICIONES_CUBIERTAS = new Set(["unopened", "new"]);

/**
 * Decide entre YES y YES_WITH_CONDITIONS para un veredicto ya positivo.
 * Pura y determinista: no la decide el modelo.
 *
 * Devuelve { verdict, assumed_satisfied, pending } sin tocar `resp`.
 */
export function classifyPositive(resp, req = {}) {
  const v = resp && resp.verdict;
  if (v !== "YES" && v !== "YES_WITH_CONDITIONS") return null;

  const clause = (resp.evidence && resp.evidence.exact_clause) || "";
  const contexto = clause + " " + ((resp.policy && resp.policy.raw_context) || "");

  // 2 y 3: lo que nunca se da por cumplido. Manda sobre todo lo demás, y BAJA un
  // YES del modelo si hace falta.
  if (CONDICION_RESULTADO.test(contexto))
    return { verdict: "YES_WITH_CONDITIONS", assumed_satisfied: [], pending: "outcome_condition" };
  if (ELEGIBILIDAD_OPACA.test(contexto))
    return { verdict: "YES_WITH_CONDITIONS", assumed_satisfied: [], pending: "eligibility_unverifiable" };
  if (PROCEDIMIENTO_OPACO.test(contexto))
    return { verdict: "YES_WITH_CONDITIONS", assumed_satisfied: [], pending: "procedure_unverifiable" };

  // 1: estado físico.
  const nombradas = ESTADO_FISICO.filter(([re]) => re.test(clause)).map(([, texto]) => texto);
  if (!nombradas.length)
    return { verdict: "YES", assumed_satisfied: [], pending: null };

  if (CONDICIONES_CUBIERTAS.has(req.item_condition))
    return { verdict: "YES", assumed_satisfied: nombradas, pending: null };

  // Artículo abierto o usado con condiciones de estado: no se da por cumplido nada.
  return { verdict: "YES_WITH_CONDITIONS", assumed_satisfied: [], pending: "item_condition" };
}
