// LA PUERTA HUMANA DEL 402.
//
// POR QUÉ EXISTE ESTA PRUEBA. Al encender x402 el 402 dejó de decirle a una
// persona cómo seguir: solo quedaba «Payment required» y un objeto `accepts` que
// un desarrollador no sabe usar. El camino que sí puede usar —darse de alta y
// llevarse crédito gratis— existía, estaba pagado, y había desaparecido del
// mensaje. Lo descubrimos el 28 de agosto probando el paquete de npm recién
// publicado: la primera respuesta que ve alguien que te instala era un muro.
//
// Y hay una segunda cosa que esta prueba vigila, más delicada: que el añadido
// para humanos NO se cuele en el sobre PAYMENT-REQUIRED. Esa cabecera es contrato
// con el agente y con el facilitador. Un campo de más en el cuerpo es inofensivo;
// en el sobre puede romper a un parser estricto.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { sacarDelSobre, RED } from "../src/x402.mjs";

const BASE = {
  PUBLIC_BASE_URL: "https://rc.example",
  PRICE_USD: "0.02",
  SIGNUP_FREE_CREDIT_USD: "2.00",
  FREE_IP_DAILY: "3",
  FREE_TRIAL_ENABLED: "true",
  X402_ENABLED: "true",
  X402_PAY_TO: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  X402_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// Sin `DB`, freeTrial falla y devuelve allowed:false — que es justo el estado que
// queremos: tramo gratis no disponible, x402 encendido, y por tanto reto de pago.
const pedir = (env) =>
  worker.fetch(new Request("https://rc.example/v1/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ product_url: "https://t.example/p/1", buyer_country: "US" }),
  }), env);

test("el 402 sigue siendo un reto x402 válido para el agente", async () => {
  const r = await pedir({ ...BASE, X402_NETWORK: RED.BASE_SEPOLIA });
  assert.equal(r.status, 402);
  const b = await r.json();
  assert.ok(b.x402Version, "el agente necesita la version");
  assert.ok(Array.isArray(b.accepts) && b.accepts.length, "y las condiciones de pago");
  assert.ok(r.headers.get("PAYMENT-REQUIRED"), "y el sobre en la cabecera");
});

test("EL 402 YA NO ES UN CALLEJÓN: dice cómo sigue una persona", async () => {
  const r = await pedir({ ...BASE, X402_NETWORK: RED.BASE_SEPOLIA });
  const h = (await r.json()).human_next_steps;
  assert.ok(h, "tiene que haber una salida para humanos");
  assert.equal(h.free_trial.calls_per_ip_per_day, 3);
  assert.match(h.signup.url, /\/v1\/signup$/);
  assert.equal(h.signup.free_credit_usd, 2);
  assert.equal(h.signup.approx_free_calls, 100, "2 $ a 0,02 $ son 100 consultas");
  assert.equal(h.unknown_is_free, true);
  assert.match(h.message, /per IP per day/);
});

test("EL SOBRE NO SE TOCA: lo humano va solo en el cuerpo", async () => {
  // Esta es la que de verdad protege el dinero. El cuerpo es para leer; el sobre
  // es contrato.
  const r = await pedir({ ...BASE, X402_NETWORK: RED.BASE_SEPOLIA });
  const dentro = sacarDelSobre(r.headers.get("PAYMENT-REQUIRED"));
  assert.ok(dentro.accepts, "el sobre sigue trayendo las condiciones");
  assert.equal(dentro.human_next_steps, undefined,
    "el anadido para humanos NO puede viajar en la cabecera del protocolo");
});

test("si la red es de PRUEBAS, se dice — no se deja creer que se cobra de verdad", async () => {
  const r = await pedir({ ...BASE, X402_NETWORK: RED.BASE_SEPOLIA });
  const h = (await r.json()).human_next_steps;
  assert.match(h.x402_note, /TEST network/);
  assert.match(h.x402_note, /cannot move real money/);
});

test("en la red de verdad ese aviso desaparece", async () => {
  const r = await pedir({ ...BASE, X402_NETWORK: "eip155:8453" });
  const h = (await r.json()).human_next_steps;
  assert.equal(h.x402_note, undefined, "en mainnet no se avisa de red de pruebas");
  assert.ok(h.signup.url, "pero la puerta humana sigue estando");
});
