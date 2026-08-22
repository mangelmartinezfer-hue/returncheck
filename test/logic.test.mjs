import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRequest, checkInvariants } from "../src/contract.mjs";
import { applyDeadline } from "../src/decision.mjs";
import { chargeAtomic, markFree } from "../src/billing.mjs";
import { addDays, normalizeUrl, newApiKey } from "../src/util.mjs";

// ---------- Validación de entrada ----------
test("request válida pasa", () => {
  const r = validateRequest({ product_url: "https://x.com/p/1", buyer_country: "US", item_condition: "unopened" });
  assert.equal(r.ok, true);
});
test("rechaza sin product_url y país mal formado", () => {
  assert.equal(validateRequest({ buyer_country: "US" }).ok, false);
  assert.equal(validateRequest({ product_url: "https://x.com", buyer_country: "usa" }).ok, false);
  assert.equal(validateRequest({ product_url: "not-a-url", buyer_country: "US" }).ok, false);
});

// ---------- Invariantes de salida ----------
test("UNKNOWN exige policy/evidence null y reason", () => {
  const good = { schema_version: "1.0", verdict: "UNKNOWN", returnable: null, policy: null, evidence: null, reason: "x" };
  assert.equal(checkInvariants(good).ok, true);
  const bad = { ...good, policy: {} };
  assert.equal(checkInvariants(bad).ok, false);
});
test("veredicto determinante exige policy+evidence con fuente", () => {
  const base = { schema_version: "1.0", verdict: "NO", returnable: false,
    policy: { return_category: "NotPermitted" },
    evidence: { source_url: "u", exact_clause: "c", verified_on: "2026-08-22", policy_version: "abc" } };
  assert.equal(checkInvariants(base).ok, true);
  const noEv = { ...base, evidence: null };
  assert.equal(checkInvariants(noEv).ok, false);
});

// ---------- Fecha límite / ventana vencida ----------
test("recomputa deadline y NO flipea si sigue en ventana", () => {
  const resp = { verdict: "YES_WITH_CONDITIONS", returnable: true, policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, deadline_date: null } };
  const out = applyDeadline(structuredClone(resp), { purchase_date: "2026-08-01" }, "2026-08-10");
  assert.equal(out.policy.deadline_date, "2026-08-31");
  assert.equal(out.verdict, "YES_WITH_CONDITIONS");
});
test("ventana vencida flipea a NO", () => {
  const resp = { verdict: "YES_WITH_CONDITIONS", returnable: true, policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, deadline_date: null } };
  const out = applyDeadline(structuredClone(resp), { purchase_date: "2026-06-01" }, "2026-08-10");
  assert.equal(out.verdict, "NO");
  assert.equal(out.returnable, false);
});

// ---------- Utilidades ----------
test("addDays y normalizeUrl", () => {
  assert.equal(addDays("2026-08-01", 30), "2026-08-31");
  assert.equal(normalizeUrl("https://a.com/p?utm_source=x&id=5#frag"), "https://a.com/p?id=5");
});
test("newApiKey formato", () => {
  assert.match(newApiKey(), /^rc_live_[0-9a-f]{48}$/);
});

// ---------- COBRO ATÓMICO (el bug que arreglamos) ----------
// D1 falso: un solo saldo. El UPDATE con guarda WHERE balance>=coste replica
// la semántica atómica de SQLite (changes=1 solo si había saldo).
function fakeDB(initialBalance) {
  const state = { balance: initialBalance, charged: 0, free: 0 };
  return {
    _state: state,
    prepare(sql) {
      return {
        _sql: sql, _args: [],
        bind(...a) { this._args = a; return this; },
        async run() {
          if (/UPDATE clients SET balance_usd = balance_usd - \?1/.test(this._sql)) {
            const amount = this._args[0];
            if (state.balance >= amount) { state.balance -= amount; state.charged++; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/calls_free = calls_free \+ 1/.test(this._sql)) { state.free++; return { meta: { changes: 1 } }; }
          if (/INSERT INTO ledger/.test(this._sql)) return { meta: { changes: 1 } };
          return { meta: { changes: 0 } };
        },
        async first() {
          if (/SELECT balance_usd FROM clients/.test(this._sql)) return { balance_usd: state.balance };
          return null;
        },
      };
    },
  };
}

test("cobro atómico descuenta una vez y devuelve saldo", async () => {
  const env = { DB: fakeDB(0.02) };
  const r = await chargeAtomic(env, "k", 0.02, "ref");
  assert.equal(r.charged, true);
  assert.equal(Math.round(r.remaining * 1000) / 1000, 0);
});

test("NO permite sobregiro: dos cobros con saldo para uno -> el segundo falla", async () => {
  const env = { DB: fakeDB(0.02) };
  const a = await chargeAtomic(env, "k", 0.02, "r1");
  const b = await chargeAtomic(env, "k", 0.02, "r2");
  assert.equal(a.charged, true);
  assert.equal(b.charged, false);          // <- el saldo nunca queda negativo
  assert.equal(env.DB._state.balance, 0);
  assert.equal(env.DB._state.charged, 1);  // solo se cobró una vez
});

test("markFree no toca saldo", async () => {
  const env = { DB: fakeDB(0.02) };
  await markFree(env, "k");
  assert.equal(env.DB._state.balance, 0.02);
  assert.equal(env.DB._state.free, 1);
});
