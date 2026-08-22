// Lógica de decisión pura (sin dependencias de Cloudflare) -> testeable en Node.
import { todayDate, addDays } from "./util.mjs";

// Recomputa deadline_date y convierte a NO si la ventana finita ya venció.
// La mayoría de políticas cuentan desde la RECEPCIÓN: si hay delivery_date la usamos;
// si no, caemos a purchase_date. No inventa fechas: solo si hay días y una fecha de inicio.
export function applyDeadline(resp, req, today = todayDate()) {
  if (!resp.policy) return resp;
  const start = req.delivery_date || req.purchase_date;
  if (!start) return resp;
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
