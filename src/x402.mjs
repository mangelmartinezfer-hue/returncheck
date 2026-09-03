// W28 — x402: EL RETO DE PAGO Y SUS SOBRES.
//
// QUÉ ES ESTO. x402 usa un código HTTP que llevaba treinta años reservado y sin
// usar: el 402 Payment Required. Un agente pide un recurso, el servidor contesta
// «402, esto cuesta X, páguese aquí», el agente firma una autorización de pago y
// repite la petición. Sin registro, sin tarjeta, sin cuenta previa.
//
// Para nosotros no es una forma más de cobrar: es la ÚNICA por la que un agente
// autónomo puede pagarnos sin que haya una persona detrás dándose de alta. Y es
// el requisito para estar en el Bazaar, que es donde los agentes buscan servicios.
//
// LO QUE ESTE MÓDULO HACE Y LO QUE NO:
//
//   SÍ · Construir el reto 402 con los requisitos de pago exactos.
//   SÍ · Meter y sacar los sobres base64 de las tres cabeceras del protocolo.
//   SÍ · Comprobar que lo que el cliente dice haber aceptado es DE VERDAD lo que
//        nosotros pedimos. Esto es seguridad nuestra y no se delega.
//   NO · Hablar con el facilitador. Eso es la siguiente pieza.
//   NO · Firmar ni mover dinero. Nosotros solo COBRAMOS: hace falta una dirección
//        de recepción, cero fondos. El dinero entra, nunca sale.
//
// TODO ESTO ES PURO Y SIN RED: se puede probar entero sin cartera, sin céntimos y
// sin conexión. Por eso va primero.
//
// LAS TRES CABECERAS (especificación de transporte v2, todas en base64):
//   PAYMENT-REQUIRED   servidor -> cliente   «esto cuesta X, páguese aquí»
//   PAYMENT-SIGNATURE  cliente -> servidor   «aquí va mi autorización firmada»
//   PAYMENT-RESPONSE   servidor -> cliente   «liquidado, esta es la transacción»
//
// APAGADO POR DEFECTO. X402_ENABLED = "false" hasta que haya dirección de cobro y
// el flujo esté probado en la red de pruebas. Mientras, nada de esto se activa y
// el servicio funciona exactamente igual que hoy.

export const X402_VERSION = 2;

// Redes en formato CAIP-2, que es lo que cambió de la v1 a la v2. "base-sepolia"
// ya no vale; ahora es "eip155:84532". Un identificador mal puesto aquí no falla
// ruidosamente: pide dinero en una cadena equivocada.
export const RED = {
  BASE_SEPOLIA: "eip155:84532",
  BASE_MAINNET: "eip155:8453",
};

// USDC tiene 6 decimales. Si esto estuviera mal, cobraríamos mil veces de más o
// de menos sin que nada se queje.
const DECIMALES_USDC = 6;

/**
 * Convierte "0.02" en "20000" SIN pasar por coma flotante.
 *
 * Por qué a mano y no con multiplicación: en JavaScript 0.02 * 1e6 da
 * 20000.000000000004. Redondear tapa este caso y falla en otro. Aquí se mueve la
 * coma sobre la cadena de texto, que es exacto siempre.
 */
export function aUnidadesAtomicas(precio, decimales = DECIMALES_USDC) {
  const t = String(precio == null ? "" : precio).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [entera, fraccion = ""] = t.split(".");
  if (fraccion.length > decimales) return null;          // más precisión de la que existe
  const rellena = (fraccion + "0".repeat(decimales)).slice(0, decimales);
  const junto = (entera + rellena).replace(/^0+(?=\d)/, "");
  return junto === "" ? "0" : junto;
}

// ---------------------------------------------------------------------------
// Sobres base64. Las tres cabeceras viajan así.
// ---------------------------------------------------------------------------

export function meterEnSobre(objeto) {
  const json = JSON.stringify(objeto);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Nunca lanza: una cabecera corrupta la manda un cliente, no es un fallo nuestro. */
export function sacarDelSobre(base64) {
  try {
    if (!base64) return null;
    const bin = atob(String(base64).trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lo que pedimos
// ---------------------------------------------------------------------------

export function x402Activo(env) {
  return String(env && env.X402_ENABLED) === "true";
}

/**
 * Los requisitos de pago. Devuelve null si falta configuración — y eso es a
 * propósito: sin dirección de cobro no se puede anunciar un precio. Antes
 * preferimos no ofrecer el pago que ofrecerlo mal.
 */
export function requisitosDePago(env, { precio = null } = {}) {
  const payTo = (env.X402_PAY_TO || "").trim();
  const asset = (env.X402_ASSET || "").trim();
  const network = (env.X402_NETWORK || "").trim();
  if (!payTo || !asset || !network) return null;
  const amount = aUnidadesAtomicas(precio != null ? precio : (env.PRICE_USD || "0.02"));
  if (!amount || amount === "0") return null;

  return [{
    scheme: "exact",
    network,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds: Number(env.X402_TIMEOUT_SECONDS || "60"),
    // Dominio EIP-712 del token. Va tal cual lo publica el emisor; si no
    // coincide, la firma del comprador no valida y el pago se cae entero.
    extra: {
      name: env.X402_ASSET_NAME || "USDC",
      version: env.X402_ASSET_VERSION || "2",
    },
  }];
}

/**
 * W56 — EL RECURSO QUE SE COBRA, EN UN SOLO SITIO.
 *
 * Sale de aqui y de ningun otro lado: lo usa el reto (`retoDePago`), lo usa el
 * anuncio de /.well-known/x402, y lo usa el sobre que va al facilitador
 * (`validarPagoDecodificado`). Antes habia DOS constructores con la misma
 * descripcion escrita a mano —uno aqui y otro en index.mjs— y esa es
 * exactamente la clase de duplicado que se separa a la primera correccion que
 * solo toca uno. Mismo criterio que en W51 con el sobre de liquidacion: dos
 * representaciones, una sola fuente.
 *
 * `url` es el recurso concreto que se esta pagando: /v1/check por HTTP, /mcp
 * por MCP. Sin ella se cae al de HTTP, que es el que anuncia el .well-known.
 */
export function recursoDePago(env, { url = null } = {}) {
  const base = (env && env.PUBLIC_BASE_URL) || "";
  return {
    url: url || (base ? base + "/v1/check" : "/v1/check"),
    description: "ReturnCheck — can this specific product actually be returned?",
    mimeType: "application/json",
  };
}

export function retoDePago(env, { url, error = "PAYMENT-SIGNATURE header is required", precio = null } = {}) {
  const accepts = requisitosDePago(env, { precio });
  if (!accepts) return null;
  return {
    x402Version: X402_VERSION,
    error,
    resource: recursoDePago(env, { url }),
    accepts,
  };
}

// ---------------------------------------------------------------------------
// Lo que el cliente devuelve, y por qué hay que desconfiar de ello
// ---------------------------------------------------------------------------

/**
 * Comprueba que el bloque `accepted` que manda el cliente coincide con lo que
 * NOSOTROS pedimos.
 *
 * ESTO NO SE DELEGA EN EL FACILITADOR, y es la comprobación más importante del
 * módulo. El facilitador valida que la firma sea buena para lo que dice el sobre;
 * no sabe qué le pedimos nosotros. Un cliente puede mandar una firma perfecta
 * sobre un `accepted` con la cantidad rebajada o con OTRA dirección de cobro. Si
 * no comparamos aquí, la firma valida y el dinero se va a otro sitio.
 *
 * Se comparan los cinco campos que mueven dinero. `maxTimeoutSeconds` y `extra`
 * no se comparan: no cambian a quién ni cuánto se paga.
 */
export function aceptadoCoincide(aceptado, requisitos) {
  if (!aceptado || !Array.isArray(requisitos)) return false;
  const igual = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  return requisitos.some((r) =>
    igual(r.scheme, aceptado.scheme) &&
    igual(r.network, aceptado.network) &&
    // La cantidad se compara como TEXTO: son unidades atómicas y pueden no caber
    // en un número seguro de JavaScript.
    String(r.amount) === String(aceptado.amount) &&
    igual(r.asset, aceptado.asset) &&
    igual(r.payTo, aceptado.payTo)
  );
}

/**
 * Valida el SOBRE de pago, venga de donde venga.
 *
 * W48 — se separa del `Request` a proposito. Sobre HTTP el sobre llega en la
 * cabecera PAYMENT-SIGNATURE; sobre MCP llega como argumento de la herramienta,
 * porque JSON-RPC no tiene cabeceras. Es el MISMO sobre y tiene que pasar por el
 * MISMO verificador: si aqui hubiera dos, la comprobacion de `aceptadoCoincide`
 * —que es la que impide que nos desvien el dinero— acabaria existiendo en una
 * version y faltando en la otra.
 *
 * Devuelve { ok:false, error } o { ok:true, pago }.
 */
export function validarSobreDePago(cabecera, env, { precio = null, url = null } = {}) {
  if (!cabecera) return { ok: false, error: "PAYMENT-SIGNATURE header is required" };

  const pago = sacarDelSobre(cabecera);
  if (!pago) return { ok: false, error: "PAYMENT-SIGNATURE is not valid base64 JSON." };
  return validarPagoDecodificado(pago, env, { precio, url });
}

/**
 * W51 — EL MISMO PARSER, PARA UN PaymentPayload YA DECODIFICADO.
 *
 * Sobre HTTP el pago llega en base64 dentro de una cabecera. Sobre MCP, el
 * estandar del x402 Foundation lo manda como OBJETO en _meta["x402/payment"].
 * Es el mismo contenido por dos vehiculos, asi que tiene que pasar por las
 * mismas comprobaciones — sobre todo por `aceptadoCoincide`, que es la que
 * impide que nos desvien el dinero. Si aqui hubiera dos validadores, esa
 * comprobacion acabaria existiendo en uno y faltando en el otro.
 *
 * `validarSobreDePago` decodifica y llama a esta; quien ya tiene el objeto la
 * llama directamente. Un solo camino de validacion, dos puertas de entrada.
 */
export function validarPagoDecodificado(pago, env, { precio = null, url = null } = {}) {
  if (!pago || typeof pago !== "object" || Array.isArray(pago))
    return { ok: false, error: "Payment payload must be an object." };
  if (Number(pago.x402Version) !== X402_VERSION)
    return { ok: false, error: `Unsupported x402Version: expected ${X402_VERSION}.` };
  if (!pago.accepted || !pago.payload)
    return { ok: false, error: "PAYMENT-SIGNATURE must contain 'accepted' and 'payload'." };

  const requisitos = requisitosDePago(env, { precio });
  if (!requisitos) return { ok: false, error: "Payments are not configured on this server." };
  if (!aceptadoCoincide(pago.accepted, requisitos))
    return { ok: false, error: "The accepted payment terms do not match this server's requirements." };

  // W56 — EL SOBRE SALE CON `resource`, Y NO SE LE PIDE AL COMPRADOR.
  //
  // POR QUE. La especificacion x402 v2 marca `resource` como OPCIONAL dentro del
  // PaymentPayload. Mogami, nuestro facilitador, lo EXIGE: sin el responde
  // `invalid_payload`, que es el mismo mensaje que da una firma falsa. Medido en
  // Base mainnet el 3 sep 2026 con una firma real: la firma recuperaba
  // correctamente al firmante y `transferWithAuthorization` simulado con
  // `eth_call` PASABA contra el contrato USDC, y aun asi Mogami la rechazaba.
  // Con `resource` puesto, `isValid: true` y el pago entro a la primera.
  // Eso costo una tarde de diagnostico, y por eso esta escrito aqui: el sintoma
  // apunta al comprador y la causa esta en nuestro lado.
  //
  // SE ANADE AQUI, DESPUES DE LA FIRMA, y eso no es un detalle de comodidad. Lo
  // firmado es la autorizacion EIP-3009 —quien, cuanto, a quien, hasta cuando,
  // con que nonce—; `resource` va fuera de ella, igual que las extensiones. Si
  // se le pidiera al comprador que lo incluyera ANTES de firmar, cambiaria lo
  // que ve y autoriza en su cartera, y ningun cliente x402 existente lo manda
  // porque la especificacion no lo obliga.
  //
  // SALE DEL MISMO SITIO QUE EL DEL RETO (`recursoDePago`) para que no puedan
  // divergir: si se construyera aparte, el recurso que anunciamos y el que
  // declaramos al cobrar acabarian diciendo cosas distintas.
  //
  // ES ADICION, NO REQUISITO: un sobre que llegue SIN `resource` se acepta
  // exactamente igual que antes —no se rechaza nada nuevo— y se le pone el
  // nuestro al salir. Si el comprador manda uno, el nuestro manda: el recurso es
  // el que nosotros servimos, y una sola fuente vale mas que respetar un valor
  // que no podemos comprobar.
  return { ok: true, pago: { ...pago, resource: recursoDePago(env, { url }) } };
}

/**
 * Lee la cabecera PAYMENT-SIGNATURE y valida su forma.
 * Envoltorio de `validarSobreDePago` para el transporte HTTP: se conserva tal
 * cual estaba porque es lo que usa /v1/check, que esta en produccion cobrando.
 */
export function leerFirmaDePago(request, env, { precio = null, url = null } = {}) {
  // W56 — la url del recurso sale de la peticion misma: es la que se esta
  // cobrando y la que llevo el reto. Si no la hay, `recursoDePago` cae en la de
  // HTTP, que es la que anuncia el .well-known.
  return validarSobreDePago(request.headers.get("PAYMENT-SIGNATURE"), env,
    { precio, url: url || (request && request.url) || null });
}

// ---------------------------------------------------------------------------
// La respuesta de liquidación
// ---------------------------------------------------------------------------

/**
 * El cuerpo de la liquidacion: el `SettlementResponse` de la especificacion,
 * como OBJETO. W51 lo separa del sobre porque ahora hacen falta las dos formas
 * —el objeto para _meta["x402/payment-response"] en MCP, el base64 para la
 * cabecera PAYMENT-RESPONSE en HTTP— y tienen que salir del MISMO sitio. Si se
 * construyeran por separado, transaccion, red y pagador podrian discrepar.
 */
export function cuerpoLiquidacion({ success, transaction = "", network = "", payer = "", errorReason = null }) {
  const cuerpo = { success: !!success, transaction: transaction || "", network: network || "", payer: payer || "" };
  if (!success && errorReason) cuerpo.errorReason = errorReason;
  return cuerpo;
}

export function cabeceraLiquidacion(args) {
  return meterEnSobre(cuerpoLiquidacion(args));
}

/** Quién pagó, para poder registrarlo. Nunca lanza. */
export function pagadorDe(pago) {
  try {
    return (pago && pago.payload && pago.payload.authorization && pago.payload.authorization.from) || null;
  } catch (_) { return null; }
}
