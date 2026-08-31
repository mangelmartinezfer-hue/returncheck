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

export function retoDePago(env, { url, error = "PAYMENT-SIGNATURE header is required", precio = null } = {}) {
  const accepts = requisitosDePago(env, { precio });
  if (!accepts) return null;
  return {
    x402Version: X402_VERSION,
    error,
    resource: {
      url,
      description: "ReturnCheck — can this specific product actually be returned?",
      mimeType: "application/json",
    },
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
export function validarSobreDePago(cabecera, env, { precio = null } = {}) {
  if (!cabecera) return { ok: false, error: "PAYMENT-SIGNATURE header is required" };

  const pago = sacarDelSobre(cabecera);
  if (!pago) return { ok: false, error: "PAYMENT-SIGNATURE is not valid base64 JSON." };
  if (Number(pago.x402Version) !== X402_VERSION)
    return { ok: false, error: `Unsupported x402Version: expected ${X402_VERSION}.` };
  if (!pago.accepted || !pago.payload)
    return { ok: false, error: "PAYMENT-SIGNATURE must contain 'accepted' and 'payload'." };

  const requisitos = requisitosDePago(env, { precio });
  if (!requisitos) return { ok: false, error: "Payments are not configured on this server." };
  if (!aceptadoCoincide(pago.accepted, requisitos))
    return { ok: false, error: "The accepted payment terms do not match this server's requirements." };

  return { ok: true, pago };
}

/**
 * Lee la cabecera PAYMENT-SIGNATURE y valida su forma.
 * Envoltorio de `validarSobreDePago` para el transporte HTTP: se conserva tal
 * cual estaba porque es lo que usa /v1/check, que esta en produccion cobrando.
 */
export function leerFirmaDePago(request, env, { precio = null } = {}) {
  return validarSobreDePago(request.headers.get("PAYMENT-SIGNATURE"), env, { precio });
}

// ---------------------------------------------------------------------------
// La respuesta de liquidación
// ---------------------------------------------------------------------------

export function cabeceraLiquidacion({ success, transaction = "", network = "", payer = "", errorReason = null }) {
  const cuerpo = { success: !!success, transaction: transaction || "", network: network || "", payer: payer || "" };
  if (!success && errorReason) cuerpo.errorReason = errorReason;
  return meterEnSobre(cuerpo);
}

/** Quién pagó, para poder registrarlo. Nunca lanza. */
export function pagadorDe(pago) {
  try {
    return (pago && pago.payload && pago.payload.authorization && pago.payload.authorization.from) || null;
  } catch (_) { return null; }
}
