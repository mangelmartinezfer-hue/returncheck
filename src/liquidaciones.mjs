// W57 — LA EVIDENCIA DE LIQUIDACION, GUARDADA DONDE DURA.
//
// POR QUE EXISTE ESTE MODULO. El 3 de septiembre de 2026 entro el primer pago
// real (0,02 USDC en Base mainnet) y al ir a comprobar el lado servidor salio
// esto: `answer_log`, que guarda 12 meses, no tiene ninguna columna de cadena.
// El unico sitio que unia la respuesta con la transaccion era
// `payment_idempotency`, y ese enlace tenia dos defectos peores que faltar:
//
//   · solo se escribe si el comprador manda `payment-identifier`, que es una
//     extension NUESTRA y opcional. Quien pague sin ella no dejaba rastro;
//   · caduca a las 24 horas, y sobrevivia solo porque el purgado existe y nadie
//     lo llama.
//
// LO QUE ESTE MODULO NO HACE, y hay que decirlo antes que lo que hace: NO vuelve
// la asociacion comprobable por un tercero. Que ese pago pagara ESTA respuesta
// sigue siendo una afirmacion de ReturnCheck. La transaccion no lleva el
// check_id y `transferWithAuthorization` no tiene campo libre donde meterlo. Lo
// que se gana es que la afirmacion exista durante 12 meses, con todos sus datos,
// sin depender de que el comprador use una extension opcional. La capa que
// convertiria eso en verificable (un nonce que comprometa la peticion) NO entra
// aqui: queda propuesta, sin implementar.

import { nowISO } from "./util.mjs";

function mesesDespues(iso, meses) {
  const n = Number(meses);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}

const igual = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const lleno = (v) => typeof v === "string" && v.trim() !== "";

/**
 * ¿SE SOSTIENE LO QUE EL FACILITADOR NOS DICE?
 *
 * Funcion PURA, y separada a proposito: es la regla de negocio, y una regla que
 * solo se puede probar con base de datos delante acaba sin probarse.
 *
 * QUE COMPARA Y CONTRA QUE. El facilitador nos devuelve red, pagador y —de
 * rebote— un exito. Nosotros tenemos dos fuentes independientes de la verdad que
 * el no controla: la AUTORIZACION que el comprador firmo (`authorization`) y los
 * REQUISITOS que nosotros pedimos (`aceptado`). Si lo que vuelve no cuadra con
 * las dos, no se registra como confirmado.
 *
 * ES LA MISMA DISCIPLINA DE W51 en `evidenciaDePago`, aplicada a lo que se
 * ESCRIBE en vez de a lo que se sirve: un "confirmed" que los datos no sostienen
 * baja a "unconfirmed", que es exactamente lo que significa —no sabemos en que
 * quedo—, y se anota QUE campo fallo. Guardar "no cuadro" sin decir cual es una
 * alarma que nadie puede investigar despues.
 *
 * OJO CON LO QUE NO HACE: no toca lo que se le sirve al comprador. Esa decision
 * ya la toma `evidenciaDePago` por su cuenta, con su propia comprobacion. Aqui
 * solo se decide con que estado queda la fila.
 */
export function evaluarCoherencia({ estado, liquidacion, autorizacion, aceptado }) {
  if (estado !== "confirmed") return { estado, mismatch: null };

  const a = autorizacion || {};
  const q = aceptado || {};
  const l = liquidacion || {};
  const fallos = [];

  // La red que liquido tiene que ser la que pedimos.
  if (lleno(l.red) && !igual(l.red, q.network)) fallos.push("network");

  // El pagador que declara el facilitador tiene que ser QUIEN FIRMO. Si no
  // coincide, estamos a punto de publicar como pagador a alguien que no lo es.
  if (lleno(l.pagador) && !igual(l.pagador, a.from)) fallos.push("payer");

  // El importe se compara como TEXTO: unidades atomicas, pueden no caber en un
  // numero seguro. Y se compara en los dos sentidos —lo firmado contra lo
  // pedido— porque un pago por menos de lo pedido tambien es un descuadre.
  if (String(a.value ?? "") !== String(q.amount ?? "")) fallos.push("amount");

  // Sin hash no hay nada que cotejar contra la cadena: no es un cobro que se
  // pueda llamar confirmado.
  if (!lleno(l.transaccion)) fallos.push("transaction");

  if (!fallos.length) return { estado: "confirmed", mismatch: null };
  return { estado: "unconfirmed", mismatch: fallos.join(",") };
}

/**
 * Escribe la evidencia. NUNCA lanza: igual que el registro de respuestas, vale
 * mas perder una fila que devolverle un error al cliente por guardarla.
 *
 * `INSERT OR IGNORE` con check_id de clave primaria: un reintento no puede
 * duplicar la fila. Hoy el reintento ni siquiera llega —`cobrarConX402` devuelve
 * lo guardado y no vuelve a liquidar— pero la garantia se pone en el esquema y
 * no en la confianza de que ese camino no cambie.
 *
 * RETENCION: la misma que la respuesta a la que pertenece
 * (ANSWER_RETENTION_MONTHS, 12 meses). No se elige un numero aparte a proposito:
 * esta fila sin su `answer_log` no sirve de nada, asi que sobrevivirle seria
 * guardar datos de pago huerfanos, y quedarse corta seria dejar la respuesta sin
 * su evidencia. Van juntas o no van.
 */
export async function registrarLiquidacion(env, {
  checkId, estado, liquidacion, autorizacion, aceptado, ahora = null,
} = {}) {
  try {
    if (!env || !env.DB || !checkId) return null;
    if (!estado) return null;

    const cuando = ahora || nowISO();
    const { estado: estadoFinal, mismatch } =
      evaluarCoherencia({ estado, liquidacion, autorizacion, aceptado });

    const l = liquidacion || {}, a = autorizacion || {}, q = aceptado || {};
    await env.DB.prepare(
      `INSERT OR IGNORE INTO settlement_log
         (check_id, settled_at, status, transaction_hash, network, payer,
          amount_atomic, asset, nonce, pay_to, mismatch, retention_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      checkId,
      cuando,
      estadoFinal,
      l.transaccion || null,
      // La red sale de la liquidacion y, si no vino, de lo que pedimos: aqui no
      // se esta afirmando nada que la cadena tenga que sostener, solo en que red
      // se pidio el cobro.
      l.red || q.network || null,
      l.pagador || a.from || null,
      a.value != null ? String(a.value) : (q.amount != null ? String(q.amount) : null),
      q.asset || null,
      a.nonce || null,
      q.payTo || null,
      mismatch,
      mesesDespues(cuando, (env && env.ANSWER_RETENTION_MONTHS) || "12")
    ).run();

    return { check_id: checkId, status: estadoFinal, mismatch };
  } catch (_) {
    return null;                                   // nunca rompe una consulta
  }
}

/** La liquidacion de una respuesta concreta. El camino directo por check_id. */
export async function liquidacionDe(env, checkId) {
  try {
    if (!env || !env.DB || !checkId) return null;
    return await env.DB
      .prepare("SELECT * FROM settlement_log WHERE check_id = ?")
      .bind(checkId).first();
  } catch (_) { return null; }
}

/**
 * Lo que hay que conciliar mirando la cadena. `pending` y `unconfirmed` son
 * estados de "no lo se", no de fallo, y por eso salen juntos.
 */
export async function liquidacionesSinConfirmar(env, limit = 100) {
  try {
    if (!env || !env.DB) return [];
    const r = await env.DB.prepare(
      "SELECT check_id, settled_at, status, transaction_hash, network, payer, " +
      "amount_atomic, mismatch FROM settlement_log " +
      "WHERE status IN ('pending','unconfirmed') ORDER BY settled_at DESC LIMIT ?"
    ).bind(Number(limit) || 100).all();
    return (r && r.results) || [];
  } catch (_) { return []; }
}

/** Barrido de retencion. Prometer 12 meses y no barrer es peor que no prometerlo. */
export async function purgarLiquidacionesCaducadas(env, ahora = nowISO()) {
  const r = await env.DB
    .prepare("DELETE FROM settlement_log WHERE retention_until IS NOT NULL AND retention_until < ?")
    .bind(ahora).run();
  return { rows_affected: (r.meta && r.meta.changes) || 0 };
}
