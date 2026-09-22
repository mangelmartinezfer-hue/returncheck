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
import {
  leerIdentificador,
  huella,
  reclamar as reclamarIdem,
  esperarResultado as esperarIdem,
  prepararLiquidacion,
  completar as completarIdem,
  liberar as liberarIdem,
} from "./idempotencia.mjs";
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
  // 3) PUERTA ATOMICA antes de verificar, de gastar el modelo y de /settle.
  //    Sin identificador no existe una identidad sobre la que excluir carreras.
  const idPago = leerIdentificador(pago);
  if (!idPago) {
    return {
      tipo: "error",
      code: "PAYMENT_IDENTIFIER_REQUIRED",
      message: "A valid payment-identifier extension is required for paid calls.",
      http: 400,
    };
  }
  const h = await huella({ aceptado, metodo: "POST", ruta, cuerpo: peticion });

  const comoResultadoPrevio = (previo) => {
    if (previo && previo.conflicto) return { tipo: "conflicto" };
    if (previo && previo.rechazado)
      return {
        tipo: "reto",
        motivo: "The previous settlement was rejected; this payment identifier cannot be retried automatically.",
      };
    if (previo && previo.repetido)
      return {
        tipo: "repetido",
        cuerpo: previo.cuerpo,
        estado: previo.estado,
        transaccion: previo.transaccion || null,
        estadoLiquidacion: previo.estadoLiquidacion || "replay",
      };
    if (previo && previo.error)
      return {
        tipo: "error",
        code: "PAYMENT_GATE_UNAVAILABLE",
        message: previo.motivo || "Payment gate is not available.",
        http: 503,
      };
    return null;
  };

  let puerta = await reclamarIdem(env, { id: idPago, huella: h });
  let anterior = comoResultadoPrevio(puerta);
  if (anterior) return anterior;

  if (puerta && puerta.enCurso) {
    puerta = await esperarIdem(env, idPago, h);
    anterior = comoResultadoPrevio(puerta);
    if (anterior) return anterior;
    return { tipo: "en_curso" };
  }

  if (!puerta || puerta.propietaria !== true || !puerta.attemptId) {
    return {
      tipo: "error",
      code: "PAYMENT_GATE_UNAVAILABLE",
      message: "Payment gate did not grant an authoritative owner.",
      http: 503,
    };
  }
  const attemptId = puerta.attemptId;

  // 4) Verificar ANTES de trabajar. Falla cerrado.
  const ver = await verificarPago(env, { pago, requisitos: aceptado });
  if (!ver.valido) {
    await liberarIdem(env, { id: idPago, huella: h, attemptId });
    return { tipo: "reto", motivo: "Payment verification failed: " + ver.motivo };
  }

  // 5) El motor. Del pagador solo se guarda su huella, igual que de una clave.
  let resp;
  try { resp = await runCheck(env, { ...peticion, __api_key: ver.pagador || null }); }
  catch (e) {
    await liberarIdem(env, { id: idPago, huella: h, attemptId });
    if (e instanceof EngineError) return { tipo: "error", code: e.code, message: e.message, http: e.http };
    return { tipo: "error", code: "INTERNAL", message: "Unexpected error.", http: 500 };
  }
  const checkId = resp.meta && resp.meta.check_id;
  const cuerpo = JSON.stringify(resp);

  // 6) Liquidar. UNKNOWN no se liquida: la autorizacion caduca sin usarse y no se
  //    mueve un centimo. Decision del 22 de agosto.
  let cabeceraPago = null, coste = 0, transaccion = null, estadoLiquidacion = "not_charged";
  if (veredictoCobrable(resp.verdict, env)) {
    // El resultado queda durable ANTES de enviar /settle. Si el proceso cae en la
    // frontera, un replay puede entregarlo como incierto sin volver a liquidar.
    const preparado = await prepararLiquidacion(env, {
      id: idPago, huella: h, attemptId, cuerpo, estado: 200,
    });
    if (!preparado) {
      // /settle todavia no se ha llamado: si seguimos siendo propietarios, es
      // seguro liberar. Si perdimos la propiedad, attempt_id impide borrar la
      // fila de la nueva propietaria.
      await liberarIdem(env, { id: idPago, huella: h, attemptId });
      return {
        tipo: "error",
        code: "PAYMENT_GATE_UNAVAILABLE",
        message: "The payment result could not be persisted before settlement.",
        http: 503,
      };
    }

    const liq = await liquidarPago(env, { pago, requisitos: aceptado });
    if (!liq.cobrado && !liq.pendiente) {
      // El trabajo esta hecho y lo hemos pagado nosotros. Servir igualmente
      // convertiria "haz que falle la liquidacion" en la forma de tener respuestas
      // gratis.
      await markAnswerCharged(env, checkId, 0, false);
      // /settle YA se invoco. Una respuesta rechazada no demuestra que sea
      // seguro competir otra vez con la misma autorizacion, y un error al
      // guardar este desenlace debe conservar el estado `settling`, nunca abrir
      // una segunda liquidacion.
      await completarIdem(env, {
        id: idPago, huella: h, attemptId, cuerpo, estado: 402,
        transaccion: liq.transaccion || null, estadoLiquidacion: "rejected",
      });
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

  // 7) Cerrar la puerta. Tras /settle un fallo de esta escritura NO invita a
  //    reintentar: el estado `settling` ya contiene el resultado y bloquea una
  //    segunda liquidacion. Para UNKNOWN, que nunca se liquida, sí se exige el
  //    cierre o se libera y se falla.
  const cerrado = await completarIdem(env, {
    id: idPago, huella: h, attemptId, cuerpo, estado: 200,
    transaccion, estadoLiquidacion,
  });
  if (!cerrado && estadoLiquidacion === "not_charged") {
    await liberarIdem(env, { id: idPago, huella: h, attemptId });
    return {
      tipo: "error",
      code: "PAYMENT_GATE_UNAVAILABLE",
      message: "The idempotency result could not be committed.",
      http: 503,
    };
  }

  return { tipo: "ok", resp, cuerpo, coste, transaccion, estadoLiquidacion, cabeceraPago };
}
