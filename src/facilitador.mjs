// W30 — EL FACILITADOR: quien nos dice si el pago es de verdad.
//
// QUIÉN ES Y POR QUÉ EXISTE. Nosotros no sabemos leer una cadena de bloques, y no
// nos hace falta. El comprador firma una autorización de pago; el facilitador la
// comprueba contra la cadena y nos dice sí o no. Después la ejecuta. Nosotros solo
// preguntamos y cobramos.
//
// EL ORDEN LO MANDA LA ESPECIFICACIÓN, y no es caprichoso:
//
//     verificar  ->  hacer el trabajo  ->  liquidar
//
// Verificar antes de trabajar evita regalar respuestas. Liquidar después evita
// cobrar por algo que no llegamos a entregar. En medio va nuestro motor.
//
// TRES DECISIONES QUE HAY QUE ENTENDER, porque son de negocio y no de código:
//
//  1. VERIFICAR FALLA CERRADO. Si el facilitador no contesta, tarda demasiado o
//     devuelve algo raro, NO servimos la respuesta. Un error de red no puede
//     convertirse en una consulta gratis: si pudiera, bastaría con tumbar al
//     facilitador para cobrar cero.
//
//  2. UNKNOWN NO SE LIQUIDA. Decisión de Miguel del 22 de agosto: si no sabemos,
//     no cobramos. Con x402 sale redondo — el comprador ya firmó la autorización,
//     pero si el veredicto es UNKNOWN simplemente NO llamamos a liquidar y esa
//     firma caduca sin usarse. No hay que devolver nada porque no se movió nada.
//     Es más limpio que con tarjeta, donde habría que emitir un reembolso.
//
//  3. SI LA LIQUIDACIÓN FALLA, NO SE SIRVE. Duele, porque el trabajo ya está hecho
//     y pagado por nosotros. Pero servir igualmente convierte «hacer que falle la
//     liquidación» en la forma de tener respuestas gratis. Se pierde el coste del
//     modelo una vez; la alternativa es perderlo siempre.
//
//     La excepción es `settlement_pending`: la transacción está lanzada y la
//     cadena aún no ha confirmado. Ahí SÍ se sirve. El comprador ha pagado y la
//     lentitud de la red no es culpa suya; dejarle sin respuesta por eso sería
//     castigar al cliente por un problema nuestro. Queda anotado como pendiente
//     para conciliarlo después.
//
// NUNCA se manda una clave a este módulo. El facilitador no necesita credenciales
// nuestras para los que hemos elegido, y nosotros no firmamos nada: solo cobramos.

const TIMEOUT_MS_POR_DEFECTO = 8000;

/**
 * Llamada al facilitador. Aislada para poder probar todo el flujo sin red:
 * `fetchImpl` se inyecta en las pruebas.
 */
async function llamar(env, ruta, cuerpo, { fetchImpl = fetch } = {}) {
  const base = String(env.X402_FACILITATOR || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no_facilitator_configured" };

  const timeout = Number(env.X402_TIMEOUT_MS || TIMEOUT_MS_POR_DEFECTO);
  try {
    const r = await fetchImpl(base + ruta, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
      // Sin esto, un facilitador colgado cuelga nuestra petición entera y el
      // cliente se queda esperando por algo que no depende de nosotros.
      signal: AbortSignal.timeout(timeout),
    });
    // Un 500 del facilitador no es una respuesta valida: es una ausencia de
    // respuesta con otra cara.
    if (!r.ok) return { ok: false, error: `facilitator_http_${r.status}` };
    const datos = await r.json();
    if (!datos || typeof datos !== "object") return { ok: false, error: "facilitator_bad_json" };
    return { ok: true, datos };
  } catch (e) {
    const nombre = (e && e.name) || "";
    return { ok: false, error: nombre === "TimeoutError" || nombre === "AbortError"
      ? "facilitator_timeout" : "facilitator_unreachable" };
  }
}

function cuerpoFacilitador(pago, requisitos) {
  return { x402Version: 2, paymentPayload: pago, paymentRequirements: requisitos };
}

/**
 * ¿Es real este pago? Se llama ANTES de trabajar.
 *
 * FALLA CERRADO: cualquier cosa que no sea un `isValid: true` explícito devuelve
 * válido = false. No hay beneficio de la duda.
 */
export async function verificarPago(env, { pago, requisitos }, opciones = {}) {
  const r = await llamar(env, "/verify", cuerpoFacilitador(pago, requisitos), opciones);
  if (!r.ok) return { valido: false, motivo: r.error, pagador: null };

  const d = r.datos;
  if (d.isValid !== true)
    return { valido: false, motivo: d.invalidReason || "invalid_payment", pagador: d.payer || null };
  return { valido: true, motivo: null, pagador: d.payer || null };
}

/**
 * Ejecuta el cobro. Se llama DESPUÉS de tener la respuesta, y SOLO si el veredicto
 * es cobrable — un UNKNOWN nunca llega aquí.
 *
 * Devuelve { cobrado, pendiente, transaccion, red, pagador, motivo }.
 * `pendiente` significa: transacción lanzada, cadena sin confirmar todavía. Se
 * sirve la respuesta igual y se anota para conciliar.
 */
export async function liquidarPago(env, { pago, requisitos }, opciones = {}) {
  const r = await llamar(env, "/settle", cuerpoFacilitador(pago, requisitos), opciones);
  if (!r.ok) return { cobrado: false, pendiente: false, transaccion: "", red: "", pagador: null, motivo: r.error };

  const d = r.datos;
  const red = d.network || (requisitos && requisitos.network) || "";
  const pagador = d.payer || null;

  if (d.success === true)
    return { cobrado: true, pendiente: false, transaccion: d.transaction || "", red, pagador, motivo: null };

  // La cadena aun no ha confirmado, pero la transaccion esta lanzada y tiene hash.
  // El comprador ha pagado; la lentitud de la red no es culpa suya.
  if (d.errorReason === "settlement_pending" && d.transaction)
    return { cobrado: false, pendiente: true, transaccion: d.transaction, red, pagador, motivo: "settlement_pending" };

  return { cobrado: false, pendiente: false, transaccion: d.transaction || "", red, pagador,
           motivo: d.errorReason || "settlement_failed" };
}

/**
 * ¿Se cobra este veredicto?
 *
 * Es la decisión del 22 de agosto expresada en una línea, y vive aquí para que no
 * se pueda cobrar un UNKNOWN por descuido en algún camino nuevo del motor.
 */
export function veredictoCobrable(veredicto, env = {}) {
  if (String(env.CHARGE_ON_UNKNOWN) === "true") return true;
  return veredicto !== "UNKNOWN";
}
