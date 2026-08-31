// W51 — EL PAGO ESTANDAR DE MCP: _meta["x402/payment"].
//
// EL PROBLEMA QUE CIERRA. En W48 inventamos un argumento, `payment_signature`,
// porque JSON-RPC no tiene cabeceras. Funciona, pero NO es el estandar: la
// especificacion de transporte del x402 Foundation manda el PaymentPayload como
// OBJETO en _meta["x402/payment"] y devuelve la liquidacion en
// _meta["x402/payment-response"]. Un cliente x402 de MCP normal habla asi, y
// nosotros lo habriamos ignorado — la llamada habria caido al tramo gratis o al
// reto, y una prueba pagada no habria ocurrido nunca.
//
// LO QUE VIGILAN ESTAS PRUEBAS, por orden de lo que puede costar dinero:
//   · que si llegan los DOS vehiculos con pagos DISTINTOS se rechace, en vez de
//     elegir uno en silencio. Servir uno seria decidir por el cliente a que esta
//     autorizando;
//   · que si llegan los dos con el MISMO pago se siga, aunque el orden de las
//     claves o la serializacion difieran, porque eso no es una discrepancia;
//   · que las dos representaciones de la liquidacion —_meta y
//     structuredContent.x402— no puedan discrepar, porque salen del mismo sobre;
//   · y que nada de esto haya creado una apariencia de pago donde no lo hay.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { meterEnSobre, sacarDelSobre } from "../src/x402.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RED    = "eip155:8453";
const TX     = "0xdeadbeefcafe0000000000000000000000000000000000000000000000000002";
const PAYER  = "0x857bEEF0000000000000000000000000000000aa";

const POLIZA = "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories.";

const PETICION = {
  product_url: "https://eval.example/p/RC25-01",
  buyer_country: "US", item_condition: "unopened", reason: "changed_mind",
  purchase_date: "2026-08-01", delivery_date: "2026-08-05", as_of: "2026-08-20",
  page_text: POLIZA,
};

function ia(verdict) {
  const det = verdict !== "UNKNOWN";
  return { run: async () => ({ response: JSON.stringify({
    verdict, confidence: 0.9,
    answer_human: det ? "Yes. Within the 30-day window." : "Unknown.",
    reason: det ? null : "The policy text does not resolve this case.",
    merchant_resolved: { name: "eval.example", domain: "eval.example", is_marketplace_third_party: false },
    policy: det ? { return_category: "MerchantReturnFiniteReturnWindow", merchant_return_days: 30,
                    window_basis: "delivery_date", return_method: [], return_fees: null, refund_type: null } : null,
    evidence: det ? { source_url: PETICION.product_url, clause_id: null,
                      exact_clause: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery." } : null,
  }) }) };
}

function db({ idemFila = null } = {}) {
  const g = { run: async () => ({ meta: { changes: 0 } }), first: async () => null, all: async () => ({ results: [] }) };
  return { prepare: (sql) => ({
    bind: () => ({ ...g, first: async () => (idemFila && /FROM payment_idempotency/.test(sql)) ? idemFila : null }),
    ...g }) };
}

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example", PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00", FREE_IP_DAILY: "3", ANSWER_LOG: "false",
  X402_ENABLED: "true", X402_NETWORK: RED, X402_PAY_TO: PAY_TO, X402_ASSET: ASSET,
  X402_FACILITATOR: "https://facilitador.example", FREE_TRIAL_ENABLED: "false",
};

const ACEPTADO = { scheme: "exact", network: RED, amount: "20000", asset: ASSET, payTo: PAY_TO };

// Una autorizacion con varios campos, para que reordenar POR DENTRO signifique algo.
const AUTORIZACION = { from: PAYER, to: PAY_TO, value: "20000",
                       validAfter: "0", validBefore: "1893456000", nonce: "0xabc123" };

// El PaymentPayload estandar, como objeto.
function pagoObjeto({ amount = "20000", id = null } = {}) {
  const payload = { signature: "0xsig", authorization: { ...AUTORIZACION } };
  if (id) payload.extensions = { "payment-identifier": id };
  return { x402Version: 2, accepted: { ...ACEPTADO, amount }, payload };
}

/**
 * EL MISMO pago, con TODAS las claves insertadas al reves: las de fuera, las de
 * `accepted`, las de `payload` y las de `payload.authorization`. Si la
 * comparacion no fuera recursiva, esto se leeria como un pago distinto y
 * rechazariamos a un cliente que no ha hecho nada malo.
 */
function pagoObjetoOrdenInverso({ amount = "20000", id = null } = {}) {
  const auth = {};
  for (const k of Object.keys(AUTORIZACION).reverse()) auth[k] = AUTORIZACION[k];
  const aceptado = { ...ACEPTADO, amount };
  const acc = {};
  for (const k of Object.keys(aceptado).reverse()) acc[k] = aceptado[k];
  const payload = {};
  if (id) payload.extensions = { "payment-identifier": id };
  payload.authorization = auth;
  payload.signature = "0xsig";
  return { payload, accepted: acc, x402Version: 2 };
}

// llamada con _meta, con argumento, o con los dos
async function llamar(env, { meta = null, arg = null, args = {} } = {}) {
  const params = { name: "check_return", arguments: { ...PETICION, ...args } };
  if (arg) params.arguments.payment_signature = arg;
  if (meta) params._meta = { "x402/payment": meta };
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  }), env);
  return (await r.json()).result;
}

function conFacilitador({ verifica = true, liquida = true, settle = null, settleCae = false }, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/verify"))
      return { ok: true, status: 200,
               json: async () => ({ isValid: verifica, payer: PAYER,
                                    invalidReason: verifica ? null : "bad_signature" }) };
    // /settle: puede no contestar (estado "unconfirmed") o contestar lo que se le diga.
    if (settleCae) return { ok: false, status: 504, json: async () => ({}) };
    return { ok: true, status: 200,
             json: async () => settle || { success: liquida, transaction: TX, network: RED, payer: PAYER } };
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------
// 1-2. Los dos vehiculos, cada uno por su cuenta
// ---------------------------------------------------------------------------

test("W51 EL ESTANDAR: se paga con _meta['x402/payment'] y se liquida", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(res.isError, false);
  assert.equal(res.structuredContent.x402.transaction, TX);
  assert.equal(res.structuredContent.x402.settlement, "confirmed");
});

test("W51 COMPATIBILIDAD: el argumento payment_signature sigue funcionando", async () => {
  // Es lo que publicamos en el hilo de Slack. No se rompe a quien ya lo use.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { arg: meterEnSobre(pagoObjeto()) }));
  assert.equal(res.isError, false);
  assert.equal(res.structuredContent.x402.transaction, TX);
});

// ---------------------------------------------------------------------------
// 3-4. Los dos a la vez
// ---------------------------------------------------------------------------

test("W51: los dos vehiculos con el MISMO pago se aceptan, aunque difiera el orden", async () => {
  // El cliente que manda las dos formas no esta haciendo nada malo. Solo se
  // rechaza si dicen cosas distintas, y el orden de las claves no lo es.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, {
    meta: pagoObjetoOrdenInverso(),
    arg: meterEnSobre(pagoObjeto()),
  }));
  assert.equal(res.isError, false, "mismo pago escrito de dos maneras no es ambiguedad");
  assert.equal(res.structuredContent.x402.transaction, TX);
});

test("W51: el orden invertido llega hasta authorization, y sigue sin ser ambiguedad", async () => {
  // Comprobacion explicita de que la canonicalizacion es RECURSIVA: se reordenan
  // las claves de fuera, las de accepted, las de payload y las de authorization.
  const a = pagoObjeto({ id: "identificador-de-prueba-1" });
  const b = pagoObjetoOrdenInverso({ id: "identificador-de-prueba-1" });
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), "las dos serializaciones son distintas");
  assert.notEqual(Object.keys(a.payload.authorization).join(),
                  Object.keys(b.payload.authorization).join(), "y el orden interno tambien");
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: b, arg: meterEnSobre(a) }));
  assert.equal(res.isError, false);
  assert.equal(res.structuredContent.x402.transaction, TX);
});

// ---------------------------------------------------------------------------
// 4b. UNO VALIDO Y OTRO INVALIDO: el invalido NO se ignora
// ---------------------------------------------------------------------------

test("W51: argumento VALIDO y _meta INVALIDO -> rechazo, no se usa el valido", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, {
    meta: pagoObjeto({ amount: "1" }),          // invalido: cantidad rebajada
    arg: meterEnSobre(pagoObjeto()),            // valido
  }));
  assert.equal(res.isError, true, "no se sirve nada");
  assert.equal(res.structuredContent.verdict, undefined, "y desde luego no el veredicto");
  assert.equal(res.structuredContent.x402, undefined);
  assert.equal(res._meta, undefined, "ni la menor apariencia de liquidacion");
});

test("W51: _meta VALIDO y argumento INVALIDO -> rechazo, no se usa el valido", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, {
    meta: pagoObjeto(),                                   // valido
    arg: meterEnSobre(pagoObjeto({ amount: "1" })),       // invalido
  }));
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.verdict, undefined);
  assert.equal(res.structuredContent.x402, undefined);
  assert.equal(res._meta, undefined);
});

test("W51: el error de ambiguedad NO filtra firma, autorizacion ni el canonico", async () => {
  // Un mensaje de error que devuelve el sobre convierte un fallo del cliente en
  // una fuga. Aqui solo puede salir texto fijo.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, {
    meta: pagoObjeto({ id: "identificador-numero-uno" }),
    arg: meterEnSobre(pagoObjeto({ id: "identificador-numero-dos" })),
  }));
  const todo = JSON.stringify(res);
  for (const secreto of ["0xsig", PAYER, "identificador-numero-uno", "identificador-numero-dos",
                         "0xabc123", "x402Version", "authorization"]) {
    assert.equal(todo.includes(secreto), false, `no puede salir ${secreto}`);
  }
});

test("W51 LO QUE PROTEGE EL DINERO: dos pagos DISTINTOS se rechazan por ambiguos", async () => {
  // Aqui no se elige uno en silencio. Servir cualquiera de los dos seria decidir
  // por el cliente a que esta autorizando.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, {
    meta: pagoObjeto({ id: "identificador-numero-uno" }),
    arg: meterEnSobre(pagoObjeto({ id: "identificador-numero-dos" })),
  }));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /do not describe the same payment/);
  assert.equal(res.structuredContent, undefined, "no se sirve veredicto");
  assert.equal(res._meta, undefined, "y ninguna apariencia de liquidacion");
});

// ---------------------------------------------------------------------------
// 5. Firma invalida, por cualquiera de los dos vehiculos
// ---------------------------------------------------------------------------

test("W51: una firma invalida por _meta devuelve reto y no liquida", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto({ amount: "1" }) }));
  assert.equal(res.isError, true);
  assert.match(res.structuredContent.error, /do not match/);
  assert.equal(res.structuredContent.x402, undefined);
  assert.equal(res._meta, undefined);
});

test("W51: un _meta que no es un objeto se rechaza con motivo", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: "no-soy-un-objeto" }));
  assert.equal(res.isError, true);
  assert.ok(res.structuredContent.error, "tiene que decir por que");
  assert.equal(res._meta, undefined);
});

// ---------------------------------------------------------------------------
// 6-7. Donde NO puede haber ninguna apariencia de pago
// ---------------------------------------------------------------------------

test("W51: una respuesta del TRAMO GRATIS no lleva x402 ni _meta", async () => {
  const env = { ...ENV, FREE_TRIAL_ENABLED: "true", DB: db(), AI: ia("YES") };
  const res = await llamar(env);
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(res.structuredContent.verdict));
  assert.equal(res.structuredContent.x402, undefined);
  assert.equal(res._meta, undefined, "el estandar tampoco puede insinuar un pago que no hubo");
});

test("W51: UNKNOWN con autorizacion presentada — NO hubo liquidacion, ni x402 ni _meta", async () => {
  // Se presento una autorizacion de pago, pero NO se produjo liquidacion porque
  // el resultado fue UNKNOWN. La autorizacion caduca sin usarse.
  const env = { ...ENV, DB: db(), AI: ia("UNKNOWN") };
  const res = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(res.structuredContent.verdict, "UNKNOWN");
  assert.equal(res.structuredContent.x402, undefined);
  assert.equal(res._meta, undefined);
});

// ---------------------------------------------------------------------------
// 8-10. La liquidacion, y que las dos formas digan lo mismo
// ---------------------------------------------------------------------------

test("W51: _meta['x402/payment-response'] es el objeto estandar, NO base64", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto() }));
  const sr = res._meta["x402/payment-response"];
  assert.equal(typeof sr, "object", "objeto, no cadena");
  assert.equal(sr.success, true);
  assert.equal(sr.transaction, TX);
  assert.equal(sr.network, RED);
  assert.equal(sr.payer, PAYER);
});

test("W51 NO PUEDEN DISCREPAR: _meta y structuredContent.x402 salen del mismo sobre", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto() }));
  const sr = res._meta["x402/payment-response"];
  const x = res.structuredContent.x402;
  assert.equal(sr.transaction, x.transaction);
  assert.equal(sr.network, x.network);
  assert.equal(sr.payer, x.payer);
  // Y las dos coinciden con el sobre crudo que viaja dentro del bloque.
  const dentro = sacarDelSobre(x.payment_response);
  assert.equal(dentro.transaction, sr.transaction);
  assert.equal(dentro.network, sr.network);
  assert.equal(dentro.payer, sr.payer);
});

test("W51: en un reintento las dos formas tambien coinciden, con coste 0", async () => {
  const { validateRequest } = await import("../src/contract.mjs");
  const { huella } = await import("../src/idempotencia.mjs");
  const id = "reintento-w51-000001";
  const v = validateRequest(PETICION);
  const h = await huella({ aceptado: ACEPTADO, metodo: "POST", ruta: "/mcp", cuerpo: v.value });
  const guardada = JSON.stringify({ schema_version: "1.0", verdict: "YES", returnable: true, policy: null, evidence: null });
  const env = { ...ENV, AI: ia("YES"),
    DB: db({ idemFila: { payment_id: id, fingerprint: h, response_json: guardada,
                         http_status: 200, transaction_hash: TX, expires_at: "2099-01-01T00:00:00.000Z" } }) };
  const res = await llamar(env, { meta: pagoObjeto({ id }) });
  assert.equal(res.structuredContent.x402.settlement, "replay");
  assert.equal(res.structuredContent.x402.transaction, TX, "la transaccion ORIGINAL se conserva");
  assert.equal(res.structuredContent.x402.cost_usd, "0.0000", "y no se ha vuelto a cobrar");
  // W51 — el replay NO emite el objeto estandar. No se puede reconstruir el
  // pagador de forma fiable: payment_idempotency no guarda columna de pagador, y
  // el sobre del reintento no sirve para afirmarlo porque la huella NO cubre
  // payload.authorization.from y un reintento no vuelve a llamar al facilitador.
  // Antes se omite que se inventa un payer.
  assert.equal(res._meta, undefined, "sin SettlementResponse estandar en replay");
});

// ---------------------------------------------------------------------------
// 11. HTTP no se toca
// ---------------------------------------------------------------------------

test("W51: el cuerpo de /v1/check sigue sin x402 y con la evidencia en cabeceras", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const r = await conFacilitador({}, () => worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": meterEnSobre(pagoObjeto()) },
    body: JSON.stringify(PETICION),
  }), env));
  assert.equal(r.status, 200);
  const cuerpo = await r.json();
  assert.equal(cuerpo.x402, undefined, "el contrato v1.0 no gana campos");
  assert.equal(sacarDelSobre(r.headers.get("PAYMENT-RESPONSE")).transaction, TX);
  assert.equal(r.headers.get("X-ReturnCheck-Settlement"), "confirmed");
});

// ---------------------------------------------------------------------------
// 12. LOS CUATRO ESTADOS: la forma estandar SOLO donde se sostiene
// ---------------------------------------------------------------------------

test("W51 confirmed: resultado funcional + bloque + _meta estandar con success true", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(res.isError, false);
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(res.structuredContent.verdict), "se sirve el resultado");
  assert.equal(res.structuredContent.x402.settlement, "confirmed");
  const sr = res._meta["x402/payment-response"];
  assert.equal(sr.success, true);
  assert.equal(sr.transaction, TX);
  assert.equal(sr.network, RED);
  assert.equal(sr.payer, PAYER);
});

test("W51 pending: se sirve el resultado y el bloque, pero SIN _meta estandar", async () => {
  // La decision de W41 se conserva: ante la duda se entrega. Lo que no se hace es
  // meter "no lo se" en un campo que solo sabe decir si o no.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador(
    { settle: { success: false, errorReason: "settlement_pending", transaction: TX, network: RED, payer: PAYER } },
    () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(res.isError, false);
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(res.structuredContent.verdict), "el resultado se sirve igual");
  assert.equal(res.structuredContent.x402.settlement, "pending");
  assert.equal(res.structuredContent.x402.transaction, TX, "la evidencia sigue estando");
  assert.equal(res.structuredContent.x402.cost_usd, "0.0200");
  assert.equal(res._meta, undefined, "ni exito ni fallo estandar: no se emite");
});

test("W51 unconfirmed: se sirve el resultado y el bloque, pero SIN _meta estandar", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({ settleCae: true }, () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(res.isError, false);
  assert.ok(["YES", "YES_WITH_CONDITIONS"].includes(res.structuredContent.verdict));
  assert.equal(res.structuredContent.x402.settlement, "unconfirmed");
  assert.equal(res.structuredContent.x402.cost_usd, "0.0200");
  assert.equal(res._meta, undefined);
});

test("W51 LA REGLA: ningun estado incierto sale como success:false en un resultado normal", async () => {
  // Es la prueba que impide que alguien "complete" la compatibilidad emitiendo
  // success:false para pending o unconfirmed. Ese valor lo leeria un cliente
  // automatico como fallo, y podria firmar una autorizacion nueva.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const casos = [
    ["pending", { settle: { success: false, errorReason: "settlement_pending", transaction: TX, network: RED, payer: PAYER } }],
    ["unconfirmed", { settleCae: true }],
  ];
  for (const [nombre, cfg] of casos) {
    const res = await conFacilitador(cfg, () => llamar(env, { meta: pagoObjeto() }));
    assert.equal(res.isError, false, nombre + ": se sirve");
    assert.equal(res._meta, undefined, nombre + ": sin objeto estandar");
    assert.equal(JSON.stringify(res).includes('"success":false'), false,
      nombre + ": la palabra success:false no puede aparecer en el resultado");
  }
});

test("W51: solo `confirmed` emite el objeto estandar — los otros tres no", async () => {
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const conf = await conFacilitador({}, () => llamar(env, { meta: pagoObjeto() }));
  assert.ok(conf._meta, "confirmed si");
  const pend = await conFacilitador(
    { settle: { success: false, errorReason: "settlement_pending", transaction: TX, network: RED, payer: PAYER } },
    () => llamar(env, { meta: pagoObjeto() }));
  const unc = await conFacilitador({ settleCae: true }, () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(pend._meta, undefined);
  assert.equal(unc._meta, undefined);
  // El cuarto, replay, se comprueba en su propia prueba mas arriba.
});

// ---------------------------------------------------------------------------
// 13. LA INVARIANTE DEL ENSAMBLADOR
//
// `estado === "confirmed"` no basta. Estas pruebas atacan el ensamblador
// DIRECTAMENTE, con sobres que cobro-x402.mjs no produce hoy, porque "hoy no
// puede pasar" no es una invariante: es una coincidencia entre dos ficheros que
// alguien puede romper sin darse cuenta.
// ---------------------------------------------------------------------------

const { evidenciaDePago } = await import("../src/mcp.mjs");

const sobreDe = (o) => meterEnSobre(o);
const COMPLETO = { success: true, transaction: TX, network: RED, payer: PAYER };
const ev = (o, estado = "confirmed") =>
  evidenciaDePago({ estado, cabecera: sobreDe(o), coste: 0.02 });

test("W51 INVARIANTE: confirmed + success:false -> sin objeto estandar", async () => {
  const r = ev({ ...COMPLETO, success: false });
  assert.equal(r.settlement, null, "no se emite el estandar");
  assert.equal(JSON.stringify(r).includes('"success":false'), false,
    "y no se cuela un success:false por ningun lado del resultado");
  assert.notEqual(r.bloque.settlement, "confirmed",
    "ni se conserva 'confirmed' como si nada hubiera pasado");
  assert.equal(r.bloque.settlement, "unconfirmed", "el estado conservador");
});

test("W51 INVARIANTE: confirmed + success ausente -> sin objeto estandar", async () => {
  const { success, ...sinSuccess } = COMPLETO;
  const r = ev(sinSuccess);
  assert.equal(r.settlement, null);
  assert.equal(r.bloque.settlement, "unconfirmed");
});

test("W51 INVARIANTE: confirmed con transaccion ausente -> sin objeto estandar", async () => {
  assert.equal(ev({ ...COMPLETO, transaction: "" }).settlement, null);
  const { transaction, ...sinTx } = COMPLETO;
  assert.equal(ev(sinTx).settlement, null);
  assert.equal(ev({ ...COMPLETO, transaction: "   " }).settlement, null, "ni espacios en blanco");
});

test("W51 INVARIANTE: confirmed con red ausente -> sin estandar, y NUNCA redPorDefecto", async () => {
  const { network, ...sinRed } = COMPLETO;
  const r = ev(sinRed);
  assert.equal(r.settlement, null, "la red anunciada no puede rellenar la que no devolvio la liquidacion");
  assert.equal(ev({ ...COMPLETO, network: "" }).settlement, null);
});

test("W51 EL BLOQUE PROPIO TAMPOCO SE RELLENA DESDE FUERA: sobre sin red -> network null", async () => {
  // Se pasa un redPorDefecto A PROPOSITO, para demostrar que ya no existe camino
  // por el que una red exterior entre en la evidencia. El bloque dice ser lo que
  // hay en payment_response; si el sobre no trae red, el bloque no la inventa.
  const { network, ...sinRed } = COMPLETO;
  const r = evidenciaDePago({ estado: "confirmed", cabecera: sobreDe(sinRed), coste: 0.02,
                              redPorDefecto: RED });   // <- ignorado: ya no esta en la firma
  assert.equal(r.bloque.network, null, "el bloque NO completa la red que falta");
  assert.equal(r.settlement, null, "y no se emite el objeto estandar");
  assert.notEqual(r.bloque.settlement, "confirmed", "ni se conserva como confirmado");
  assert.equal(r.bloque.settlement, "unconfirmed");
  // Y el sobre crudo que va al lado sigue sin red: el bloque no lo contradice.
  assert.equal(sacarDelSobre(r.bloque.payment_response).network, undefined);
});

test("W51 INVARIANTE: confirmed con pagador ausente -> sin objeto estandar", async () => {
  // Sin pagador no se puede correlacionar el pago, que es para lo que existe.
  const { payer, ...sinPagador } = COMPLETO;
  assert.equal(ev(sinPagador).settlement, null);
  assert.equal(ev({ ...COMPLETO, payer: "" }).settlement, null);
});

test("W51 INVARIANTE: confirmed COMPLETO -> estandar presente y EXACTO al sobre", async () => {
  const r = ev(COMPLETO);
  assert.deepEqual(r.settlement, { success: true, transaction: TX, network: RED, payer: PAYER },
    "los cuatro valores salen del sobre, sin respaldos ni cadenas fabricadas");
  assert.equal(r.bloque.settlement, "confirmed");
  assert.equal(sacarDelSobre(r.bloque.payment_response).transaction, r.settlement.transaction);
});

test("W51 INVARIANTE: pending y unconfirmed nunca emiten estandar, completos o no", async () => {
  assert.equal(ev(COMPLETO, "pending").settlement, null);
  assert.equal(ev(COMPLETO, "unconfirmed").settlement, null);
  assert.equal(ev(COMPLETO, "replay").settlement, null);
  // Y su estado propio se conserva tal cual: la degradacion solo aplica a confirmed.
  assert.equal(ev(COMPLETO, "pending").bloque.settlement, "pending");
  assert.equal(ev(COMPLETO, "replay").bloque.settlement, "replay");
});

test("W51 INVARIANTE, POR LA RUTA REAL: un settle sin pagador no sale como confirmado", async () => {
  // Esta combinacion SI la puede producir el facilitador: success true sin payer.
  const env = { ...ENV, DB: db(), AI: ia("YES") };
  const res = await conFacilitador({ settle: { success: true, transaction: TX, network: RED } },
    () => llamar(env, { meta: pagoObjeto() }));
  assert.equal(res.isError, false, "el resultado funcional se sirve igual");
  assert.equal(res._meta, undefined, "pero sin evidencia estandar");
  assert.equal(res.structuredContent.x402.settlement, "unconfirmed");
  assert.equal(JSON.stringify(res).includes('"success":false'), false);
});
