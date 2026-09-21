// W48 — UN SOLO CAMINO DE COBRO.
//
// POR QUE EXISTE ESTE MODULO. El cobro con x402 estaba entero, funcionando y
// cobrando, pero vivia dentro de `handleCheckX402` en index.mjs, pegado a un
// `Request` y a una `Response`. Para que el MCP pudiera cobrar habia dos
// opciones: escribir un segundo cobro al lado, o sacar el que ya funciona a un
// sitio donde los dos transportes puedan llamarlo.
//
// Se ha hecho lo segundo, y no por elegancia. Dos implementaciones de cobro
// divergen: alguien arregla un fallo de liquidacion en la que se usa mucho y la
// otra se queda con el fallo puesto, cobrando mal en silencio durante semanas
// porque nadie la mira. Con una sola, un arreglo llega a los dos caminos o no
// llega a ninguno, y eso se nota el mismo dia.
//
// LO QUE ESTE MODULO NO HACE: no lee cuerpos, no construye respuestas HTTP y no
// sabe que existe JSON-RPC. Recibe un pago ya validado y una peticion ya validada,
// y devuelve un RESULTADO NEUTRO que cada transporte pinta a su manera. La
// frontera esta puesta ahi a proposito: es justo donde HTTP y MCP dejan de
// parecerse.

import { runCheck, EngineError } from "./engine.mjs";
import { retoDePago, cabeceraLiquidacion } from "./x402.mjs";
import { verificarPago, liquidarPago, veredictoCobrable } from "./facilitador.mjs";
import { leerIdentificador, huella, reclamar, liberar, finalizar } from "./idempotencia.mjs";
import { markAnswerCharged } from "./answerlog.mjs";

/**
 * La puerta humana del 402.
 *
 * EL PROBLEMA QUE ARREGLA. Al encender x402 le abrimos la puerta al agente y, sin
 * darnos cuenta, se la cerramos a la persona. El 402 pasó a decir solo «Free trial
 * exhausted. Payment required.» y un objeto `accepts` que un desarrollador no sabe
 * usar — mientras que el camino que SÍ puede usar (darse de alta y llevarse crédito
 * gratis) dejó de mencionarse. Existía, estaba pagado, y no se veía.
 *
 * Un 402 que no dice cómo seguir es un callejón sin salida con otro número.
 *
 * W48 — se mueve aqui desde index.mjs, sin tocar una linea de su contenido,
 * porque ahora la necesitan los dos transportes y mcp.mjs no puede importar de
 * index.mjs (index.mjs ya importa de mcp.mjs; el ciclo lo pagariamos en el
 * arranque del Worker).
 */
export function puertaHumana(env) {
  const base = env.PUBLIC_BASE_URL || "";
  const precio = Number(env.PRICE_USD || "0.02");
  const credito = Number(env.SIGNUP_FREE_CREDIT_USD || "2.00");
  const porIp = Number(env.FREE_IP_DAILY || "3");
  const salida = {
    message:
      "If you are a human developer: the keyless free trial is " + porIp +
      " calls per IP per day and it resets daily. For more, sign up — it comes with free credit.",
    free_trial: { calls_per_ip_per_day: porIp, resets: "daily (UTC)" },
    signup: {
      url: base ? base + "/v1/signup" : "/v1/signup",
      method: "POST",
      body: { email: "you@example.com" },
      free_credit_usd: credito,
      approx_free_calls: precio > 0 ? Math.floor(credito / precio) : null,
    },
    price_usd_per_call: precio,
    unknown_is_free: true,
  };
  // HONESTIDAD SOBRE LA RED. Mientras x402 apunte a una red de pruebas, el `accepts`
  // pide una moneda que no vale dinero. Un agente lo deduce del identificador de
  // red; una persona, no. Se dice.
  const red = String(env.X402_NETWORK || "");
  if (red === "eip155:84532" || /sepolia|testnet/i.test(red)) {
    salida.x402_note =
      "x402 payment is currently configured on a TEST network (" + red +
      "), so it cannot move real money. For real payment use the signup path above.";
  }
  return salida;
}

/**
 * El reto de pago y su cuerpo, sin transporte.
 *
 * Devuelve { reto, cuerpo } o `null` si falta configuracion — y ese null es la
 * regla de `retoDePago`, no un descuido: SIN DIRECCION DE COBRO NO SE ANUNCIA
 * PRECIO. Quien llame decide a que se cae (el 402 educado en HTTP, el mensaje de
 * alta por correo en MCP).
 *
 * `reto` es lo que viaja en el sobre PAYMENT-REQUIRED: contrato con el agente y
 * con el facilitador, y ahi no se mete nada que ellos no esperen. `cuerpo` lleva
 * ademas la puerta humana, que es inofensiva para quien no la mira. Los dos
 * transportes usan esta funcion para que el reto del MCP y el del HTTP digan
 * exactamente lo mismo.
 */
export function retoConPuertaHumana(env, { url, motivo, precio = null } = {}) {
  const reto = retoDePago(env, { url, error: motivo, precio });
  if (!reto) return null;
  return { reto, cuerpo: { ...reto, human_next_steps: puertaHumana(env) } };
}

/**
 * El cobro. Pasos 3 a 7 del camino x402, identicos a los que /v1/check lleva
 * ejecutando desde W32.
 *
 * Entra: un `pago` YA validado (sobre bien formado y terminos que coinciden con
 * los nuestros) y una `peticion` YA validada contra el contrato. Sale un objeto
 * con `tipo`:
 *
 *   "conflicto" · el mismo identificador de pago para otra peticion distinta
 *   "repetido"  · reintento: se devuelve lo guardado y NO se vuelve a cobrar
 *   "reto"      · hay que volver a pedir pago (verificacion o liquidacion caida)
 *   "error"     · fallo del motor; no se ha cobrado
 *   "ok"        · respuesta servida, con su estado de liquidacion
 *
 * `ruta` entra como parametro porque forma parte de la huella de idempotencia.
 * Consecuencia buscada: el mismo identificador de pago usado en /v1/check y en
 * /mcp da huellas distintas y por tanto "conflicto", no "repetido". Es el lado
 * seguro — se niega a servir antes que arriesgarse a cobrar dos veces.
 */
export async function cobrarConX402(env, { pago, aceptado, peticion, ruta, precio }) {
  // 3) LA PUERTA. PR-2 — BLQ-X402-GATE-01.
  //
  //    Antes esto era una LECTURA, y la escritura venía al final, DESPUES de
  //    /settle. Entre una y otra no había nada atómico: dos peticiones con el
  //    mismo identificador pasaban las dos, gastaban el motor las dos y
  //    liquidaban LAS DOS. Ahora se reclama primero, y el permiso lo da el
  //    numero de filas que devuelve el motor. Sin ese permiso no se sigue.
  const idPago = leerIdentificador(pago);
  let h = null;
  if (idPago) {
    h = await huella({ aceptado, metodo: "POST", ruta, cuerpo: peticion });
    const puerta = await reclamar(env, { id: idPago, huella: h });

    if (puerta.conflicto) return { tipo: "conflicto" };
    if (puerta.repetido)
      return {
        tipo: "repetido",
        cuerpo: puerta.cuerpo,
        estado: puerta.estado,
        transaccion: puerta.transaccion || null,
      };
    if (puerta.enCurso) return { tipo: "en_curso" };

    //  Sin puerta no se liquida. Aquí se falla cerrado a propósito, y es lo
    //  contrario de lo que hace `consultar`: allí perder la idempotencia solo
    //  cuesta la protección, aquí cuesta cobrar dos veces. El cliente recibe un
    //  402 y reintenta; no se ha movido un céntimo.
    if (!puerta.dueno)
      return { tipo: "reto", motivo: "Idempotency gate unavailable, nothing was charged: " + (puerta.motivo || "unknown") };
  }

  // A partir de aquí la reclamación es NUESTRA. Se suelta solo cuando consta que
  // el dinero no se movió; ante la duda se queda puesta y caduca sola.
  const soltar = async () => { if (idPago) await liberar(env, idPago); };

  // 4) Verificar ANTES de trabajar. Falla cerrado.
  const ver = await verificarPago(env, { pago, requisitos: aceptado });
  if (!ver.valido) {
    await soltar();
    return { tipo: "reto", motivo: "Payment verification failed: " + ver.motivo };
  }

  // 5) El motor. Del pagador solo se guarda su huella, igual que de una clave.
  let resp;
  try { resp = await runCheck(env, { ...peticion, __api_key: ver.pagador || null }); }
  catch (e) {
    await soltar();
    if (e instanceof EngineError) return { tipo: "error", code: e.code, message: e.message, http: e.http };
    return { tipo: "error", code: "INTERNAL", message: "Unexpected error.", http: 500 };
  }
  const checkId = resp.meta && resp.meta.check_id;

  // 6) Liquidar. UNKNOWN no se liquida: la autorizacion caduca sin usarse y no se
  //    mueve un centimo. Decision del 22 de agosto.
  let cabeceraPago = null, coste = 0, transaccion = null, estadoLiquidacion = "not_charged";
  if (veredictoCobrable(resp.verdict, env)) {
    const liq = await liquidarPago(env, { pago, requisitos: aceptado });
    if (!liq.cobrado && !liq.pendiente) {
      // El trabajo esta hecho y lo hemos pagado nosotros. Servir igualmente
      // convertiria "haz que falle la liquidacion" en la forma de tener respuestas
      // gratis.
      await markAnswerCharged(env, checkId, 0, false);
      // `!cobrado && !pendiente` es el caso NO SALIO de W41: facilitador
      // inalcanzable o sin configurar, la peticion no llego a irse. Consta que
      // el dinero no se movio, asi que la reclamacion se suelta y el cliente
      // puede reintentar. El caso "no se" —pendiente o incierto— no pasa por
      // aqui, y ahi la reclamacion se queda puesta.
      await soltar();
      return { tipo: "reto", motivo: "Payment settlement failed: " + liq.motivo };
    }
    transaccion = liq.transaccion || null;
    coste = Number(precio);
    cabeceraPago = cabeceraLiquidacion({
      success: liq.cobrado, transaction: liq.transaccion, network: liq.red,
      payer: liq.pagador, errorReason: liq.pendiente ? (liq.incierto ? "settlement_unconfirmed" : "settlement_pending") : null });
    // W41 — TRES ESTADOS, no dos. Solo se marca cobrado lo CONFIRMADO; lo que
    // está en vuelo o sin confirmar se deja en `null`, que es la verdad, y
    // aparece en la lista de conciliación.
    await markAnswerCharged(env, checkId, coste, liq.cobrado ? true : null);
    estadoLiquidacion = liq.cobrado ? "confirmed" : (liq.incierto ? "unconfirmed" : "pending");
  } else {
    await markAnswerCharged(env, checkId, 0, false);
    cabeceraPago = cabeceraLiquidacion({
      success: false, errorReason: "not_settled_unknown_verdict",
      network: aceptado.network, payer: ver.pagador });
  }

  // 7) Cerrar la reclamacion con la respuesta servida. Ya no es un
  //    `INSERT OR REPLACE` que siempre gana: es un UPDATE sobre NUESTRA fila,
  //    que solo entra si la reclamacion del paso 3 sigue siendo nuestra.
  const cuerpo = JSON.stringify(resp);
  if (idPago && h) await finalizar(env, { id: idPago, cuerpo, estado: 200, transaccion });

  return { tipo: "ok", resp, cuerpo, coste, transaccion, estadoLiquidacion, cabeceraPago };
}
