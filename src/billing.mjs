// Cobro y saldo. El COBRO ES ATÓMICO: un solo UPDATE con guarda de saldo.
// Nada de SELECT-luego-UPDATE (eso tenía carrera y dejaba saldo negativo).

import { nowISO, newApiKey } from "./util.mjs";

export async function getClient(env, apiKey) {
  if (!apiKey) return null;
  return await env.DB.prepare(
    "SELECT api_key, email, balance_usd, status, calls_charged, calls_free FROM clients WHERE api_key = ?"
  ).bind(apiKey).first();
}

// Descuenta `amount` SOLO si hay saldo suficiente, de forma atómica.
// Devuelve { charged:true, remaining } o { charged:false } si no había saldo
// (carrera con otra consulta simultánea, o saldo insuficiente).
export async function chargeAtomic(env, apiKey, amount, ref) {
  const res = await env.DB.prepare(
    "UPDATE clients SET balance_usd = balance_usd - ?1, calls_charged = calls_charged + 1 " +
    "WHERE api_key = ?2 AND status = 'active' AND balance_usd >= ?1"
  ).bind(amount, apiKey).run();

  if (!res.meta || res.meta.changes !== 1) return { charged: false };

  const row = await env.DB.prepare("SELECT balance_usd FROM clients WHERE api_key = ?").bind(apiKey).first();
  // Registro en el libro mayor (no bloquea la respuesta si fallara).
  env.DB.prepare("INSERT INTO ledger (api_key, kind, amount_usd, ref, created_at) VALUES (?,?,?,?,?)")
    .bind(apiKey, "charge", -amount, ref || null, nowISO()).run().catch(() => {});
  return { charged: true, remaining: row ? row.balance_usd : null };
}

// Consulta servida gratis (UNKNOWN): no toca saldo, solo cuenta.
export async function markFree(env, apiKey) {
  env.DB.prepare("UPDATE clients SET calls_free = calls_free + 1 WHERE api_key = ?")
    .bind(apiKey).run().catch(() => {});
}

// Recarga de saldo (desde el webhook de Stripe).
export async function credit(env, apiKey, amount, ref) {
  await env.DB.prepare("UPDATE clients SET balance_usd = balance_usd + ? WHERE api_key = ?")
    .bind(amount, apiKey).run();
  env.DB.prepare("INSERT INTO ledger (api_key, kind, amount_usd, ref, created_at) VALUES (?,?,?,?,?)")
    .bind(apiKey, "topup", amount, ref || null, nowISO()).run().catch(() => {});
}

// Alta de cliente con crédito de prueba (saldo inicial > 0).
export async function createClient(env, email, freeCreditUsd) {
  const apiKey = newApiKey();
  await env.DB.prepare(
    "INSERT INTO clients (api_key, email, balance_usd, status, created_at) VALUES (?,?,?, 'active', ?)"
  ).bind(apiKey, email, freeCreditUsd, nowISO()).run();
  if (freeCreditUsd > 0) {
    env.DB.prepare("INSERT INTO ledger (api_key, kind, amount_usd, ref, created_at) VALUES (?,?,?,?,?)")
      .bind(apiKey, "topup", freeCreditUsd, "signup_credit", nowISO()).run().catch(() => {});
  }
  return apiKey;
}
