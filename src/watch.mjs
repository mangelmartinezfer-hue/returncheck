// W16 — AVISOS DE CAMBIO DE POLÍTICA.
//
// LA IDEA, y es de Miguel (doc 45 §5): a un robot no se le puede llamar. No
// tienen buzón, no hay lista de agentes a los que escribir, y mandar ofertas no
// solicitadas es spam. Así que se le da la vuelta:
//
//     Que no llamemos nosotros — que nos pidan ellos que les avisemos.
//
// Un integrador registra los dominios que le importan. Cuando esa política
// cambia, lo tiene esperándole: «Nike pasó ayer de 60 a 30 días de ventana.»
//
// POR QUÉ ESTO CAMBIA EL NEGOCIO, y no es un adorno:
//
//  · Nadie lo tiene. Es exactamente lo que el histórico de versiones permite y
//    lo que la caché de 24 horas del competidor impide POR DISEÑO: si olvidas lo
//    de ayer, no puedes decir qué cambió hoy.
//  · Cambia la relación con el cliente: de llamarnos una vez a volver cada día.
//  · No es un desvío. Usa `supersedes_id`, el corpus y el motor tal como están.
//
// Y LO QUE LO HACE BARATO: la detección sale gratis. El corpus ya crea una fila
// nueva encadenada cuando el contenido cambia (W14). Aquí solo se mira qué
// cambió y se escribe una línea legible.
//
// LA VUELTA DE TUERCA, que conviene ver: el material sale del tráfico de los
// propios clientes. Si un integrador consulta Nike cada día, vemos la política de
// Nike cada día — y detectamos el cambio sin rastrear nada, sin chocar con
// robots.txt y sin renderizar JavaScript. Más clientes, más cobertura; más
// cobertura, mejores avisos. No hay que resolver el problema de leer las webs
// para que esto funcione: hay que tener tráfico.
//
// El reverso honesto: con cero tráfico no hay cambios que detectar. Esto NO trae
// el primer cliente. Sirve para que el primero no se vaya.
//
// ENTREGA: se PIDE, no se empuja. `GET /v1/changes`. Un agente es un programa que
// pregunta, no un buzón que recibe — y así no hay webhooks que fallen, ni
// reintentos, ni entregas perdidas. Si algún día un cliente pide webhook, se
// añade encima; al revés no se puede.

import { nowISO } from "./util.mjs";

function uuid() {
  return (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : "ch-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
}

export function normalizeDomain(v) {
  const t = String(v || "").trim();
  if (!t) return null;
  try { return new URL(t).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  try { return new URL("https://" + t).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Clasificar el cambio.
//
// Función pura y determinista a propósito: es lo que el cliente lee, y no puede
// depender de que un modelo redacte bien. Además así se puede probar entera sin
// base de datos ni red.
//
// El orden importa: ACORTAR una ventana es la noticia urgente —alguien que creía
// tener 60 días tiene 30— y por eso va primero y se dice con todas las letras.
// ---------------------------------------------------------------------------

export function classifyChange(before, after, domain) {
  const d = domain || "This merchant";
  const db = before && Number.isFinite(before.days) ? before.days : null;
  const da = after && Number.isFinite(after.days) ? after.days : null;
  const cb = (before && before.category) || null;
  const ca = (after && after.category) || null;

  if (db != null && da != null && da < db)
    return { kind: "window_shortened", summary: `${d}: return window shortened from ${db} to ${da} days.` };
  if (db != null && da != null && da > db)
    return { kind: "window_extended", summary: `${d}: return window extended from ${db} to ${da} days.` };
  if (db == null && da != null)
    return { kind: "window_added", summary: `${d}: a ${da}-day return window is now stated where none was before.` };
  if (db != null && da == null)
    return { kind: "window_removed", summary: `${d}: the previously stated ${db}-day return window is no longer in the policy.` };
  if (cb && ca && cb !== ca)
    return { kind: "category_changed", summary: `${d}: return category changed from ${cb} to ${ca}.` };
  // El texto cambió pero nada de lo que extraemos se movió: una reescritura, una
  // sección nueva, un cambio de redacción. Se registra igual —puede importar— pero
  // se marca como lo que es, para que nadie lo lea como un cambio de condiciones.
  return { kind: "text_only", summary: `${d}: the return policy text changed, but the stated window and category are unchanged.` };
}

/**
 * Escribe un cambio detectado. Lo llama la captura del corpus cuando crea una
 * versión que sustituye a otra. NUNCA lanza: un aviso perdido no puede tumbar
 * una consulta que el cliente está pagando.
 */
export async function recordPolicyChange(env, { domain, fromCorpusId, toCorpusId, before, after }) {
  try {
    if (!env || !env.DB || !toCorpusId) return null;
    const { kind, summary } = classifyChange(before, after, domain);
    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO policy_change
        (id, merchant_domain, from_corpus_id, to_corpus_id, detected_at, kind,
         days_before, days_after, category_before, category_after, summary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, domain, fromCorpusId || null, toCorpusId, nowISO(), kind,
      (before && Number.isFinite(before.days)) ? before.days : null,
      (after && Number.isFinite(after.days)) ? after.days : null,
      (before && before.category) || null, (after && after.category) || null,
      summary
    ).run();
    return id;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Suscripciones
// ---------------------------------------------------------------------------

export async function addWatch(env, clientRef, domain) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "A valid domain is required." };
  const ya = await env.DB
    .prepare("SELECT id FROM policy_watch WHERE client_ref = ? AND merchant_domain = ?")
    .bind(clientRef, d).first();
  if (ya && ya.id) {
    // Volver a pedir lo mismo lo REACTIVA en vez de fallar: para un programa que
    // reintenta, un 409 solo es un obstáculo que hay que rodear con código.
    await env.DB.prepare("UPDATE policy_watch SET active = 1 WHERE id = ?").bind(ya.id).run();
    return { ok: true, id: ya.id, domain: d, created: false };
  }
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO policy_watch (id, client_ref, merchant_domain, created_at, active) VALUES (?,?,?,?,1)"
  ).bind(id, clientRef, d, nowISO()).run();
  return { ok: true, id, domain: d, created: true };
}

export async function removeWatch(env, clientRef, domain) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "A valid domain is required." };
  await env.DB.prepare("UPDATE policy_watch SET active = 0 WHERE client_ref = ? AND merchant_domain = ?")
    .bind(clientRef, d).run();
  return { ok: true, domain: d, watching: false };
}

export async function listWatches(env, clientRef) {
  const r = await env.DB
    .prepare("SELECT merchant_domain, created_at FROM policy_watch WHERE client_ref = ? AND active = 1 ORDER BY created_at")
    .bind(clientRef).all();
  return (r.results || []).map((x) => ({ domain: x.merchant_domain, watching_since: x.created_at }));
}

/**
 * Los cambios de los dominios que este cliente vigila, más recientes primero.
 *
 * `since` es del cliente, no nuestro: él sabe cuándo preguntó por última vez y
 * nosotros no tenemos que llevar su cursor. Un cliente sin estado es un cliente
 * que no se nos puede desincronizar.
 */
export async function changesFor(env, clientRef, { since = null, limit = 50 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const sql =
    `SELECT c.id, c.merchant_domain, c.detected_at, c.kind,
            c.days_before, c.days_after, c.category_before, c.category_after, c.summary
       FROM policy_change c
       JOIN policy_watch w
         ON w.merchant_domain = c.merchant_domain AND w.client_ref = ? AND w.active = 1
      WHERE (? IS NULL OR c.detected_at > ?)
      ORDER BY c.detected_at DESC
      LIMIT ?`;
  const r = await env.DB.prepare(sql).bind(clientRef, since, since, n).all();
  const filas = (r.results || []).map((x) => ({
    id: x.id,
    merchant_domain: x.merchant_domain,
    detected_at: x.detected_at,
    kind: x.kind,
    days_before: x.days_before ?? null,
    days_after: x.days_after ?? null,
    category_before: x.category_before ?? null,
    category_after: x.category_after ?? null,
    summary: x.summary,
  }));
  return {
    changes: filas,
    // El cursor para la próxima llamada, ya calculado. Que el cliente no tenga
    // que deducirlo de la lista es la diferencia entre una API que se integra en
    // diez minutos y una que se integra en una tarde.
    next_since: filas.length ? filas[0].detected_at : since,
    count: filas.length,
  };
}
