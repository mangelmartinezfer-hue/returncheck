// W48 — EL MCP PASA A SER PAGABLE, Y /.well-known/x402.
//
// POR QUE EXISTEN ESTAS PRUEBAS. El trabajo de cobro estaba hecho desde W32, pero
// solo en un lado: /v1/check devolvia un reto de pago y el MCP, en el MISMO
// momento, devolvia un parrafo pidiendo un correo. Un agente autonomo no tiene
// correo. Lo que se vigila aqui es que los dos lados digan lo mismo y que el
// dinero pase por un solo sitio.
//
// Las tres que de verdad importan:
//   · que con el interruptor APAGADO no cambie nada (como en W32);
//   · que una firma trucada NO cobre, tambien por esta puerta;
//   · que el reto del MCP y el cuerpo del 402 de HTTP sean el mismo objeto.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { TOOL } from "../src/mcp.mjs";
import { meterEnSobre, sacarDelSobre } from "../src/x402.mjs";

const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET  = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const ENV = {
  PUBLIC_BASE_URL: "https://rc.example",
  PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00",
  FREE_IP_DAILY: "3",
  // Sin tramo gratis, para llegar al reto sin depender de la base de datos.
  FREE_TRIAL_ENABLED: "false",
};

const ENV_X402 = {
  ...ENV,
  X402_ENABLED: "true",
  X402_NETWORK: "eip155:84532",
  X402_PAY_TO: PAY_TO,
  X402_ASSET: ASSET,
};

// --- utilidades de transporte -------------------------------------------------

async function llamarHerramienta(env, args = {}) {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "check_return", arguments: { product_url: "https://t.example/p/1", buyer_country: "US", ...args } },
    }),
  }), env);
  return (await r.json()).result;
}

const post402 = (env, cabeceras = {}) =>
  worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...cabeceras },
    body: JSON.stringify({ product_url: "https://t.example/p/1", buyer_country: "US" }),
  }), env);

const bienEstructurado = (r) => (r && r.structuredContent) || {};

// --- 1. el argumento nuevo ----------------------------------------------------

test("W48: payment_signature existe y es OPCIONAL — el contrato no se rompe", () => {
  const p = TOOL.inputSchema.properties.payment_signature;
  assert.ok(p, "el agente no puede pagar si no hay por donde mandar la firma");
  assert.equal(p.type, "string");
  assert.ok(!TOOL.inputSchema.required.includes("payment_signature"),
    "si fuera obligatorio, romperiamos a todos los agentes que ya nos llaman");
  assert.deepEqual(TOOL.inputSchema.required, ["product_url", "buyer_country"],
    "los obligatorios siguen siendo exactamente los de siempre");
});

test("W48: tools/list publica el argumento, que es como se entera un agente", async () => {
  const r = await worker.fetch(new Request("https://rc.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), ENV_X402);
  const props = (await r.json()).result.tools[0].inputSchema.properties;
  assert.ok(props.payment_signature);
  assert.match(props.payment_signature.description, /x402/);
});

// --- 2. el reto en structuredContent -----------------------------------------

test("W48 EL CALLEJON SIN SALIDA DEL MCP: agotado el tramo gratis, ahora hay reto", async () => {
  const res = await llamarHerramienta(ENV_X402);
  const sc = bienEstructurado(res);
  assert.equal(sc.x402Version, 2, "el agente necesita la version");
  assert.ok(Array.isArray(sc.accepts) && sc.accepts.length, "y las condiciones de pago");
  assert.equal(sc.accepts[0].amount, "20000");
  assert.equal(sc.accepts[0].payTo, PAY_TO);
  assert.equal(sc.accepts[0].network, "eip155:84532");
  assert.equal(res.isError, true, "no ha habido veredicto: para el agente es un fallo con instrucciones");
});

test("W48: el reto del MCP tambien lleva la puerta humana", async () => {
  const sc = bienEstructurado(await llamarHerramienta(ENV_X402));
  assert.ok(sc.human_next_steps, "una persona tiene que poder seguir por aqui tambien");
  assert.match(sc.human_next_steps.signup.url, /\/v1\/signup$/);
  assert.equal(sc.human_next_steps.unknown_is_free, true);
});

test("W48: el texto menciona LOS DOS caminos, no solo el nuevo", async () => {
  const res = await llamarHerramienta(ENV_X402);
  const texto = res.content[0].text;
  assert.match(texto, /payment_signature/, "el camino del agente");
  assert.match(texto, /\/v1\/signup/, "y el camino de la persona, que es el que hoy funciona");
  assert.match(texto, /UNKNOWN/, "y que lo no verificado no se cobra");
});

test("W48 LOS DOS LADOS DICEN LO MISMO: el reto del MCP es el cuerpo del 402", async () => {
  // Esta es la que impide que se separen con el tiempo. Se construyen con la
  // misma funcion; si alguien duplica una de las dos, esto se cae.
  const sc = bienEstructurado(await llamarHerramienta(ENV_X402));
  const cuerpoHttp = await (await post402(ENV_X402)).json();
  assert.equal(sc.x402Version, cuerpoHttp.x402Version);
  assert.deepEqual(sc.accepts, cuerpoHttp.accepts);
  assert.deepEqual(sc.human_next_steps, cuerpoHttp.human_next_steps);
});

// --- 3. lo que NO debe cambiar -----------------------------------------------

test("W48 LO MAS IMPORTANTE: con el interruptor APAGADO no cambia nada", async () => {
  // Aunque la direccion de cobro este configurada y aunque llegue una firma.
  const apagado = { ...ENV_X402, X402_ENABLED: "false" };
  const res = await llamarHerramienta(apagado, { payment_signature: "cualquier-cosa" });
  assert.equal(res.structuredContent, undefined, "no se anuncia ningun precio");
  assert.match(res.content[0].text, /Free trial limit reached/, "el mensaje de siempre, intacto");
  assert.equal(res.isError, true);
});

test("W48: sin direccion de cobro NO se anuncia precio — se cae al correo", async () => {
  const res = await llamarHerramienta({ ...ENV_X402, X402_PAY_TO: "" });
  assert.equal(res.structuredContent, undefined);
  assert.match(res.content[0].text, /Free trial limit reached/);
});

// --- 4. el ataque, por la puerta nueva ---------------------------------------

test("W48 EL ATAQUE: una firma que no cuadra con lo que pedimos NO cobra", async () => {
  // El mismo de W28 y W32, ahora por MCP: firma perfecta sobre una cantidad
  // rebajada. Tiene que morir aqui, antes de llamar al facilitador.
  const trucada = meterEnSobre({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "1", asset: ASSET, payTo: PAY_TO },
    payload: { signature: "0xloquesea", authorization: {} },
  });
  const res = await llamarHerramienta(ENV_X402, { payment_signature: trucada });
  assert.equal(res.isError, true, "no puede servirse una respuesta por una firma trucada");
  assert.match(bienEstructurado(res).error, /do not match/);
});

test("W48: y el otro ataque, desviar el cobro a otra direccion", async () => {
  const desviada = meterEnSobre({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:84532", amount: "20000", asset: ASSET,
                payTo: "0x000000000000000000000000000000000000dEaD" },
    payload: { signature: "0xloquesea", authorization: {} },
  });
  const res = await llamarHerramienta(ENV_X402, { payment_signature: desviada });
  assert.equal(res.isError, true);
  assert.match(bienEstructurado(res).error, /do not match/);
});

test("W48: un sobre corrupto se rechaza con motivo, sin reventar", async () => {
  const res = await llamarHerramienta(ENV_X402, { payment_signature: "no-es-base64-de-json" });
  assert.equal(res.isError, true);
  assert.ok(bienEstructurado(res).error, "tiene que decir por que");
});

// --- 5. /.well-known/x402 -----------------------------------------------------

const wellKnown = (env) =>
  worker.fetch(new Request("https://rc.example/.well-known/x402"), env);

test("W48: /.well-known/x402 publica los terminos SIN autenticacion", async () => {
  const r = await wellKnown(ENV_X402);
  assert.equal(r.status, 200, "antes daba 404: un agente no podia enterarse sin fallar primero");
  const d = await r.json();
  assert.equal(d.x402Version, 2);
  assert.equal(d.accepts[0].payTo, PAY_TO);
  assert.equal(d.accepts[0].amount, "20000");
  assert.equal(d.accepts[0].network, "eip155:84532");
  assert.equal(d.unknown_is_free, true);
});

test("W48: y anuncia los DOS sitios donde gastar esa firma", async () => {
  const d = await (await wellKnown(ENV_X402)).json();
  assert.match(d.endpoints.http.url, /\/v1\/check$/);
  assert.match(d.endpoints.mcp.url, /\/mcp$/);
  assert.equal(d.endpoints.mcp.tool, "check_return");
  assert.match(d.endpoints.mcp.signature_in, /payment_signature/);
});

test("W48: los terminos publicados son LOS MISMOS que los del reto", async () => {
  // Si el anuncio y el cobro se separaran, un agente firmaria lo anunciado y le
  // rechazariamos la firma por no coincidir. Silencioso y carisimo de depurar.
  const d = await (await wellKnown(ENV_X402)).json();
  const sc = bienEstructurado(await llamarHerramienta(ENV_X402));
  assert.deepEqual(d.accepts, sc.accepts);
});

test("W48: sin configuracion de cobro, la ruta no anuncia nada (404)", async () => {
  const r = await wellKnown({ ...ENV_X402, X402_PAY_TO: "" });
  assert.equal(r.status, 404, "un anuncio sin nada que anunciar es mejor que no exista");
});

test("W48: la ruta no exige clave ni la filtra", async () => {
  const d = await (await wellKnown({ ...ENV_X402, ADMIN_KEY: "secreta" })).json();
  assert.equal(JSON.stringify(d).includes("secreta"), false);
});
