// Sondeo de descubrimiento sin gastar cuota.
//
// Las dos puertas que se prueban aqui (POST sin cuerpo y GET) deben entregar el
// MISMO reto que el camino de pago sin gastar NADA de lo que cuesta: ni el contador
// del tramo gratis (que vive en D1), ni el motor, ni el facilitador.
//
// W58 — LO QUE CAMBIO Y POR QUE. Antes esto se comprobaba con "cero accesos a D1".
// Desde que existe el contador de descubrimiento, una sonda escribe UNA metrica, y
// escribirla es justo el objetivo: sin ese numero, cuatro semanas sin un pago no
// distinguen "nadie nos encontro" de "nos encontraron y no convirtieron". La
// garantia que importa no era "cero filas", era "cero cuota, cero computo, cero
// dinero", y esa se sigue comprobando, ahora por el CONTENIDO de lo que se consulta
// y no por el numero: se exige que lo unico que toque D1 sea la tabla de metricas. Los espias cuentan accesos y
// devuelven respuestas validas a proposito: freetier.mjs captura sus propios errores
// (`.catch(() => null)`), asi que un entorno sin DB NO demostraria que no se intento
// acceder. Hay que contar los intentos, no provocarlos.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { requisitosDePago, sacarDelSobre } from "../src/x402.mjs";

// Base mainnet y el contrato real de USDC en Base, como en produccion.
const BASE = {
  PUBLIC_BASE_URL: "https://rc.example", X402_ENABLED: "true",
  X402_NETWORK: "eip155:8453", X402_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  X402_PAY_TO: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b", PRICE_USD: "0.02",
  FREE_TRIAL_ENABLED: "true",
};

// Espias: D1 (contador y puerta), modelo y salida de red (motor y facilitador).
function espiado(extra = {}) {
  const visto = { d1: 0, consultas: [], ai: 0, red: [] };
  const stmt = {
    bind() { return stmt; },
    async run() { return { success: true }; },
    async first() { return { count: 1 }; },
    async all() { return { results: [] }; },
  };
  const env = {
    ...BASE, ...extra,
    DB: { prepare(sql) { visto.d1++; visto.consultas.push(String(sql).slice(0, 40)); return stmt; } },
    AI: { async run() { visto.ai++; return { response: "{}" }; } },
  };
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (u, o) => { visto.red.push(String(u && u.url ? u.url : u)); return new Response("{}", { status: 200 }); };
  return { env, visto, restaurar: () => { globalThis.fetch = fetchReal; } };
}

const RUTAS = ["/v1/check", "/v1/check_return"];

// Cero motor, cero facilitador, y de D1 solo la tabla de metricas: ni el contador
// del tramo gratis ni nada de pagos. Se mira QUE se consulta, no cuantas veces.
function soloMetricas(visto) {
  assert.equal(visto.ai, 0, "la sonda no debe llamar al modelo");
  assert.deepEqual(visto.red, [], "la sonda no debe salir a la red");
  const ajenas = visto.consultas.filter((q) => !/metrics/i.test(q));
  assert.deepEqual(ajenas, [], "la sonda solo puede tocar la tabla de metricas");
}

for (const ruta of RUTAS) {
  test("POST sin cuerpo en " + ruta + ": reto completo y cero cuota, cero motor, cero facilitador", async () => {
    const { env, visto, restaurar } = espiado();
    try {
      const r = await worker.fetch(new Request("https://rc.example" + ruta, { method: "POST" }), env);
      assert.equal(r.status, 402);
      const cuerpo = await r.json();
      assert.deepEqual(cuerpo.accepts, requisitosDePago(env));
      assert.equal(cuerpo.extensions["payment-identifier"].info.required, true);
      assert.ok(cuerpo.extensions.bazaar, "la ruta HTTP anuncia bazaar");
      // Cabecera y cuerpo dicen lo mismo; la puerta humana vive solo en el cuerpo.
      const { human_next_steps, ...protocolo } = cuerpo;
      assert.deepEqual(sacarDelSobre(r.headers.get("PAYMENT-REQUIRED")), protocolo);
      assert.ok(r.headers.get("PAYMENT-REQUIRED").length < 16000, "cabecera por debajo del limite de 16 KB");
      // Lo que no se ha tocado.
      soloMetricas(visto);
    } finally { restaurar(); }
  });

  test("GET en " + ruta + ": mismo reto y tampoco toca nada", async () => {
    const { env, visto, restaurar } = espiado();
    try {
      const r = await worker.fetch(new Request("https://rc.example" + ruta), env);
      assert.equal(r.status, 402);
      const cuerpo = await r.json();
      assert.deepEqual(cuerpo.accepts, requisitosDePago(env));
      assert.ok(cuerpo.extensions["payment-identifier"]);
      soloMetricas(visto);
    } finally { restaurar(); }
  });
}

test("content-length 0 cuenta como sondeo, y tampoco gasta cuota", async () => {
  const { env, visto, restaurar } = espiado();
  try {
    const r = await worker.fetch(new Request("https://rc.example/v1/check", {
      method: "POST", body: "", headers: { "content-length": "0" },
    }), env);
    assert.equal(r.status, 402);
    soloMetricas(visto);
  } finally { restaurar(); }
});

test("una consulta real con cuerpo valido sigue entrando en el tramo gratis igual que antes", async () => {
  const { env, visto, restaurar } = espiado();
  try {
    const r = await worker.fetch(new Request("https://rc.example/v1/check", {
      method: "POST", body: JSON.stringify({ product_url: "https://shop.example/p/1", buyer_country: "US" }),
    }), env);
    // No se afirma el veredicto: lo que importa es que NO se le respondio con el reto
    // y que el contador del tramo gratis si se consulto, como hasta ahora.
    assert.notEqual(r.status, 402);
    assert.ok(visto.d1 > 0, "el camino normal sigue pasando por el contador");
  } finally { restaurar(); }
});

test("con x402 apagado, el sondeo se comporta como antes del parche", async () => {
  const { env, visto, restaurar } = espiado({ X402_ENABLED: "false" });
  try {
    const post = await worker.fetch(new Request("https://rc.example/v1/check", { method: "POST" }), env);
    assert.equal(post.status, 400); // "Body must be JSON", como siempre
    const get = await worker.fetch(new Request("https://rc.example/v1/check"), env);
    assert.equal(get.status, 404);
  } finally { restaurar(); }
});

test("con configuracion incompleta de x402 tampoco se inventa un reto", async () => {
  // X402_ENABLED=true pero sin destino de cobro: requisitosDePago(env) no existe.
  const { env, restaurar } = espiado({ X402_PAY_TO: undefined, X402_ASSET: undefined });
  try {
    assert.equal(requisitosDePago(env), null);
    const post = await worker.fetch(new Request("https://rc.example/v1/check", { method: "POST" }), env);
    assert.notEqual(post.status, 402);
    const get = await worker.fetch(new Request("https://rc.example/v1/check"), env);
    assert.equal(get.status, 404);
  } finally { restaurar(); }
});

// Simulacion local del sondeo de x402scan, siguiendo la forma documentada en
// apps/scan/src/lib/discovery/probe.ts: leer el OpenAPI, quedarse con el metodo
// declarado (lo prefiere sobre el del sondeo) y sondear sin cuerpo.
// LIMITE: esto reproduce la forma documentada, no la biblioteca real. No prueba el
// orden exacto de peticiones que emite su cliente HTTP.
test("sondeo tipo x402scan: encuentra los terminos en la primera peticion y sin cuota", async () => {
  const { env, visto, restaurar } = espiado();
  try {
    const spec = await (await worker.fetch(new Request("https://rc.example/openapi.json"), env)).json();
    const metodos = Object.keys(spec.paths["/v1/check"]);
    assert.deepEqual(metodos, ["post"], "el OpenAPI declara POST, que es el que el rastreador prefiere");
    const consultasAntesDelSondeo = visto.consultas.length;
    const r = await worker.fetch(new Request("https://rc.example/v1/check", { method: "POST" }), env);
    assert.equal(r.status, 402);
    const cuerpo = await r.json();
    assert.equal(cuerpo.x402Version, 2);
    assert.ok(Array.isArray(cuerpo.accepts) && cuerpo.accepts.length > 0);
    assert.ok(cuerpo.accepts.every((a) => a.network === "eip155:8453"));
    assert.ok(cuerpo.extensions["payment-identifier"] && cuerpo.extensions.bazaar);
    const delSondeo = visto.consultas.slice(consultasAntesDelSondeo).filter((q) => !/metrics/i.test(q));
    assert.deepEqual(delSondeo, [], "el sondeo no consulto el contador del tramo gratis");
    assert.deepEqual(visto.red, [], "el sondeo no llamo al facilitador ni al motor");
  } finally { restaurar(); }
});
