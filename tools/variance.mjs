#!/usr/bin/env node
// W05 — medidor de varianza del motor.
//
// PARA QUÉ: lanzar el MISMO caso N veces contra el MISMO build y contar cuántas
// respuestas distintas salen. Es la única forma de saber si un cambio de
// parámetros mejora la estabilidad o solo lo parece.
//
// CÓMO SE USA (PowerShell):
//   $env:RC_API_KEY = "<tu clave>"          # NUNCA la pegues en un chat
//   node tools/variance.mjs --n 8 --case finita90
//   $env:RC_API_KEY = ""                    # limpiar al terminar
//
// Sin RC_API_KEY usa el tramo gratuito, que está limitado a 3 llamadas por IP
// y día: sirve para probar el script, no para medir.
//
// PROTOCOLO DEL EXPERIMENTO (una sola variable):
//   1. Con AI_TEMPERATURE = "0.6" en el panel  -> node tools/variance.mjs --n 8
//   2. Con AI_TEMPERATURE = "0"   en el panel  -> node tools/variance.mjs --n 8
//   Mismo build, mismo caso, misma N. Solo cambia la temperatura.

const BASE = process.env.RC_BASE_URL || "https://returncheck.m-angelmartinez-fer.workers.dev";
const KEY = process.env.RC_API_KEY || "";

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

// Casos de prueba. Texto corto y deliberado: si el motor no es estable aquí,
// no lo va a ser con la página real de un comercio.
const CASES = {
  // Ventana finita, plazo YA VENCIDO. El veredicto correcto es NO.
  finita90: {
    nombre: "Ventana de 90 días, compra fuera de plazo",
    esperado: "NO",
    body: {
      product_url: "https://example.com/p/variance-finita90",
      buyer_country: "US",
      item_condition: "unopened",
      purchase_date: "2026-04-01",
      page_text: "Returns. You may return merchandise within 90 calendar days of purchase. Items must be unused and in original packaging.",
    },
  },
  // Ventana finita, DENTRO de plazo. El veredicto correcto es devolvible.
  dentro30: {
    nombre: "Ventana de 30 días, compra dentro de plazo",
    esperado: "YES_WITH_CONDITIONS",
    body: {
      product_url: "https://example.com/p/variance-dentro30",
      buyer_country: "US",
      item_condition: "unopened",
      purchase_date: "2026-08-10",
      page_text: "Return Policy. Items may be returned within 30 days of purchase for a full refund. Original shipping charges are not refunded.",
    },
  },
  // Trampa de jurisdicción: depende del estado del comprador, que NO se da.
  // El veredicto honesto es UNKNOWN, no NO.
  jurisdiccion: {
    nombre: "Depende del estado del comprador (no se da) — debe ser UNKNOWN",
    esperado: "UNKNOWN",
    body: {
      product_url: "https://example.com/p/variance-jurisdiccion",
      buyer_country: "US",
      item_condition: "unopened",
      page_text: "Returns. Gift cards are non-returnable and non-refundable except where prohibited by law. All other merchandise may be returned within 30 days of purchase.",
    },
  },
};

const N = Math.max(2, parseInt(arg("n", "8"), 10) || 8);
const caseKey = arg("case", "finita90");
const CASE = CASES[caseKey];
if (!CASE) {
  console.error("Caso desconocido: " + caseKey + ". Disponibles: " + Object.keys(CASES).join(", "));
  process.exit(1);
}

// Huella de una respuesta: lo que de verdad tiene que ser estable.
// Un cambio de redacción en answer_human no nos importa; un cambio de veredicto,
// de plazo o de cláusula citada, sí.
function huella(r) {
  const p = r.policy || {};
  const clause = (r.evidence && r.evidence.exact_clause) || "";
  return [
    r.verdict,
    "days=" + (p.merchant_return_days ?? "null"),
    "basis=" + (p.window_basis ?? "null"),
    "deadline=" + (p.deadline_date ?? "null"),
    "cat=" + (p.return_category ?? "null"),
    "clause=" + clause.slice(0, 70),
  ].join(" | ");
}

async function unaPasada(i) {
  const headers = { "content-type": "application/json" };
  if (KEY) headers.authorization = "Bearer " + KEY;
  const t0 = Date.now();
  const res = await fetch(BASE + "/v1/check", {
    method: "POST", headers, body: JSON.stringify(CASE.body),
  });
  const ms = Date.now() - t0;
  const json = await res.json().catch(() => ({ error: "respuesta no era JSON" }));
  if (!res.ok) {
    const msg = (json.error && json.error.message) || JSON.stringify(json).slice(0, 160);
    return { ok: false, i, ms, error: "HTTP " + res.status + " — " + msg };
  }
  return { ok: true, i, ms, resp: json };
}

console.log("");
console.log("  Medidor de varianza — W05");
console.log("  ─────────────────────────────────────────────");
console.log("  Caso      : " + caseKey + " — " + CASE.nombre);
console.log("  Esperado  : " + CASE.esperado);
console.log("  Pasadas   : " + N);
console.log("  Clave     : " + (KEY ? "sí (de la variable de entorno)" : "NO — tramo gratuito, máx. 3/día"));
console.log("  Coste máx.: " + (N * 0.02).toFixed(2) + " USD (los UNKNOWN son gratis)");
console.log("");

const resultados = [];
for (let i = 1; i <= N; i++) {
  const r = await unaPasada(i);
  resultados.push(r);
  if (!r.ok) {
    console.log("  " + String(i).padStart(2) + ")  ERROR  " + r.error);
    continue;
  }
  const v = r.resp.verdict;
  const marca = v === CASE.esperado ? "ok " : "!! ";
  console.log("  " + String(i).padStart(2) + ")  " + marca + v.padEnd(20) + String(r.ms).padStart(5) + " ms");
}

const buenos = resultados.filter(r => r.ok);
if (!buenos.length) {
  console.log("\n  Ninguna pasada completó. Revisa la clave o el límite del tramo gratuito.\n");
  process.exit(1);
}

const grupos = new Map();
for (const r of buenos) {
  const h = huella(r.resp);
  grupos.set(h, (grupos.get(h) || 0) + 1);
}
const ordenados = [...grupos.entries()].sort((a, b) => b[1] - a[1]);
const correctos = buenos.filter(r => r.resp.verdict === CASE.esperado).length;

console.log("");
console.log("  Respuestas distintas: " + ordenados.length + " sobre " + buenos.length + " pasadas");
console.log("  Veredicto esperado  : " + correctos + "/" + buenos.length);
console.log("  ─────────────────────────────────────────────");
for (const [h, n] of ordenados) {
  console.log("  ×" + String(n).padStart(2) + "  " + h);
}
console.log("");
if (ordenados.length === 1) {
  console.log("  ESTABLE en esta tanda. Una sola respuesta en " + buenos.length + " pasadas.");
} else {
  console.log("  INESTABLE. " + ordenados.length + " respuestas distintas al mismo caso.");
}
console.log("");
console.log("  Recuerda: una tanda estable no prueba determinismo, solo que no");
console.log("  se vio variación en " + buenos.length + " intentos. Compara SIEMPRE dos");
console.log("  configuraciones con la misma N contra el mismo build.");
console.log("");
