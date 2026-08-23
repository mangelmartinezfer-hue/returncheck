// Contadores de producto (métricas): consultas, veredictos, vías, cachés...
// Tabla simple clave->valor en D1. Se autocrea. Todo tolerante a fallos (nunca
// rompe una consulta por un problema de métricas).

let ready = false;
async function ensure(env) {
  if (ready) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS metrics (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)"
  ).run();
  ready = true;
}

// Incrementa un contador de forma atómica.
export async function bumpMetric(env, name, by = 1) {
  try {
    await ensure(env);
    await env.DB.prepare(
      "INSERT INTO metrics (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = value + ?2"
    ).bind(name, by).run();
  } catch (_) { /* las métricas nunca rompen nada */ }
}

// Registra una consulta completa: total + veredicto + vía + caché.
export async function recordCheck(env, resp) {
  try {
    const via = (resp.meta && resp.meta.checked_via) || "unknown";
    await bumpMetric(env, "checks_total");
    await bumpMetric(env, "verdict_" + (resp.verdict || "UNKNOWN"));
    await bumpMetric(env, "via_" + via);
    if (resp.meta && resp.meta.cache_hit) await bumpMetric(env, "cache_hits");
  } catch (_) {}
}

// Lee todos los contadores como objeto {name: value}.
export async function readMetrics(env) {
  try {
    await ensure(env);
    const r = await env.DB.prepare("SELECT name, value FROM metrics").all();
    const o = {};
    for (const row of (r.results || [])) o[row.name] = row.value;
    return o;
  } catch (_) { return {}; }
}
