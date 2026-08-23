// Tramo de prueba SIN clave: deja que un agente autónomo pruebe check_return sin
// darse de alta, con topes para acotar coste y abuso.
//  - Tope por IP/día (FREE_IP_DAILY).
//  - Tope GLOBAL/día (FREE_GLOBAL_DAILY) como red de seguridad del bolsillo.
// Guardamos solo un HASH de la IP (privacidad), nunca la IP en claro.
import { sha256hex, todayDate } from "./util.mjs";

let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS free_usage (bucket TEXT PRIMARY KEY, day TEXT, count INTEGER)"
  ).run();
  tableReady = true;
}

// Incrementa un contador diario de forma atómica y devuelve el nuevo valor.
// Si el registro es de un día anterior, se reinicia a 1.
async function bump(env, bucket, day) {
  const row = await env.DB.prepare(
    "INSERT INTO free_usage (bucket, day, count) VALUES (?1, ?2, 1) " +
    "ON CONFLICT(bucket) DO UPDATE SET " +
    "count = CASE WHEN free_usage.day = ?2 THEN free_usage.count + 1 ELSE 1 END, " +
    "day = ?2 RETURNING count"
  ).bind(bucket, day).first().catch(() => null);
  return row ? row.count : 1;
}

// Devuelve { allowed, remaining, reason }.
export async function freeTrial(env, request) {
  if (String(env.FREE_TRIAL_ENABLED || "false") !== "true")
    return { allowed: false, reason: "disabled" };
  try {
    await ensureTable(env);
    const day = todayDate();
    const ipCap = Number(env.FREE_IP_DAILY || "3");
    const globalCap = Number(env.FREE_GLOBAL_DAILY || "500");

    // Red de seguridad global primero (protege el gasto total del día).
    const g = await bump(env, "global:" + day, day);
    if (g > globalCap) return { allowed: false, reason: "global_cap" };

    const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
    const iph = (await sha256hex(ip)).slice(0, 16);
    const c = await bump(env, "ip:" + iph + ":" + day, day);
    if (c > ipCap) return { allowed: false, reason: "ip_cap" };

    return { allowed: true, remaining: Math.max(0, ipCap - c) };
  } catch (_) {
    // Si el contador falla, NO abrimos barra libre: mejor pedir alta.
    return { allowed: false, reason: "error" };
  }
}
