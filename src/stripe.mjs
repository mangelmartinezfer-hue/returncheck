// Webhook de Stripe: verifica la firma y acredita el saldo del cliente.
// El secreto STRIPE_WEBHOOK_SECRET vive como secreto de Cloudflare, nunca en el código.

import { credit } from "./billing.mjs";
import { nowISO } from "./util.mjs";

// Verifica la cabecera Stripe-Signature (esquema t=...,v1=...).
async function verify(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Comparación de longitud constante.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const ok = await verify(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(payload);

  // Idempotencia: no procesar el mismo evento dos veces.
  const seen = await env.DB.prepare("SELECT event_id FROM stripe_events WHERE event_id = ?").bind(event.id).first().catch(() => null);
  if (seen) return new Response("ok (dup)", { status: 200 });
  env.DB.prepare("INSERT OR IGNORE INTO stripe_events (event_id, created_at) VALUES (?,?)").bind(event.id, nowISO()).run().catch(() => {});

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const apiKey = s.metadata && s.metadata.api_key;
    const amount = (s.amount_total || 0) / 100; // céntimos -> USD
    if (apiKey && amount > 0) await credit(env, apiKey, amount, event.id);
  }
  return new Response("ok", { status: 200 });
}
