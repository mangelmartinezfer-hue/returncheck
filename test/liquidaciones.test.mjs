// W57 — REGISTRO DE LIQUIDACIONES.
//
// LO QUE VIGILAN ESTAS PRUEBAS. El 3 de septiembre de 2026, al comprobar el lado
// servidor del primer pago real, salio que `answer_log` —el registro que dura 12
// meses— no tiene ninguna columna de cadena, y que el unico enlace entre la
// respuesta y la transaccion vivia en `payment_idempotency`: una fila que solo
// se escribe si el comprador manda la extension `payment-identifier` (invencion
// nuestra, opcional) y que ademas caduca a las 24 horas.
//
// O sea que un agente que pagase sin esa extension no dejaba NI UNA LINEA que
// uniera lo que respondimos con lo que nos pago.
//
// LO QUE ESTO NO ARREGLA, y esta escrito aqui para que no se lea de mas: la
// asociacion sigue siendo una afirmacion NUESTRA. La transaccion no lleva el
// check_id y `transferWithAuthorization` no tiene campo libre donde meterlo. Un
// tercero puede comprobar el pago; no puede comprobar que ese pago pagara esta
// respuesta.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluarCoherencia, registrarLiquidacion, liquidacionDe,
  liquidacionesSinConfirmar, purgarLiquidacionesCaducadas,
} from "../src/liquidaciones.mjs";

// Una D1 de mentira que respeta lo unico que importa aqui: que la clave primaria
// sea check_id y que INSERT OR IGNORE no pise la fila que ya esta.
function db() {
  const filas = new Map();
  return {
    _f: filas,
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => filas.get(a[0]) || null,
        all: async () => ({
          results: [...filas.values()]
            .filter((f) => ["pending", "unconfirmed"].includes(f.status))
            .sort((x, y) => (x.settled_at < y.settled_at ? 1 : -1)),
        }),
        run: async () => {
          const s = sql.replace(/\s+/g, " ").trim();
          if (s.startsWith("INSERT OR IGNORE INTO settlement_log")) {
            if (filas.has(a[0])) return { meta: { changes: 0 } };   // no duplica
            const [check_id, settled_at, status, transaction_hash, network, payer,
                   amount_atomic, asset, nonce, pay_to, mismatch, retention_until] = a;
            filas.set(check_id, { check_id, settled_at, status, transaction_hash, network,
              payer, amount_atomic, asset, nonce, pay_to, mismatch, retention_until });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("DELETE FROM settlement_log")) {
            let n = 0;
            for (const [k, v] of filas)
              if (v.retention_until && v.retention_until < a[0]) { filas.delete(k); n++; }
            return { meta: { changes: n } };
          }
          return { meta: { changes: 0 } };
        },
      }),
    }),
  };
}

const ENV = (DB) => ({ DB, ANSWER_RETENTION_MONTHS: "12" });
const PAYER = "0xce4fbd6ea0d2e73a8d8959b4c8e28ec39bd3c236";
const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX = "0xbdbac71fa9a41f13e7e028f80f75c3a59c14e6a33831d3efcbd6107b03e68ce3";
const NONCE = "0x4748f83dd8b3f1ad933f056181b085e3d1b006556fc909feb23f9350f6f4d5c6";

const ACEPTADO = { scheme: "exact", network: "eip155:8453", amount: "20000",
                   asset: ASSET, payTo: PAY_TO };
const AUTORIZACION = { from: PAYER, to: PAY_TO, value: "20000",
                       validAfter: "0", validBefore: "1893456000", nonce: NONCE };
const LIQUIDADO = { cobrado: true, transaccion: TX, red: "eip155:8453", pagador: PAYER };

// ---------------------------------------------------------------------------
// La regla de coherencia, que es la parte con criterio
// ---------------------------------------------------------------------------

test("W57: todo cuadra -> confirmed, sin mismatch", () => {
  const r = evaluarCoherencia({ estado: "confirmed", liquidacion: LIQUIDADO,
    autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  assert.equal(r.estado, "confirmed");
  assert.equal(r.mismatch, null);
});

test("W57: el pagador que declara el facilitador NO es quien firmo -> unconfirmed", () => {
  // Si no se comprobara, publicariamos como pagador a alguien que no lo es.
  const r = evaluarCoherencia({ estado: "confirmed",
    liquidacion: { ...LIQUIDADO, pagador: "0x0000000000000000000000000000000000000bad" },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  assert.equal(r.estado, "unconfirmed");
  assert.equal(r.mismatch, "payer");
});

test("W57: la red liquidada no es la pedida -> unconfirmed", () => {
  const r = evaluarCoherencia({ estado: "confirmed",
    liquidacion: { ...LIQUIDADO, red: "eip155:84532" },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  assert.equal(r.estado, "unconfirmed");
  assert.equal(r.mismatch, "network");
});

test("W57: lo firmado no es lo pedido -> unconfirmed", () => {
  const r = evaluarCoherencia({ estado: "confirmed", liquidacion: LIQUIDADO,
    autorizacion: { ...AUTORIZACION, value: "1" }, aceptado: ACEPTADO });
  assert.equal(r.estado, "unconfirmed");
  assert.equal(r.mismatch, "amount");
});

test("W57: confirmado SIN hash no es confirmable", () => {
  const r = evaluarCoherencia({ estado: "confirmed",
    liquidacion: { ...LIQUIDADO, transaccion: "" },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  assert.equal(r.estado, "unconfirmed");
  assert.equal(r.mismatch, "transaction");
});

test("W57: varios descuadres se anotan TODOS, no solo el primero", () => {
  const r = evaluarCoherencia({ estado: "confirmed",
    liquidacion: { ...LIQUIDADO, red: "eip155:84532", pagador: "0xbad" },
    autorizacion: { ...AUTORIZACION, value: "1" }, aceptado: ACEPTADO });
  assert.equal(r.estado, "unconfirmed");
  assert.deepEqual(r.mismatch.split(","), ["network", "payer", "amount"]);
});

test("W57: pending y unconfirmed se conservan tal cual; no se auditan ni se ascienden", () => {
  for (const estado of ["pending", "unconfirmed"]) {
    const r = evaluarCoherencia({ estado,
      liquidacion: { cobrado: false, transaccion: "", red: "", pagador: null },
      autorizacion: AUTORIZACION, aceptado: ACEPTADO });
    assert.equal(r.estado, estado, "un 'no lo se' no se convierte en otra cosa");
    assert.equal(r.mismatch, null);
  }
});

test("W57: la comparacion de direcciones no distingue mayusculas", () => {
  const r = evaluarCoherencia({ estado: "confirmed",
    liquidacion: { ...LIQUIDADO, pagador: PAYER.toUpperCase().replace("0X", "0x") },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  assert.equal(r.estado, "confirmed");
});

test("W57: el importe se compara como TEXTO, no como numero", () => {
  // 20000 y "20000.0" son el mismo numero y NO son las mismas unidades atomicas.
  const r = evaluarCoherencia({ estado: "confirmed", liquidacion: LIQUIDADO,
    autorizacion: { ...AUTORIZACION, value: "20000.0" }, aceptado: ACEPTADO });
  assert.equal(r.mismatch, "amount");
});

// ---------------------------------------------------------------------------
// La escritura
// ---------------------------------------------------------------------------

test("W57: se guardan los ocho datos pedidos, con el check_id de enlace", async () => {
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "chk-1", estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO,
    ahora: "2026-09-03T17:08:00.000Z" });

  const f = await liquidacionDe(ENV(DB), "chk-1");
  assert.equal(f.check_id, "chk-1");
  assert.equal(f.status, "confirmed");
  assert.equal(f.transaction_hash, TX);
  assert.equal(f.network, "eip155:8453");
  assert.equal(f.payer, PAYER);
  assert.equal(f.amount_atomic, "20000");
  assert.equal(f.asset, ASSET);
  assert.equal(f.nonce, NONCE);
  assert.equal(f.settled_at, "2026-09-03T17:08:00.000Z");
  assert.equal(f.pay_to, PAY_TO);
  assert.equal(f.mismatch, null);
});

test("W57 EL AGUJERO QUE CIERRA: se guarda SIN payment-identifier", async () => {
  // El pago no trae extensions. Antes de W57 esto no dejaba ninguna correlacion.
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "chk-sin-id", estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  const f = await liquidacionDe(ENV(DB), "chk-sin-id");
  assert.ok(f, "la evidencia no puede depender de una extension opcional del comprador");
  assert.equal(f.transaction_hash, TX);
});

test("W57: la retencion es de 12 meses, la misma que la respuesta", async () => {
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "chk-ret", estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO,
    ahora: "2026-09-03T17:08:00.000Z" });
  const f = await liquidacionDe(ENV(DB), "chk-ret");
  assert.equal(f.retention_until, "2027-09-03T17:08:00.000Z");
});

test("W57: un reintento NO duplica la fila", async () => {
  const DB = db();
  const uno = { checkId: "chk-2", estado: "confirmed", liquidacion: LIQUIDADO,
                autorizacion: AUTORIZACION, aceptado: ACEPTADO };
  await registrarLiquidacion(ENV(DB), uno);
  await registrarLiquidacion(ENV(DB), { ...uno, estado: "pending" });
  assert.equal(DB._f.size, 1);
  assert.equal((await liquidacionDe(ENV(DB), "chk-2")).status, "confirmed",
    "la primera manda: la clave primaria es el check_id");
});

test("W57: un confirmado que no se sostiene se GUARDA como unconfirmed, con el motivo", async () => {
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "chk-3", estado: "confirmed",
    liquidacion: { ...LIQUIDADO, pagador: "0x0000000000000000000000000000000000000bad" },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO });
  const f = await liquidacionDe(ENV(DB), "chk-3");
  assert.equal(f.status, "unconfirmed");
  assert.equal(f.mismatch, "payer");
});

test("W57: pending y unconfirmed se guardan, que es cuando mas falta hace la fila", async () => {
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "chk-p", estado: "pending",
    liquidacion: { cobrado: false, pendiente: true, transaccion: TX, red: "eip155:8453", pagador: null },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO, ahora: "2026-09-03T10:00:00.000Z" });
  await registrarLiquidacion(ENV(DB), { checkId: "chk-u", estado: "unconfirmed",
    liquidacion: { cobrado: false, pendiente: true, incierto: true, transaccion: "", red: "", pagador: null },
    autorizacion: AUTORIZACION, aceptado: ACEPTADO, ahora: "2026-09-03T11:00:00.000Z" });

  const sinConfirmar = await liquidacionesSinConfirmar(ENV(DB));
  assert.equal(sinConfirmar.length, 2);
  // Sin red propia, se anota la que se pidio; sin pagador, quien firmo.
  const u = await liquidacionDe(ENV(DB), "chk-u");
  assert.equal(u.network, "eip155:8453");
  assert.equal(u.payer, PAYER);
  assert.equal(u.transaction_hash, null);
});

test("W57: sin check_id no se escribe nada", async () => {
  const DB = db();
  assert.equal(await registrarLiquidacion(ENV(DB), { checkId: null, estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO }), null);
  assert.equal(DB._f.size, 0, "una fila sin enlace con la respuesta no sirve para nada");
});

test("W57: sin estado no se escribe nada (UNKNOWN nunca llega aqui)", async () => {
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "chk-x", estado: null,
    liquidacion: null, autorizacion: null, aceptado: ACEPTADO });
  assert.equal(DB._f.size, 0);
});

test("W57: NUNCA rompe una consulta, pase lo que pase con la base", async () => {
  const roto = { DB: { prepare: () => { throw new Error("D1 caida"); } } };
  assert.equal(await registrarLiquidacion(roto, { checkId: "chk-4", estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO }), null);
  assert.equal(await liquidacionDe(roto, "chk-4"), null);
  assert.deepEqual(await liquidacionesSinConfirmar(roto), []);
  assert.equal(await registrarLiquidacion(null, { checkId: "chk-4", estado: "confirmed" }), null);
});

test("W57: el barrido de retencion se lleva lo caducado y respeta lo vigente", async () => {
  const DB = db();
  await registrarLiquidacion(ENV(DB), { checkId: "viejo", estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO,
    ahora: "2024-01-01T00:00:00.000Z" });
  await registrarLiquidacion(ENV(DB), { checkId: "nuevo", estado: "confirmed",
    liquidacion: LIQUIDADO, autorizacion: AUTORIZACION, aceptado: ACEPTADO,
    ahora: "2026-09-03T00:00:00.000Z" });
  const r = await purgarLiquidacionesCaducadas(ENV(DB), "2026-09-03T12:00:00.000Z");
  assert.equal(r.rows_affected, 1);
  assert.ok(await liquidacionDe(ENV(DB), "nuevo"));
  assert.equal(await liquidacionDe(ENV(DB), "viejo"), null);
});
