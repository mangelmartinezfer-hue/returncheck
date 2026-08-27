// Utilidades compartidas.

// W19 — La versión del código vive aquí, no en index.mjs, porque ahora la
// necesitan dos sitios: la ruta que la publica y el registro de respuestas, que
// sin ella no puede decir QUÉ build dio una respuesta concreta. Es el dato que
// convierte "respondimos mal" en "respondimos mal con este código, y lo
// arreglamos en este otro".
export const BUILD = "2026-08-27-w26-quinta-familia";

export function nowISO() {
  return new Date().toISOString();
}
export function todayDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Respuestas JSON con cabeceras estándar.
export function json(obj, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Error del contrato (check_return.error.v1). Nunca se cobra.
export function errorResponse(code, message, httpStatus, details) {
  const body = { error: { code, message } };
  if (details) body.error.details = details;
  return json(body, { status: httpStatus });
}

// Clave de API pública para un cliente nuevo.
export function newApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "rc_live_" + hex;
}

// Huella (hash) del texto de la política -> policy_version.
export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

// Normaliza una URL de producto para clave de caché: quita parámetros de tracking y fragmento.
export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    const drop = [...url.searchParams.keys()].filter((k) => /^(utm_|gclid|fbclid|ref|_ga)/i.test(k));
    drop.forEach((k) => url.searchParams.delete(k));
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

// Suma días a una fecha YYYY-MM-DD -> YYYY-MM-DD.
export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
