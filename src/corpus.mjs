// W14 — CAPTURA DEL CORPUS DE POLÍTICAS.
//
// POR QUÉ EXISTE ESTE FICHERO. La tabla `policy_corpus` está en la base de datos
// desde el 25 de agosto y hasta hoy no había una sola línea de código que
// escribiera en ella. No se notaba porque no hay tráfico: las 446 consultas de
// rodaje se tiraron enteras. El día que entre una plataforma se tirarían igual,
// y ese es justo el material del que sale todo lo demás — el histórico de
// versiones, los avisos de cambio de política, y cualquier evaluación futura.
//
// Por eso Miguel lo convirtió en una PUERTA, no en un recordatorio:
//
//     No se enciende x402 ni se entra en los directorios hasta que el corpus
//     capture.
//
// El orden importa: encender el cobro y aparecer en los directorios es lo que
// hace que empiecen a llegar llamadas. Capturando primero, la captura no puede
// llegar tarde por definición.
//
// DECISIÓN DE MIGUEL (doc 40), y hay que tenerla presente al leer este código:
// se guarda TODO el tráfico — opción B — con una base destruible si un comercio
// reclama. Eso convierte dos cosas de convenientes en imprescindibles: el filtro
// determinista de datos personales, y una vía de borrado por comercio que
// funcione de verdad y esté probada antes de que haga falta con un caso real.
//
// REGLAS DE ESTE MÓDULO:
//  1. Nunca romper una consulta. Si la captura falla, el cliente no se entera.
//     Vale más perder una fila del corpus que devolver un error por guardarla.
//  2. Nunca guardar la clave de API ni el correo. Solo `client_ref`, que es su
//     sha-256. Es lo que permite borrar por cliente sin saber quién es.
//  3. Nunca sobrescribir. Un cambio de contenido es una fila NUEVA que apunta a
//     la anterior con `supersedes_id`. El histórico es el producto.

import { nowISO } from "./util.mjs";

// Digest COMPLETO, a proposito. El sha256hex de util.mjs devuelve 12 caracteres
// —suficiente para etiquetar la version de una politica— pero aqui se usa para
// dos cosas donde no quiero recortes: la huella que decide si una politica ha
// cambiado, y el `client_ref` con el que se borra por cliente. 48 bits bastan
// hoy; el coste de usar los 256 es cero y no hay que volver a pensarlo.
async function sha256full(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Filtro determinista de datos personales.
//
// NO bloquea la captura: marca `pii_suspected = 1`, y una fila marcada no puede
// pasar a 'reviewed' sin que un humano la mire. Es una señal para el revisor, no
// un censor — porque una política de devoluciones legítima contiene direcciones
// del comercio y teléfonos de atención al cliente, y tirarlas sería tirar el
// documento.
//
// Determinista a propósito: si esto dependiera del modelo, tendríamos que
// confiar en él justo en la decisión donde menos podemos permitirnos un fallo
// silencioso.
// ---------------------------------------------------------------------------

const CORREO_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Tarjeta: 13-19 dígitos con separadores opcionales. Se valida con Luhn para no
// marcar cada número de pedido largo que aparezca en una página.
const TARJETA_RE = /\b(?:\d[ -]?){13,19}\b/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\b/;
// Teléfono en formato norteamericano o internacional con prefijo.
const TELEFONO_RE = /(?:\+\d{1,3}[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/;

function luhnValido(digitos) {
  let suma = 0, alterno = false;
  for (let i = digitos.length - 1; i >= 0; i--) {
    let d = digitos.charCodeAt(i) - 48;
    if (alterno) { d *= 2; if (d > 9) d -= 9; }
    suma += d; alterno = !alterno;
  }
  return suma % 10 === 0;
}

export function detectPII(text) {
  const t = String(text || "");
  const marcas = [];
  if (CORREO_RE.test(t)) marcas.push("email");
  if (SSN_RE.test(t)) marcas.push("gov_id");
  if (IBAN_RE.test(t)) marcas.push("iban");
  if (TELEFONO_RE.test(t)) marcas.push("phone");
  const m = t.match(TARJETA_RE);
  if (m) {
    const digitos = m[0].replace(/[^\d]/g, "");
    // Solo cuenta si además pasa Luhn: así un "order #1234567890123" no dispara.
    if (digitos.length >= 13 && digitos.length <= 19 && luhnValido(digitos)) marcas.push("card");
  }
  return marcas;
}

// ---------------------------------------------------------------------------
// Captura
// ---------------------------------------------------------------------------

const MAX_CHARS = 200000;   // el CHECK de la tabla

// De cómo llegó el texto a las dos columnas que la tabla separa a propósito:
// CÓMO llegaron los bytes (source_kind) y QUIÉN autorizó que los tuviéramos
// (provenance). No son lo mismo y mezclarlas fue un error que ya se corrigió
// en el diseño del esquema.
function clasificarOrigen(via) {
  switch (via) {
    case "agent_supplied":    return { source_kind: "page_text", provenance: "agent_supplied" };
    case "agent_supplied_html": return { source_kind: "page_html", provenance: "agent_supplied" };
    case "jsonld":            return { source_kind: "jsonld", provenance: "self_fetched" };
    case "policy_page_parse": return { source_kind: "fetched_url", provenance: "self_fetched" };
    case "page_parse":        return { source_kind: "fetched_url", provenance: "self_fetched" };
    default:                  return { source_kind: "fetched_url", provenance: "self_fetched" };
  }
}

function dominioDe(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

function mesesDespues(iso, meses) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + Number(meses || 48));
  return d.toISOString();
}

function uuid() {
  return (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : "id-" + Math.abs(Date.now()).toString(36) + "-" + Math.abs(Math.floor(Math.random() * 1e9)).toString(36);
}

/**
 * Guarda una política en el corpus. Devuelve el id de la fila (nueva o ya
 * existente), o null si no había nada que guardar o algo falló.
 *
 * NUNCA lanza: una consulta no puede romperse por la captura.
 */
export async function capturePolicy(env, {
  policyText, sourceUrl, via, merchantName, country, apiKey, scope,
} = {}) {
  try {
    if (!env || !env.DB) return null;
    if (String(env.CORPUS_CAPTURE ?? "true") === "false") return null;
    const texto = String(policyText || "");
    if (texto.length < 40) return null;              // ruido, no una política
    if (texto.length > MAX_CHARS) return null;       // el CHECK lo rechazaría

    const dominio = dominioDe(sourceUrl);
    if (!dominio) return null;

    const hash = await sha256full(texto);

    // ¿Ya la tenemos exactamente igual? UNIQUE(merchant_domain, content_hash).
    // Que se repita no es un fallo: es la señal de que la política NO ha cambiado.
    const yaEsta = await env.DB
      .prepare("SELECT id FROM policy_corpus WHERE merchant_domain = ? AND content_hash = ?")
      .bind(dominio, hash).first();
    if (yaEsta && yaEsta.id) return yaEsta.id;

    // Hay contenido distinto para este comercio: es una VERSIÓN NUEVA. Se enlaza
    // con la última que teníamos. Nunca se sobrescribe — el histórico de cambios
    // de política es exactamente el producto que nadie más tiene.
    const anterior = await env.DB
      .prepare("SELECT id FROM policy_corpus WHERE merchant_domain = ? AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT 1")
      .bind(dominio).first();

    const { source_kind, provenance } = clasificarOrigen(via);
    const ahora = nowISO();
    const marcasPII = detectPII(texto);
    const id = uuid();
    const s = scope || {};

    await env.DB.prepare(
      `INSERT INTO policy_corpus (
         id, merchant_domain, merchant_name, country,
         source_url, source_kind, provenance, authorized_by,
         content, content_hash, content_chars, captured_at, effective_at,
         scope_general, scope_category, scope_product, scope_seller, scope_channel, scope_membership,
         review_state, pii_suspected, supersedes_id,
         client_ref, retention_until, deleted_at
       ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?)`
    ).bind(
      id, dominio, merchantName || null, country || null,
      sourceUrl || null, source_kind, provenance, null,
      texto, hash, texto.length, ahora, null,
      s.category || s.product || s.seller || s.channel || s.membership ? 0 : 1,
      s.category || null, s.product || null, s.seller || null, s.channel || null, s.membership || null,
      "unreviewed", marcasPII.length ? 1 : 0, (anterior && anterior.id) || null,
      apiKey ? await sha256full(apiKey) : null,
      mesesDespues(ahora, env.DATA_RETENTION_MONTHS), null
    ).run();

    return id;
  } catch (_) {
    return null;   // regla 1: la captura nunca rompe una consulta
  }
}

/** Registra que una política se USÓ para responder. Nunca lanza. */
export async function recordCorpusUse(env, corpusId, verdict, contextKind = "check") {
  try {
    if (!env || !env.DB || !corpusId) return;
    await env.DB.prepare(
      "INSERT INTO policy_corpus_use (corpus_id, used_at, context_kind, context_ref, verdict) VALUES (?,?,?,?,?)"
    ).bind(corpusId, nowISO(), contextKind, null, verdict || null).run();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Borrado por comercio.
//
// No es un extra: es la contrapartida de haber decidido guardarlo todo. Si un
// comercio reclama, esto tiene que funcionar a la primera y sin pensarlo. Por eso
// existe ANTES de que haga falta, y por eso hay una prueba que lo ejecuta con un
// caso inventado — la primera vez que se usa no puede ser con uno real.
//
// Borrado LÓGICO: marca `deleted_at`. El purgado físico es un trabajo aparte y
// deliberado, para que un borrado por error se pueda deshacer mientras siga
// dentro del plazo. La vista `policy_corpus_reviewed` ya excluye lo borrado, así
// que el motor deja de verlo en el mismo instante.
// ---------------------------------------------------------------------------

export async function deleteMerchantCorpus(env, domain, { purge = false } = {}) {
  const dominio = String(domain || "").replace(/^www\./, "").toLowerCase().trim();
  if (!dominio) return { ok: false, error: "domain required" };
  const antes = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM policy_corpus WHERE merchant_domain = ? AND deleted_at IS NULL")
    .bind(dominio).first();
  const n = (antes && antes.n) || 0;
  if (purge) {
    await env.DB.prepare("DELETE FROM policy_corpus_use WHERE corpus_id IN (SELECT id FROM policy_corpus WHERE merchant_domain = ?)").bind(dominio).run();
    await env.DB.prepare("DELETE FROM policy_corpus WHERE merchant_domain = ?").bind(dominio).run();
  } else {
    await env.DB.prepare("UPDATE policy_corpus SET deleted_at = ? WHERE merchant_domain = ? AND deleted_at IS NULL")
      .bind(nowISO(), dominio).run();
  }
  return { ok: true, domain: dominio, rows_affected: n, mode: purge ? "purged" : "soft_deleted" };
}

/** Resumen del corpus para el panel de administración. */
export async function corpusStats(env) {
  try {
    const q = async (sql) => ((await env.DB.prepare(sql).first()) || {});
    const total = await q("SELECT COUNT(*) AS n FROM policy_corpus WHERE deleted_at IS NULL");
    const dominios = await q("SELECT COUNT(DISTINCT merchant_domain) AS n FROM policy_corpus WHERE deleted_at IS NULL");
    const pii = await q("SELECT COUNT(*) AS n FROM policy_corpus WHERE deleted_at IS NULL AND pii_suspected = 1");
    const revisadas = await q("SELECT COUNT(*) AS n FROM policy_corpus WHERE deleted_at IS NULL AND review_state = 'reviewed'");
    const versiones = await q("SELECT COUNT(*) AS n FROM policy_corpus WHERE deleted_at IS NULL AND supersedes_id IS NOT NULL");
    const borradas = await q("SELECT COUNT(*) AS n FROM policy_corpus WHERE deleted_at IS NOT NULL");
    return {
      documents: total.n || 0,
      merchants: dominios.n || 0,
      pii_suspected: pii.n || 0,
      reviewed: revisadas.n || 0,
      superseding_versions: versiones.n || 0,   // cuántas veces hemos visto cambiar una política
      soft_deleted: borradas.n || 0,
    };
  } catch (_) { return {}; }
}
