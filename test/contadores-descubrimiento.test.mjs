// W58 — CONTADORES DE DESCUBRIMIENTO.
//
// Por que existen estas pruebas: el numero que miden es el que decide, dentro de
// cuatro semanas, si "cero pagos" significa que nadie nos encontro o que nos
// encontraron y no convirtieron. Si el contador deja de subir y nadie se entera,
// esa decision se toma a ciegas. Aqui se comprueba que sube, y donde NO sube.
//
// El env falso lleva un DB de mentira que apunta lo que se le pide, para no
// necesitar D1: lo que se verifica es que la ruta pide el incremento correcto.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

// D1 de juguete. Solo entiende lo que metrics.mjs le manda.
function dbFalso(apuntes) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          if (/INSERT INTO metrics/i.test(sql)) apuntes.push({ name: args[0], by: args[1] });
          return this;
        },
        async run() { return { success: true }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
  };
}

function entorno(apuntes, extra = {}) {
  return {
    PUBLIC_BASE_URL: "https://rc.example",
    CONTACT_EMAIL: "returncheckteam@gmail.com",
    DATA_RETENTION_MONTHS: "48",
    X402_ENABLED: "true",
    X402_NETWORK: "eip155:8453",
    X402_PAY_TO: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b",
    X402_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    PRICE_USD: "0.02",
    DB: dbFalso(apuntes),
    ...extra,
  };
}

const cuenta = (apuntes, nombre) =>
  apuntes.filter((a) => a.name === nombre).reduce((n, a) => n + a.by, 0);

test("descubrimiento: un GET de /.well-known/x402 suma discovery_reads_total", async () => {
  const apuntes = [];
  const r = await worker.fetch(new Request("https://rc.example/.well-known/x402"), entorno(apuntes));
  assert.equal(r.status, 200);
  assert.equal(cuenta(apuntes, "discovery_reads_total"), 1);
  assert.equal(cuenta(apuntes, "x402_402_total"), 0);
});

test("descubrimiento: /openapi.json y /discovery.json tambien cuentan", async () => {
  for (const ruta of ["/openapi.json", "/.well-known/openapi.json", "/discovery.json"]) {
    const apuntes = [];
    const r = await worker.fetch(new Request("https://rc.example" + ruta), entorno(apuntes));
    assert.equal(r.status, 200, ruta);
    assert.equal(cuenta(apuntes, "discovery_reads_total"), 1, ruta);
  }
});

test("402: una sonda de descubrimiento sin pago suma x402_402_total", async () => {
  const apuntes = [];
  const r = await worker.fetch(new Request("https://rc.example/v1/check"), entorno(apuntes));
  assert.equal(r.status, 402);
  assert.equal(cuenta(apuntes, "x402_402_total"), 1);
  assert.equal(cuenta(apuntes, "discovery_reads_total"), 0);
});

// Un 402 no es una lectura de descubrimiento y una lectura no es un 402. Si los
// dos contadores subieran a la vez, el numero dejaria de significar nada.
test("los dos contadores son excluyentes: nunca suben en la misma peticion", async () => {
  for (const [ruta, estado] of [["/.well-known/x402", 200], ["/v1/check", 402]]) {
    const apuntes = [];
    await worker.fetch(new Request("https://rc.example" + ruta), entorno(apuntes));
    const a = cuenta(apuntes, "x402_402_total");
    const b = cuenta(apuntes, "discovery_reads_total");
    assert.ok((a === 1 && b === 0) || (a === 0 && b === 1), ruta + " estado " + estado);
  }
});

// Lo que NO debe contar: una pagina cualquiera no es descubrimiento.
test("una ruta publica que no es de descubrimiento no suma nada", async () => {
  const apuntes = [];
  const r = await worker.fetch(new Request("https://rc.example/data-policy"), entorno(apuntes));
  assert.equal(r.status, 200);
  assert.equal(cuenta(apuntes, "discovery_reads_total"), 0);
  assert.equal(cuenta(apuntes, "x402_402_total"), 0);
});

// Los contadores viven DESPUES de la respuesta y metrics.mjs se traga sus
// errores: un D1 roto no puede convertir un 200 en un 500.
test("si las metricas fallan, la respuesta sale igual", async () => {
  const env = entorno([], {
    DB: { prepare() { throw new Error("D1 caido"); } },
  });
  const r = await worker.fetch(new Request("https://rc.example/.well-known/x402"), env);
  assert.equal(r.status, 200);
});
