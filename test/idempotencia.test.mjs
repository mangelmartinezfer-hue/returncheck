// W31 — idempotencia de pagos.
//
// Lo que estas pruebas vigilan es lo que le pasa a un agente en el mundo real: paga,
// la respuesta se pierde, y reintenta. Sin protección eso son dos cobros por la
// misma pregunta — y un cliente que no puede reintentar acaba escribiendo código a
// la defensiva alrededor nuestro, o se va.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  leerIdentificador, canonico, huella, consultar, guardar, purgarCaducados,
  reclamar, prepararLiquidacion, completar, liberar,
} from "../src/idempotencia.mjs";

function db() {
  const filas = new Map();
  return {
    _f: filas,
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => filas.get(a[0]) || null,
        run: async () => {
          const s = sql.replace(/\s+/g, " ").trim();
          if (s.startsWith("INSERT INTO payment_idempotency") && s.includes("gate_state")) {
            const anterior = filas.get(a[0]);
            const puedeReclamar = !anterior ||
              (anterior.expires_at <= a[5] && (
                anterior.gate_state === "claimed" ||
                (anterior.gate_state === "completed" && !anterior.transaction_hash &&
                  [null, undefined, "not_charged"].includes(anterior.settlement_state))
              ));
            if (!puedeReclamar) return { meta: { changes: 0 } };
            filas.set(a[0], {
              payment_id: a[0], fingerprint: a[1], response_json: a[2],
              http_status: a[3], transaction_hash: a[4], created_at: a[5],
              expires_at: a[6], gate_state: a[7], attempt_id: a[8],
              settlement_state: a[9], updated_at: a[10],
            });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("INSERT INTO payment_idempotency")) {
            if (filas.has(a[0])) return { meta: { changes: 0 } };
            filas.set(a[0], { payment_id: a[0], fingerprint: a[1], response_json: a[2],
                              http_status: a[3], transaction_hash: a[4], created_at: a[5],
                              expires_at: a[6], gate_state: "completed" });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("UPDATE payment_idempotency") && s.includes("gate_state = 'settling'")) {
            const fila = filas.get(a[3]);
            if (!fila || fila.fingerprint !== a[4] || fila.attempt_id !== a[5] || fila.gate_state !== "claimed")
              return { meta: { changes: 0 } };
            Object.assign(fila, { gate_state: "settling", response_json: a[0], http_status: a[1],
                                  settlement_state: "unconfirmed", updated_at: a[2] });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("UPDATE payment_idempotency") && s.includes("gate_state = 'completed'")) {
            const fila = filas.get(a[5]);
            if (!fila || fila.fingerprint !== a[6] || fila.attempt_id !== a[7] ||
                !["claimed", "settling"].includes(fila.gate_state))
              return { meta: { changes: 0 } };
            Object.assign(fila, { gate_state: "completed", response_json: a[0], http_status: a[1],
                                  transaction_hash: a[2], settlement_state: a[3], updated_at: a[4] });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("DELETE FROM payment_idempotency")) {
            if (s.includes("attempt_id")) {
              const fila = filas.get(a[0]);
              if (!fila || fila.fingerprint !== a[1] || fila.attempt_id !== a[2] ||
                  fila.gate_state !== "claimed")
                return { meta: { changes: 0 } };
              filas.delete(a[0]);
              return { meta: { changes: 1 } };
            }
            let n = 0;
            for (const [k, v] of filas)
              if (v.expires_at <= a[0] && (
                v.gate_state === "claimed" ||
                (v.gate_state === "completed" && !v.transaction_hash &&
                  [null, undefined, "not_charged"].includes(v.settlement_state))
              )) { filas.delete(k); n++; }
            return { meta: { changes: n } };
          }
          return { meta: { changes: 0 } };
        },
      }),
    }),
  };
}

const ACEPTADO = { scheme: "exact", network: "eip155:84532", amount: "20000",
                   asset: "0x036C", payTo: "0x2096" };
const PREGUNTA = { product_url: "https://tienda.example/p/1", buyer_country: "US" };
const ID = "pay_0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// El identificador
// ---------------------------------------------------------------------------

test("identificador: se lee del sitio que dice la extensión", () => {
  const pago = { payload: { extensions: { "payment-identifier": ID } } };
  assert.equal(leerIdentificador(pago), ID);
});

test("un identificador ausente o invalido no produce una identidad util", () => {
  // leerIdentificador solo extrae. El camino pagado lo convierte en un 400:
  // sin identidad estable no existe una puerta monetaria.
  assert.equal(leerIdentificador({ payload: { extensions: { "payment-identifier": "corto" } } }), null);
  assert.equal(leerIdentificador({ payload: { extensions: { "payment-identifier": "tiene espacios aqui!!" } } }), null);
  assert.equal(leerIdentificador({ payload: { extensions: { "payment-identifier": 12345 } } }), null);
  assert.equal(leerIdentificador({ payload: {} }), null);
  assert.equal(leerIdentificador(null), null);
});

// ---------------------------------------------------------------------------
// La huella
// ---------------------------------------------------------------------------

test("EL DETALLE SIN EL QUE NADA FUNCIONA: las claves se ordenan", () => {
  // JSON.stringify respeta el orden de insercion, y ese orden depende del cliente.
  // Sin ordenar, la MISMA peticion mandada por dos bibliotecas distintas daria dos
  // huellas distintas, y un reintento legitimo se leeria como conflicto -> 409.
  assert.equal(canonico({ b: 1, a: 2 }), canonico({ a: 2, b: 1 }));
  assert.notEqual(JSON.stringify({ b: 1, a: 2 }), JSON.stringify({ a: 2, b: 1 }));
  // Y recursivamente, que es donde suele olvidarse.
  assert.equal(canonico({ x: { z: 1, y: 2 } }), canonico({ x: { y: 2, z: 1 } }));
});

test("la misma petición da la misma huella, aunque cambie el orden", async () => {
  const a = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: { product_url: "u", buyer_country: "US" } });
  const b = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: { buyer_country: "US", product_url: "u" } });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("LO QUE DE VERDAD PROTEGE: otra pregunta da OTRA huella", async () => {
  // Sin el cuerpo dentro de la huella, un cliente pagaria UNA vez y reutilizaria
  // ese identificador para preguntar por mil productos distintos.
  const a = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: { product_url: "https://a.example/p/1" } });
  const b = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: { product_url: "https://a.example/p/2" } });
  assert.notEqual(a, b);
});

test("y cambiar el dinero, la ruta o el método también cambia la huella", async () => {
  const base = { aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: PREGUNTA };
  const h = await huella(base);
  assert.notEqual(h, await huella({ ...base, aceptado: { ...ACEPTADO, amount: "1000" } }));
  assert.notEqual(h, await huella({ ...base, aceptado: { ...ACEPTADO, payTo: "0xotro" } }));
  assert.notEqual(h, await huella({ ...base, ruta: "/v1/otra" }));
  assert.notEqual(h, await huella({ ...base, metodo: "GET" }));
});

test("la dirección se normaliza a minúsculas: el checksum no cambia la operación", async () => {
  const a = await huella({ aceptado: { ...ACEPTADO, payTo: "0xABCD" }, cuerpo: PREGUNTA });
  const b = await huella({ aceptado: { ...ACEPTADO, payTo: "0xabcd" }, cuerpo: PREGUNTA });
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// La regla
// ---------------------------------------------------------------------------

test("EL CASO QUE JUSTIFICA TODO: reintento con la misma pregunta -> lo guardado, sin cobrar", async () => {
  const DB = db();
  const h = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: PREGUNTA });

  assert.equal(await consultar({ DB }, ID, h), null);            // primera vez: nada
  await guardar({ DB }, { id: ID, huella: h, cuerpo: { verdict: "YES" }, transaccion: "0xabc" });

  const r = await consultar({ DB }, ID, h);
  assert.equal(r.repetido, true);
  assert.equal(JSON.parse(r.cuerpo).verdict, "YES");
  assert.equal(r.transaccion, "0xabc");
});

test("EL 409: mismo identificador, OTRA pregunta", async () => {
  // Esto es mas importante que la cache. Sin el, un pago compra respuestas
  // ilimitadas.
  const DB = db();
  const h1 = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: { product_url: "https://a.example/p/1" } });
  const h2 = await huella({ aceptado: ACEPTADO, ruta: "/v1/check", cuerpo: { product_url: "https://a.example/p/2" } });
  await guardar({ DB }, { id: ID, huella: h1, cuerpo: { verdict: "YES" } });

  const r = await consultar({ DB }, ID, h2);
  assert.equal(r.conflicto, true);
  assert.equal(r.repetido, undefined);
});

test("caducado: se procesa como nuevo, no como repetido", async () => {
  const DB = db();
  const h = await huella({ aceptado: ACEPTADO, cuerpo: PREGUNTA });
  await guardar({ DB }, { id: ID, huella: h, cuerpo: { verdict: "YES" } }, "2020-01-01T00:00:00Z");
  assert.equal(await consultar({ DB }, ID, h, "2099-01-01T00:00:00Z"), null);
});

test("sin identificador no se guarda ni se consulta nada", async () => {
  const DB = db();
  assert.equal(await consultar({ DB }, null, "h"), null);
  assert.equal(await guardar({ DB }, { id: null, huella: "h", cuerpo: {} }), false);
  assert.equal(DB._f.size, 0);
});

test("los auxiliares historicos no lanzan si falla la base", async () => {
  // La puerta PR-2 usa `reclamar`, que sí falla cerrado; estos auxiliares se
  // conservan para compatibilidad y no conceden permiso monetario.
  const rota = { DB: { prepare: () => { throw new Error("base caida"); } } };
  assert.equal(await consultar(rota, ID, "h"), null);
  assert.equal(await guardar(rota, { id: ID, huella: "h", cuerpo: {} }), false);
});

test("PR-2: solo changes===1 concede la propiedad de la puerta", async () => {
  const DB = db();
  const primero = await reclamar({ DB }, { id: ID, huella: "h" }, "2026-09-21T00:00:00.000Z", "intento-1");
  const segundo = await reclamar({ DB }, { id: ID, huella: "h" }, "2026-09-21T00:00:01.000Z", "intento-2");
  assert.deepEqual(primero, { propietaria: true, attemptId: "intento-1" });
  assert.equal(segundo.enCurso, true);
});

test("PR-2: una excepción o changes ausente es error, nunca permiso ni derrota normal", async () => {
  const rota = { DB: { prepare: () => { throw new Error("base caida"); } } };
  assert.equal((await reclamar(rota, { id: ID, huella: "h" })).error, true);

  const sinChanges = { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: {} }) }) }) } };
  assert.equal((await reclamar(sinChanges, { id: ID, huella: "h" })).error, true);
});

test("PR-2: el resultado queda persistido antes de liquidar y luego se cierra", async () => {
  const DB = db();
  const p = await reclamar({ DB }, { id: ID, huella: "h" }, "2026-09-21T00:00:00.000Z", "intento-1");
  assert.equal(await prepararLiquidacion({ DB }, {
    id: ID, huella: "h", attemptId: p.attemptId, cuerpo: { verdict: "YES" },
  }), true);

  const durante = await consultar({ DB }, ID, "h");
  assert.equal(durante.enCurso, true, "no entrega antes de conocer el desenlace de /settle");

  assert.equal(await completar({ DB }, {
    id: ID, huella: "h", attemptId: p.attemptId, cuerpo: { verdict: "YES" },
    transaccion: "0xabc", estadoLiquidacion: "confirmed",
  }), true);
  const final = await consultar({ DB }, ID, "h");
  assert.equal(final.transaccion, "0xabc");
  assert.equal(final.estadoLiquidacion, "confirmed");
});

test("PR-2: solo la propietaria puede completar o liberar", async () => {
  const DB = db();
  await reclamar({ DB }, { id: ID, huella: "h" }, "2026-09-21T00:00:00.000Z", "intento-1");
  assert.equal(await completar({ DB }, {
    id: ID, huella: "h", attemptId: "intruso", cuerpo: {},
  }), false);
  assert.equal(await liberar({ DB }, { id: ID, huella: "h", attemptId: "intruso" }), false);
  assert.equal(await liberar({ DB }, { id: ID, huella: "h", attemptId: "intento-1" }), true);
});

test("barrido de caducados", async () => {
  const DB = db();
  const h = await huella({ aceptado: ACEPTADO, cuerpo: PREGUNTA });
  await guardar({ DB }, { id: ID, huella: h, cuerpo: {} }, "2020-01-01T00:00:00Z");
  assert.equal((await purgarCaducados({ DB }, "2099-01-01T00:00:00Z")).rows_affected, 1);
  assert.equal(DB._f.size, 0);
});
