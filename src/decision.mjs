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

export function applyDeadline(resp, req, today = todayDate()) {
  if (!resp.policy) return resp;
  const clause = resp.evidence && resp.evidence.exact_clause;
  // Antes de cualquier salida temprana: la categoría es propiedad de la POLÍTICA, no de
  // la petición. Debe corregirse aunque falten las fechas del comprador.
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
  let days = resp.policy.merchant_return_days;
  if (days == null && clause) {
    days = windowDaysFromClause(clause);
    if (days != null) resp.policy.merchant_return_days = days;
  }
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
