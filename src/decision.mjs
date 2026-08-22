// Lógica de decisión pura (sin dependencias de Cloudflare) -> testeable en Node.
import { todayDate, addDays } from "./util.mjs";

// Recomputa deadline_date con la fecha de compra de ESTA petición y convierte
// a NO si la ventana finita ya venció. No inventa fechas: solo si hay días y compra.
export function applyDeadline(resp, req, today = todayDate()) {
  if (!resp.policy || !req.purchase_date) return resp;
  const days = resp.policy.merchant_return_days;
  if (days == null) return resp;
  const deadline = addDays(req.purchase_date, days);
  resp.policy.deadline_date = deadline;
  if (resp.policy.return_category === "FiniteReturnWindow" && deadline < today && resp.verdict !== "NO") {
    resp.verdict = "NO";
    resp.returnable = false;
    resp.reason = `Return window elapsed: deadline was ${deadline}.`;
  }
  return resp;
}
