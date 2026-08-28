// W42 — LA SONDA DE ADQUISICIÓN: ¿sabemos siquiera LEER una tienda real?
//
// POR QUÉ EXISTE. Todas nuestras cifras —el banco de 18, el holdout de 25, las
// cinco pasadas— se miden sobre texto de política que le damos NOSOTROS al motor,
// por `page_text`. Ninguna dice si el motor es capaz de CONSEGUIR ese texto de una
// tienda de verdad. Y el corpus de producción tiene tres políticas, las tres
// inventadas por nosotros.
//
// Lo descubrimos por accidente el 27 de agosto apuntando a una URL real de
// rei.com: `422 — Page needs a browser to render`. Es la única capa del sistema
// sin instrumentar, y de ella depende que haya producto.
//
// QUÉ MIDE Y QUÉ NO. Mide UNA sola cosa: si obtenemos el texto de la política.
// NO llama al modelo, NO emite veredicto, NO escribe en el corpus, NO cobra y NO
// toca la caché. Coste: cero.
//
// SE MIDE EL CAMINO REAL. Llama a `fetchPolicyText` y `discoverPolicyPage` del
// propio motor, las mismas que usa una consulta de pago, con la misma cabecera de
// navegador, los mismos plazos y el mismo umbral de señales. Reimplementarlas aquí
// habría medido mi copia, no el producto.
//
// SE GUARDAN LOS HECHOS CRUDOS, no solo el veredicto. El código de respuesta, los
// bytes, los caracteres de texto, las señales de política, la página descubierta.
// Así la clasificación se puede revisar más tarde sin volver a salir a la red — y
// sabiendo lo mucho que hemos tenido que revisar clasificaciones estos días, eso
// no es un lujo.

import { fetchPolicyText, discoverPolicyPage, EngineError } from "./engine.mjs";
import { policyKeywordHits } from "./text.mjs";

// El mismo umbral que usa el motor para decidir si el texto de producto trae
// política suficiente o hay que salir a buscar la página de devoluciones.
const SENALES_DEBILES = 4;

// Por debajo de esto, una página que respondió 200 es una cáscara de JavaScript:
// el servidor devolvió el esqueleto y el contenido lo monta el navegador.
const TEXTO_DE_CASCARA = 600;

/**
 * Los cuatro resultados. Cada uno significa una cosa distinta para el negocio, y
 * por eso no se agrupan:
 *
 *   texto_obtenido      lo leemos. Hay producto por esta vía.
 *   necesita_navegador  la página existe pero se monta con JavaScript.
 *                       TIENE ARREGLO: el navegador ya está montado, solo apagado.
 *   bloqueado           nos detectan como robot y nos cierran la puerta.
 *                       Difícil, y no se arregla con una variable.
 *   sin_politica        entramos y leemos, pero no encontramos la política.
 *                       Es otro problema: descubrimiento, no acceso.
 */
export const RESULTADOS = ["texto_obtenido", "necesita_navegador", "bloqueado", "sin_politica"];

// Códigos con los que un servidor dice «sé quién eres y no te quiero».
const CODIGOS_DE_BLOQUEO = new Set([401, 403, 405, 406, 429, 451, 503]);

/**
 * Sondea UNA url. Nunca lanza: un fallo es un dato, no una excepción.
 *
 * Devuelve los hechos crudos más el resultado derivado de ellos.
 */
export async function sondearUrl(env, url) {
  const t0 = Date.now();
  const diag = {};
  const fila = {
    url,
    resultado: null,
    via: null,
    http_status: null,
    html_bytes: null,
    text_chars: null,
    policy_hits: null,
    url_politica: null,
    politica_chars: null,
    politica_hits: null,
    error: null,
    ms: null,
  };

  let leido = null;
  try {
    leido = await fetchPolicyText(env, url, diag);
  } catch (e) {
    fila.error = e instanceof EngineError ? e.code : ((e && e.name) || "error");
    if (e instanceof EngineError && e.message) fila.mensaje = e.message;
  }

  fila.http_status = diag.http_status ?? null;
  fila.html_bytes  = diag.html_bytes ?? null;
  fila.text_chars  = diag.text_chars ?? null;
  fila.policy_hits = diag.policy_hits ?? null;
  if (diag.fetch_error) fila.error = fila.error || diag.fetch_error;
  // Si se pidio navegador y ni siquiera arranco, hay que verlo: es la diferencia
  // entre "el navegador no ayuda" y "el navegador no se ha usado".
  if (diag.browser_error) fila.browser_error = diag.browser_error;

  // ---------------------------------------------------------------------------
  // Caso 1: no conseguimos ni la página.
  // ---------------------------------------------------------------------------
  if (!leido) {
    // Un código de bloqueo es un rechazo deliberado, no un fallo técnico. Se
    // separa porque no tiene el mismo arreglo: el navegador no lo resuelve.
    fila.resultado = CODIGOS_DE_BLOQUEO.has(fila.http_status) ? "bloqueado" : "necesita_navegador";
    fila.ms = Date.now() - t0;
    return fila;
  }

  fila.via = leido.via;

  // ---------------------------------------------------------------------------
  // Caso 2: la página respondió, pero está vacía de texto -> cáscara de JavaScript.
  //
  // Esto NO lo distingue el motor hoy: para él es una página que se leyó y no
  // traía política, y acaba en UNKNOWN. Aquí sí importa la diferencia, porque una
  // cáscara la arregla el navegador y una página sin política no.
  // ---------------------------------------------------------------------------
  const textoProducto = leido.text || "";
  const senalesProducto = policyKeywordHits(textoProducto);
  const esCascara = (fila.text_chars != null && fila.text_chars < TEXTO_DE_CASCARA);

  // ---------------------------------------------------------------------------
  // Caso 3: la política ya viene en la página de producto.
  // ---------------------------------------------------------------------------
  if (senalesProducto >= SENALES_DEBILES) {
    fila.resultado = "texto_obtenido";
    fila.via = leido.via === "page_parse" ? "producto_navegador" : "producto";
    fila.politica_chars = textoProducto.length;
    fila.politica_hits = senalesProducto;
    fila.ms = Date.now() - t0;
    return fila;
  }

  // ---------------------------------------------------------------------------
  // Caso 4: no venía en la de producto -> se busca la página de devoluciones,
  // exactamente como hace el motor en una consulta real.
  // ---------------------------------------------------------------------------
  let encontrada = null;
  try {
    encontrada = await discoverPolicyPage(env, url, leido.html || "");
  } catch (_) { /* el descubrimiento es best-effort; nunca decide por excepción */ }

  if (encontrada && encontrada.text) {
    fila.url_politica = encontrada.url || null;
    fila.politica_chars = encontrada.text.length;
    fila.politica_hits = encontrada.hits ?? policyKeywordHits(encontrada.text);
    if (fila.politica_hits >= SENALES_DEBILES) {
      fila.resultado = "texto_obtenido";
      fila.via = "pagina_devoluciones";
      fila.ms = Date.now() - t0;
      return fila;
    }
  }

  // ---------------------------------------------------------------------------
  // Nada. Distinguimos por qué, que es lo que decide si tiene arreglo barato.
  // ---------------------------------------------------------------------------
  fila.resultado = esCascara ? "necesita_navegador" : "sin_politica";
  fila.ms = Date.now() - t0;
  return fila;
}

/**
 * Sondea una tanda. En SERIE a propósito.
 *
 * En paralelo iría más rápido, pero cincuenta peticiones simultáneas desde una IP
 * de Cloudflare a tiendas grandes es exactamente el patrón que dispara sus
 * defensas antirrobot. Mediríamos nuestra propia prisa, no su política.
 */
export async function sondearTanda(env, urls) {
  const filas = [];
  for (const u of urls) filas.push(await sondearUrl(env, u));
  return filas;
}

/** Recuento por resultado, con el porcentaje que es la cifra que decide. */
export function resumir(filas) {
  const cuenta = Object.fromEntries(RESULTADOS.map((r) => [r, 0]));
  for (const f of filas) if (f.resultado in cuenta) cuenta[f.resultado]++;
  const total = filas.length || 1;
  return {
    total: filas.length,
    ...cuenta,
    pct_obtenido: Math.round((cuenta.texto_obtenido / total) * 1000) / 10,
    ms_p50: percentil(filas.map((f) => f.ms || 0), 50),
    ms_p90: percentil(filas.map((f) => f.ms || 0), 90),
  };
}

function percentil(nums, p) {
  if (!nums.length) return 0;
  const orden = [...nums].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.floor((p / 100) * orden.length))];
}
