// W19 — REGISTRO DE RESPUESTAS.
//
// EL AGUJERO QUE CIERRA: en /data-policy llevábamos publicado desde el 25 de
// agosto que guardamos datos «to verify our own answers, correct our errors».
// No podíamos. Guardábamos el texto de las políticas y unos contadores sin fecha.
// Si un cliente decía «el martes me respondisteis mal a esto», no teníamos nada
// que mirar. Para un producto cuyo argumento entero es «toda afirmación con
// fuente», no poder auditar las propias afirmaciones era el agujero más
// incoherente que teníamos.
//
// LO QUE ESTO PERMITE, y no es un registro de depuración: reproducir. Se guarda
// el enlace a la VERSIÓN EXACTA de la política que leímos (`corpus_id`), las
// entradas estructuradas que cambiaron el veredicto, y la respuesta entera con la
// cita y el guardián que disparó. Con eso, ante una queja, se puede volver a
// pasar el mismo texto por el mismo build y ver si acertamos o no. La diferencia
// entre «lo sentimos» y «tiene usted razón, esto fue nuestro y así lo arreglamos».
//
// REGLAS, las mismas que el corpus:
//  1. Nunca romper una consulta. Si el registro falla, el cliente no se entera.
//     Vale más perder una fila que devolver un error por guardarla.
//  2. Nunca la clave de API ni el correo. Solo `client_ref`, su sha-256.
//  3. Nunca texto libre del cliente. Campos estructurados y la URL sin query.

import { nowISO } from "./util.mjs";
import { sha256full, detectPII } from "./corpus.mjs";

const MAX_CLAUSE = 2000;
const MAX_URL = 500;

function uuid() {
  return (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : "ans-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
}

function recorta(v, max) {
  const t = v == null ? null : String(v);
  return t == null ? null : (t.length > max ? t.slice(0, max) : t);
}

/**
 * La URL, sin lo que no debe guardarse.
 *
 * Se corta en el «?» a propósito: ahí es donde viajan los identificadores de
 * sesión, los tokens de compartir y los parámetros de seguimiento. Y si lo que
 * queda todavía huele a dato personal —hay tiendas que meten el correo en la
 * ruta— se guarda solo el origen. Perder la ruta es barato; guardar el correo de
 * un comprador en nuestra base, no.
 */
export function sanitizeUrl(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  let u;
  try { u = new URL(t); } catch { try { u = new URL("https://" + t); } catch { return null; } }
  const limpia = u.origin + u.pathname;
  if (detectPII(u.pathname).length) return recorta(u.origin, MAX_URL);
  return recorta(limpia, MAX_URL);
}

function mesesDespues(iso, meses) {
  const n = Number(meses);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}

function dominioDe(v) {
  const t = String(v || "").trim();
  if (!t) return null;
  try { return new URL(t).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  try { return new URL("https://" + t).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  return null;
}

/**
 * Escribe una fila por respuesta. Se llama desde `closeOut`, que es el único
 * punto del motor donde la respuesta ya está TERMINADA — la lección de W17: nada
 * se registra hasta que la respuesta está cerrada, o se guarda una cosa distinta
 * de la que dimos.
 *
 * Nunca lanza. Devuelve el id, que se expone al cliente como `check_id` para que
 * pueda citarlo en una reclamación.
 */
export async function recordAnswer(env, { resp, req, apiKey, build, corpusId } = {}) {
  try {
    if (!env || !env.DB || !resp) return null;
    if (String(env.ANSWER_LOG ?? "true") === "false") return null;
    // W22 — el EXAMEN no ensucia el registro. Mismo criterio que W15 con el
    // corpus y por la misma razon: 43 respuestas sinteticas por pasada mezcladas
    // con las reales convierten el registro de reclamaciones en un sitio donde
    // hay que filtrar antes de mirar, y un archivo que hay que limpiar para
    // usarlo deja de usarse. La regla vive AQUI, no en el motor, para que el
    // modulo se proteja solo y se pueda probar de verdad.
    if (req && req.__no_corpus) return null;

    const ahora = nowISO();
    const id = uuid();
    const p = resp.policy || {};
    const ev = resp.evidence || {};
    const guard = (resp.meta && resp.meta.guard) || {};
    const url = sanitizeUrl(req && (req.product_url || req.policy_url));
    const dominio =
      (resp.merchant_resolved && resp.merchant_resolved.domain) ||
      dominioDe(ev.source_url) || dominioDe(url);

    await env.DB.prepare(
      `INSERT INTO answer_log (
         id, answered_at, build, model, client_ref, via, cache_hit,
         corpus_id, merchant_domain, product_url,
         buyer_country, buyer_state, item_condition, return_reason,
         membership, purchase_channel, seller_name,
         purchase_date, delivery_date, as_of,
         verdict, returnable, confidence, return_category, return_days,
         window_basis, deadline_date, exact_clause,
         guard_name, guard_rejected_clause, reason,
         charged, price_usd, retention_until
       ) VALUES (?,?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?)`
    ).bind(
      id, ahora, build || null, (env.AI_MODEL || "default-8b-fast"),
      apiKey ? await sha256full(apiKey) : null,
      // W20 — vive en resp.meta.checked_via, no en la raiz. Lo lei mal en W19 y la
      // columna salia siempre vacia: el registro no sabia si una respuesta venia
      // de la cache, del JSON-LD o del modelo, que es justo lo que decide si se
      // puede reproducir igual.
      (resp.meta && resp.meta.checked_via) || null,
      resp.meta && resp.meta.cache_hit ? 1 : 0,

      corpusId || (resp.meta && resp.meta.corpus_id) || null,
      dominio || null,
      url,

      (req && req.buyer_country) || null,
      (req && req.buyer_state) || null,
      (req && req.item_condition) || null,
      (req && req.reason) || null,
      (req && req.membership) || null,
      (req && req.purchase_channel) || null,
      (req && req.seller_name) || null,
      (req && req.purchase_date) || null,
      (req && req.delivery_date) || null,
      (req && req.as_of) || null,

      resp.verdict || "UNKNOWN",
      resp.returnable === true ? 1 : (resp.returnable === false ? 0 : null),
      Number.isFinite(resp.confidence) ? resp.confidence : null,
      p.return_category || null,
      Number.isFinite(p.merchant_return_days) ? p.merchant_return_days : null,
      p.window_basis || null,
      p.deadline_date || null,
      recorta(ev.exact_clause, MAX_CLAUSE),

      guard.name || null,
      recorta(guard.rejected_clause, MAX_CLAUSE),
      recorta(resp.reason, MAX_CLAUSE),

      null, null,                                   // el cobro se resuelve después
      mesesDespues(ahora, env.ANSWER_RETENTION_MONTHS || "12")
    ).run();

    return id;
  } catch (_) {
    return null;   // regla 1: el registro nunca rompe una consulta
  }
}

/** Marca si la respuesta se cobró. Se llama tras el cobro. Nunca lanza. */
/**
 * W41 — `charged` admite TRES estados, no dos.
 *
 *   1     cobrado y confirmado
 *   0     no se cobró, y lo sabemos
 *   null  NO SABEMOS todavía — se lanzó la liquidación y no tenemos confirmación
 *
 * El tercero no es un adorno: el 27 de agosto una liquidación venció el plazo,
 * la anotamos como `0`, y el dinero había llegado. Una fila que dice «no se
 * cobró» cuando sí se cobró es peor que no tener fila, porque ante una queja la
 * consultaríamos y contestaríamos que no. El esquema ya lo preveía —«NULL hasta
 * que el cobro se resuelve»—; era esta función la que no sabía escribirlo.
 *
 * Y da la lista de conciliación, que antes no existía:
 *   SELECT id FROM answer_log WHERE charged IS NULL AND price_usd > 0
 */
export async function markAnswerCharged(env, id, priceUsd, charged = true) {
  try {
    if (!env || !env.DB || !id) return;
    const valor = charged === null ? null : (charged ? 1 : 0);
    await env.DB.prepare("UPDATE answer_log SET charged = ?, price_usd = ? WHERE id = ?")
      .bind(valor, Number.isFinite(priceUsd) ? priceUsd : null, id).run();
  } catch (_) { /* nunca rompe */ }
}

/**
 * Las respuestas cuyo cobro quedó sin resolver. Se concilian mirando la cadena:
 * el dinero llegó o no llegó, y eso es comprobable.
 */
export async function pendingSettlements(env, limit = 100) {
  try {
    const r = await env.DB.prepare(
      "SELECT id, answered_at, merchant_domain, verdict, price_usd FROM answer_log " +
      "WHERE charged IS NULL AND price_usd > 0 ORDER BY answered_at DESC LIMIT ?"
    ).bind(Number(limit) || 100).all();
    return (r && r.results) || [];
  } catch (_) { return []; }
}

/**
 * Buscar respuestas. Es la herramienta de reclamaciones: se llega por el
 * `check_id` que el cliente cita, o por cliente y fecha cuando no lo tiene.
 */
export async function findAnswers(env, { id = null, clientRef = null, domain = null,
                                         since = null, until = null, verdict = null,
                                         limit = 50 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const cond = [];
  const args = [];
  if (id)        { cond.push("id = ?");              args.push(id); }
  if (clientRef) { cond.push("client_ref = ?");      args.push(clientRef); }
  if (domain)    { cond.push("merchant_domain = ?"); args.push(dominioDe(domain) || domain); }
  if (since)     { cond.push("answered_at >= ?");    args.push(since); }
  if (until)     { cond.push("answered_at <= ?");    args.push(until); }
  if (verdict)   { cond.push("verdict = ?");         args.push(verdict); }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  const r = await env.DB
    .prepare(`SELECT * FROM answer_log ${where} ORDER BY answered_at DESC LIMIT ?`)
    .bind(...args, n).all();
  return { answers: r.results || [], count: (r.results || []).length };
}

/** Borra todo lo de un cliente. La promesa de /data-policy tiene que ser ejecutable. */
export async function deleteClientAnswers(env, clientRef) {
  const r = await env.DB.prepare("DELETE FROM answer_log WHERE client_ref = ?").bind(clientRef).run();
  return { rows_affected: (r.meta && r.meta.changes) || 0 };
}

/**
 * Barrido de retención. Prometer 12 meses y no tener el barrido es peor que no
 * prometerlo — la lección del doc 40, punto 3.
 */
export async function purgeExpiredAnswers(env, now = nowISO()) {
  const r = await env.DB
    .prepare("DELETE FROM answer_log WHERE retention_until IS NOT NULL AND retention_until < ?")
    .bind(now).run();
  return { rows_affected: (r.meta && r.meta.changes) || 0 };
}

export async function answerStats(env) {
  const r = await env.DB.prepare(
    `SELECT verdict, COUNT(*) AS n FROM answer_log GROUP BY verdict`
  ).all();
  const t = await env.DB.prepare(
    `SELECT COUNT(*) AS total, MIN(answered_at) AS primera, MAX(answered_at) AS ultima FROM answer_log`
  ).first();
  return {
    total: (t && t.total) || 0,
    first_answer_at: (t && t.primera) || null,
    last_answer_at: (t && t.ultima) || null,
    by_verdict: Object.fromEntries((r.results || []).map((x) => [x.verdict, x.n])),
  };
}
