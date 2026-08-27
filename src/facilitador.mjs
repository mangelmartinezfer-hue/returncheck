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

// W41 — LIQUIDAR NO TARDA LO MISMO QUE VERIFICAR, y darles el mismo plazo nos
// costó dinero de verdad.
//
// LO QUE PASÓ EL 27 DE AGOSTO, medido: la liquidación tardó más de 8 segundos.
// Nuestro plazo venció, dimos el cobro por fallido, devolvimos un 402 y no
// servimos la respuesta. Mientras tanto la transferencia SÍ se completó en la
// cadena: 0,02 USDC salieron del comprador y llegaron a nuestra cuenta. El
// registro quedó diciendo `charged: 0`. Cobramos, no entregamos, y apuntamos que
// no habíamos cobrado.
//
// Verificar es una consulta y va rápido. Liquidar es una transacción en una
// cadena de bloques y espera confirmaciones. Un solo número para las dos cosas
// era el error.
const TIMEOUT_LIQUIDAR_MS_POR_DEFECTO = 25000;

/**
 * Llamada al facilitador. Aislada para poder probar todo el flujo sin red:
 * `fetchImpl` se inyecta en las pruebas.
 */
async function llamar(env, ruta, cuerpo, { fetchImpl = fetch } = {}) {
  const base = String(env.X402_FACILITATOR || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no_facilitator_configured" };

  const timeout = ruta === "/settle"
    ? Number(env.X402_SETTLE_TIMEOUT_MS || TIMEOUT_LIQUIDAR_MS_POR_DEFECTO)
    : Number(env.X402_TIMEOUT_MS || TIMEOUT_MS_POR_DEFECTO);
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

/**
 * W39 — LAS EXTENSIONES NO SE REENVÍAN AL FACILITADOR.
 *
 * MEDIDO, no supuesto: Mogami devuelve 500 —una página HTML de error, sin
 * mensaje— en cuanto el sobre lleva un bloque `extensions`. Da igual cuál: se
 * probó con `payment-identifier` y con una inventada, y las dos revientan. Sin
 * `extensions`, el MISMO pago devuelve `isValid: true`. Cinco variantes, cinco
 * de cinco. Su `/supported` ya declaraba `extensions: []`; lo que no hace es
 * rechazarlas limpiamente.
 *
 * PERO EL MOTIVO PARA QUITARLAS NO ES ESE FALLO, y conviene no confundirlo: el
 * identificador de pago es NUESTRO. El cliente nos lo manda a nosotros para que
 * no le cobremos dos veces por un reintento; el facilitador no lo necesita ni
 * lo entiende. Reenviárselo era enseñarle papeles de otro. Aunque Mogami lo
 * arregle mañana, esto se queda.
 *
 * NO ROMPE LA FIRMA: lo firmado es la autorización EIP-3009 —quién, cuánto, a
 * quién, hasta cuándo, con qué nonce—. Las extensiones se añaden DESPUÉS de
 * firmar, así que quitarlas no toca nada de lo que el facilitador verifica.
 *
 * Y NO SE PIERDE LA IDEMPOTENCIA: el identificador ya se leyó antes, en
 * index.mjs, sobre el sobre original. Esto solo afecta a la copia que sale
 * hacia el facilitador.
 *
 * El interruptor existe por si algún día usamos un facilitador que SÍ necesite
 * una extensión suya (por ejemplo, patrocinio de gas). Hasta entonces, no.
 */
export function limpiarParaFacilitador(pago, env = {}) {
  if (String(env.X402_ENVIAR_EXTENSIONES) === "true") return pago;
  if (!pago || !pago.payload || pago.payload.extensions === undefined) return pago;
  // Copia: el sobre original NO se toca, que es de donde sale la idempotencia.
  const { extensions, ...restoDelPayload } = pago.payload;
  return { ...pago, payload: restoDelPayload };
}

function cuerpoFacilitador(pago, requisitos, env = {}) {
  return { x402Version: 2, paymentPayload: limpiarParaFacilitador(pago, env), paymentRequirements: requisitos };
}

/**
 * ¿Es real este pago? Se llama ANTES de trabajar.
 *
 * FALLA CERRADO: cualquier cosa que no sea un `isValid: true` explícito devuelve
 * válido = false. No hay beneficio de la duda.
 */
export async function verificarPago(env, { pago, requisitos }, opciones = {}) {
  const r = await llamar(env, "/verify", cuerpoFacilitador(pago, requisitos, env), opciones);
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
  const r = await llamar(env, "/settle", cuerpoFacilitador(pago, requisitos, env), opciones);
  if (!r.ok) {
    // W41 — AQUÍ ESTABA EL FALLO QUE COSTÓ DINERO. Antes, cualquier error se
    // trataba como «no se cobró». Pero en una liquidación no es lo mismo saber
    // que el dinero NO se movió que no saber qué ha pasado:
    //
    //   NO SALIÓ   `unreachable`, sin facilitador configurado -> la petición no
    //              llegó a irse. El dinero no se movió. Es un fallo de verdad.
    //
    //   NO SÉ      un plazo vencido o un error del servidor -> la petición SÍ
    //              salió. El facilitador puede haber ejecutado la transferencia
    //              y habérsenos perdido la respuesta. Es exactamente lo que pasó
    //              el 27 de agosto: 0,02 USDC llegaron a nuestra cuenta mientras
    //              nosotros dábamos el cobro por fallido.
    //
    // Y ante la duda se sirve, decisión de Miguel: cobrar sin entregar es mucho
    // peor que entregar sin cobrar. Lo primero rompe la confianza del cliente y
    // se publica; lo segundo cuesta céntimos.
    //
    // ESTO NO ABRE LA PUERTA A RESPUESTAS GRATIS, y conviene ver por qué: para
    // llegar aquí hay que haber pasado antes por `verificarPago`, que sigue
    // fallando cerrado. Un facilitador caído no llega nunca a la liquidación
    // porque la verificación lo para antes, con el motor sin gastar.
    const noSalio = r.error === "facilitator_unreachable" || r.error === "no_facilitator_configured";
    if (noSalio)
      return { cobrado: false, pendiente: false, transaccion: "", red: "", pagador: null, motivo: r.error };
    return { cobrado: false, pendiente: true, incierto: true, transaccion: "", red: "",
             pagador: null, motivo: "settlement_unconfirmed_" + r.error };
  }

  const d = r.datos;
  const red = d.network || (requisitos && requisitos.network) || "";
  const pagador = d.payer || null;

  if (d.success === true)
    return { cobrado: true, pendiente: false, transaccion: d.transaction || "", red, pagador, motivo: null };

  // La cadena aun no ha confirmado, pero la transaccion esta lanzada y tiene hash.
  // El comprador ha pagado; la lentitud de la red no es culpa suya.
  if (d.errorReason === "settlement_pending" && d.transaction)
    return { cobrado: false, pendiente: true, transaccion: d.transaction, red, pagador, motivo: "settlement_pending" };

  // W41 — «pendiente» SIN hash tampoco es un fallo: es otra forma de no saber.
  // Antes lo tratábamos como fallo («un fallo con nombre bonito»), y esa lectura
  // era coherente con la regla vieja. Con la regla nueva no lo es: si el
  // facilitador dice que está en curso, puede estarlo de verdad aunque no nos
  // haya dado el hash todavía. Se sirve y se marca para conciliar.
  if (d.errorReason === "settlement_pending")
    return { cobrado: false, pendiente: true, incierto: true, transaccion: "", red, pagador,
             motivo: "settlement_pending_sin_hash" };

  // Un motivo de negocio explícito SÍ es un fallo de verdad: el facilitador nos
  // ha contestado y nos ha dicho que no. Ahí sabemos que el dinero no se movió.
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
