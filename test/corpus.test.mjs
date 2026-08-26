// W14 — la captura del corpus, y la vía de borrado.
//
// La tabla existía desde el 25 de agosto sin una línea que escribiera en ella.
// Estas pruebas existen porque la decisión de Miguel (doc 40) fue guardar TODO
// el tráfico, y eso convierte dos cosas en imprescindibles:
//
//   · el filtro determinista de datos personales, y
//   · una vía de borrado por comercio que funcione a la primera.
//
// La prueba del borrado se ejecuta aquí con un caso inventado a propósito: la
// primera vez que se usa no puede ser con la reclamación real de un comercio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPII, capturePolicy, deleteMerchantCorpus, corpusStats } from "../src/corpus.mjs";

// ---------- filtro de datos personales ----------

test("PII: correo, teléfono, identificador fiscal e IBAN se marcan", () => {
  assert.deepEqual(detectPII("Contact returns@shop.com for help."), ["email"]);
  assert.deepEqual(detectPII("Call us at 415-555-0198 to arrange pickup."), ["phone"]);
  assert.deepEqual(detectPII("Reference 123-45-6789 on the form."), ["gov_id"]);
  assert.ok(detectPII("Refunds to ES91 2100 0418 4502 0005 1332.").includes("iban"));
});

test("PII EL MATIZ QUE IMPORTA: un número de pedido largo NO es una tarjeta", () => {
  // Sin la comprobación de Luhn, cada referencia larga de una página marcaría la
  // fila y el revisor dejaría de fiarse de la señal. Una alarma que salta siempre
  // es una alarma apagada.
  assert.ok(!detectPII("Order number 1234567890123 shipped.").includes("card"));
  assert.ok(detectPII("Card 4111 1111 1111 1111 was refunded.").includes("card"));
});

test("PII: una política normal, sin datos personales, no se marca", () => {
  assert.deepEqual(detectPII("Items may be returned within 30 days of delivery for a full refund."), []);
  assert.deepEqual(detectPII(""), []);
  assert.deepEqual(detectPII(null), []);
});

// ---------- base de datos falsa, en memoria ----------
// Suficiente para lo que estas pruebas comprueban: que se inserta, que no se
// duplica, que se encadenan versiones y que el borrado alcanza lo que dice.

function dbFalsa() {
  const filas = [];
  const usos = [];
  const cambios = [];
  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("INSERT INTO policy_corpus (")) {
      const [id, merchant_domain, merchant_name, country, source_url, source_kind, provenance,
             authorized_by, content, content_hash, content_chars, captured_at, effective_at,
             scope_general, scope_category, scope_product, scope_seller, scope_channel,
             scope_membership, review_state, pii_suspected, supersedes_id, client_ref,
             retention_until, deleted_at, parsed_days, parsed_category] = args;
      filas.push({ id, merchant_domain, merchant_name, country, source_url, source_kind, provenance,
        authorized_by, content, content_hash, content_chars, captured_at, effective_at, scope_general,
        scope_category, scope_product, scope_seller, scope_channel, scope_membership, review_state,
        pii_suspected, supersedes_id, client_ref, retention_until, deleted_at,
        parsed_days, parsed_category });
      return {};
    }
    if (s.startsWith("INSERT INTO policy_change")) { cambios.push({ id: args[0], merchant_domain: args[1], kind: args[5], summary: args[10] }); return {}; }
    if (s.startsWith("INSERT INTO policy_corpus_use")) {
      usos.push({ corpus_id: args[0], used_at: args[1], context_kind: args[2], verdict: args[4] });
      return {};
    }
    if (s.startsWith("UPDATE policy_corpus SET deleted_at")) {
      for (const f of filas) if (f.merchant_domain === args[1] && !f.deleted_at) f.deleted_at = args[0];
      return {};
    }
    if (s.startsWith("DELETE FROM policy_corpus_use")) {
      const ids = filas.filter((f) => f.merchant_domain === args[0]).map((f) => f.id);
      for (let i = usos.length - 1; i >= 0; i--) if (ids.includes(usos[i].corpus_id)) usos.splice(i, 1);
      return {};
    }
    if (s.startsWith("DELETE FROM policy_corpus WHERE merchant_domain")) {
      for (let i = filas.length - 1; i >= 0; i--) if (filas[i].merchant_domain === args[0]) filas.splice(i, 1);
      return {};
    }
    return {};
  };
  const first = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id FROM policy_corpus WHERE merchant_domain = ? AND content_hash"))
      return filas.find((f) => f.merchant_domain === args[0] && f.content_hash === args[1]) || null;
    if (s.startsWith("SELECT id, parsed_days, parsed_category FROM policy_corpus WHERE merchant_domain = ? AND deleted_at IS NULL"))
      return [...filas].reverse().find((f) => f.merchant_domain === args[0] && !f.deleted_at) || null;
    if (s.includes("COUNT(*) AS n FROM policy_corpus WHERE merchant_domain"))
      return { n: filas.filter((f) => f.merchant_domain === args[0] && !f.deleted_at).length };
    if (s.includes("COUNT(DISTINCT merchant_domain)"))
      return { n: new Set(filas.filter((f) => !f.deleted_at).map((f) => f.merchant_domain)).size };
    if (s.includes("pii_suspected = 1")) return { n: filas.filter((f) => !f.deleted_at && f.pii_suspected).length };
    if (s.includes("review_state = 'reviewed'")) return { n: filas.filter((f) => !f.deleted_at && f.review_state === "reviewed").length };
    if (s.includes("supersedes_id IS NOT NULL")) return { n: filas.filter((f) => !f.deleted_at && f.supersedes_id).length };
    if (s.includes("deleted_at IS NOT NULL")) return { n: filas.filter((f) => f.deleted_at).length };
    if (s.includes("COUNT(*) AS n FROM policy_corpus WHERE deleted_at IS NULL")) return { n: filas.filter((f) => !f.deleted_at).length };
    return {};
  };
  return {
    _filas: filas, _usos: usos, _cambios: cambios,
    prepare: (sql) => ({
      bind: (...args) => ({ run: async () => run(sql, args), first: async () => first(sql, args), all: async () => ({ results: [] }) }),
      run: async () => run(sql, []), first: async () => first(sql, []), all: async () => ({ results: [] }),
    }),
  };
}

const POLIZA = "Return Policy. Items may be returned within 30 days of delivery for a full refund to the original payment method.";
const URL1 = "https://shop.example.com/p/thing";

// ---------- captura ----------

test("captura: guarda la política con su dominio, su huella y su origen", async () => {
  const DB = dbFalsa();
  const id = await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied" });
  assert.ok(id);
  assert.equal(DB._filas.length, 1);
  const f = DB._filas[0];
  assert.equal(f.merchant_domain, "shop.example.com");
  assert.equal(f.source_kind, "page_text");
  assert.equal(f.provenance, "agent_supplied");   // lo aportó el agente, no lo cogimos nosotros
  assert.equal(f.content, POLIZA);                 // texto ORIGINAL, sin normalizar
  assert.equal(f.review_state, "unreviewed");
  assert.ok(f.retention_until > f.captured_at);
});

test("captura: la MISMA política no se duplica — y eso es la señal de que no ha cambiado", async () => {
  const DB = dbFalsa();
  const a = await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied" });
  const b = await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied" });
  assert.equal(a, b);
  assert.equal(DB._filas.length, 1);
});

test("captura EL PRODUCTO: una política que cambia crea una VERSIÓN nueva encadenada", async () => {
  // Nunca se sobrescribe. Este encadenado es lo que permite decir «Nike pasó ayer
  // de 60 a 30 días», que es justo lo que la caché de 24 h del competidor impide.
  const DB = dbFalsa();
  const v1 = await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied" });
  const v2 = await capturePolicy({ DB }, { policyText: POLIZA.replace("30 days", "14 days"), sourceUrl: URL1, via: "agent_supplied" });
  assert.notEqual(v1, v2);
  assert.equal(DB._filas.length, 2);
  assert.equal(DB._filas[1].supersedes_id, v1);
});

test("captura: el texto con datos personales se marca, pero SE GUARDA igual", async () => {
  // Opción B: se guarda todo. La marca es para el revisor, no un censor — una
  // política real lleva la dirección del comercio dentro.
  const DB = dbFalsa();
  await capturePolicy({ DB }, { policyText: POLIZA + " Questions? write to returns@shop.example.com.", sourceUrl: URL1, via: "agent_supplied" });
  assert.equal(DB._filas.length, 1);
  assert.equal(DB._filas[0].pii_suspected, 1);
});

test("captura: se guarda el HASH de la clave, nunca la clave", async () => {
  const DB = dbFalsa();
  await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied", apiKey: "rc_live_secreto" });
  const ref = DB._filas[0].client_ref;
  assert.equal(ref.length, 64);
  assert.ok(!ref.includes("secreto"));
});

test("captura: se puede apagar con una variable, sin tocar código", async () => {
  const DB = dbFalsa();
  await capturePolicy({ DB, CORPUS_CAPTURE: "false" }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied" });
  assert.equal(DB._filas.length, 0);
});

test("captura LA REGLA NÚMERO UNO: nunca rompe una consulta", async () => {
  // Vale más perder una fila del corpus que devolver un error al cliente por
  // guardarla. Si esto lanzara, la puerta se convertiría en un riesgo.
  const rota = { prepare: () => { throw new Error("D1 caído"); } };
  assert.equal(await capturePolicy({ DB: rota }, { policyText: POLIZA, sourceUrl: URL1, via: "agent_supplied" }), null);
  assert.equal(await capturePolicy(null, { policyText: POLIZA, sourceUrl: URL1 }), null);
  assert.equal(await capturePolicy({ DB: dbFalsa() }, { policyText: "corto", sourceUrl: URL1 }), null);
  assert.equal(await capturePolicy({ DB: dbFalsa() }, { policyText: POLIZA, sourceUrl: "no-es-una-url" }), null);
});

// ---------- borrado ----------

test("borrado EL ENSAYO: un comercio reclama y su corpus desaparece", async () => {
  // Se ejecuta con un caso inventado A PROPÓSITO. La primera vez que se use esta
  // vía no puede ser con la reclamación real de un comercio.
  const DB = dbFalsa();
  await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: "https://reclamante.example/p/1", via: "agent_supplied" });
  await capturePolicy({ DB }, { policyText: POLIZA + " Final sale excluded.", sourceUrl: "https://reclamante.example/p/2", via: "agent_supplied" });
  await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: "https://otro.example/p/1", via: "agent_supplied" });

  const r = await deleteMerchantCorpus({ DB }, "www.RECLAMANTE.example");   // se normaliza
  assert.equal(r.ok, true);
  assert.equal(r.domain, "reclamante.example");
  assert.equal(r.rows_affected, 2);
  assert.equal(r.mode, "soft_deleted");

  assert.equal(DB._filas.filter((f) => f.merchant_domain === "reclamante.example" && !f.deleted_at).length, 0);
  // Y no se ha llevado por delante a nadie más.
  assert.equal(DB._filas.filter((f) => f.merchant_domain === "otro.example" && !f.deleted_at).length, 1);
});

test("borrado: por defecto es LÓGICO, para poder deshacer un error", async () => {
  const DB = dbFalsa();
  await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: "https://x.example/p", via: "agent_supplied" });
  await deleteMerchantCorpus({ DB }, "x.example");
  assert.equal(DB._filas.length, 1);            // la fila sigue ahí
  assert.ok(DB._filas[0].deleted_at);           // pero marcada
});

test("borrado: el purgado físico hay que pedirlo, y se lleva también los usos", async () => {
  const DB = dbFalsa();
  await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: "https://x.example/p", via: "agent_supplied" });
  const r = await deleteMerchantCorpus({ DB }, "x.example", { purge: true });
  assert.equal(r.mode, "purged");
  assert.equal(DB._filas.length, 0);
});

test("borrado: sin dominio no borra nada", async () => {
  const DB = dbFalsa();
  const r = await deleteMerchantCorpus({ DB }, "  ");
  assert.equal(r.ok, false);
});

test("resumen: cuenta documentos, comercios, marcados y versiones", async () => {
  const DB = dbFalsa();
  await capturePolicy({ DB }, { policyText: POLIZA, sourceUrl: "https://a.example/p", via: "agent_supplied" });
  await capturePolicy({ DB }, { policyText: POLIZA.replace("30", "45"), sourceUrl: "https://a.example/p", via: "agent_supplied" });
  await capturePolicy({ DB }, { policyText: POLIZA + " Email returns@b.example.", sourceUrl: "https://b.example/p", via: "agent_supplied" });
  const s = await corpusStats({ DB });
  assert.equal(s.documents, 3);
  assert.equal(s.merchants, 2);
  assert.equal(s.pii_suspected, 1);
  assert.equal(s.superseding_versions, 1);
  assert.equal(s.reviewed, 0);
});

// ---------- W15: lo que el ensayo en producción destapó ----------

import { runCheck } from "../src/engine.mjs";

const envMotor = (DB, ia) => ({ DB, AI: { run: async () => ({ response: JSON.stringify(ia) }) } });
const IA_OK = {
  verdict: "YES_WITH_CONDITIONS", confidence: 0.9,
  answer_human: "Yes, within 30 days.", reason: null,
  // El modelo devuelve la URL ENTERA donde toca un host. Pasó de verdad.
  merchant_resolved: { name: "Shop", domain: "https://shop.example.com/p/thing", is_marketplace_third_party: false },
  policy: { return_category: "FiniteReturnWindow", merchant_return_days: 30, window_basis: "delivery_date",
            return_method: ["ReturnByMail"], return_fees: null, refund_type: "FullRefund" },
  evidence: { source_url: "https://shop.example.com/p/thing", clause_id: null,
              exact_clause: "Items may be returned within 30 days of delivery for a full refund to the original payment method." },
};
const PET = { product_url: "https://shop.example.com/p/thing", buyer_country: "US", item_condition: "unopened", page_text: POLIZA };

test("W15: merchant_resolved.domain sale como HOST aunque el modelo mande una URL", async () => {
  // Si esto queda como URL, un cliente que pida el borrado usando ese campo no
  // casaría con nada: la columna del corpus guarda el host limpio.
  const r = await runCheck(envMotor(dbFalsa(), IA_OK), PET);
  assert.equal(r.merchant_resolved.domain, "shop.example.com");
});

test("W15 LA CONTAMINACIÓN QUE HABÍA: el banco de pruebas NO entra en el corpus", async () => {
  // Una pasada de /eval son 18 o 25 documentos sintéticos escritos por nosotros.
  // El corpus es el material del que salen los avisos de cambio de política;
  // llenarlo de casos falsos lo estropea justo en lo que lo hace valioso.
  const DB = dbFalsa();
  await runCheck(envMotor(DB, IA_OK), { ...PET, __no_corpus: true });
  assert.equal(DB._filas.length, 0);
});

test("W15: una consulta normal SÍ sigue capturando", async () => {
  const DB = dbFalsa();
  const r = await runCheck(envMotor(DB, IA_OK), PET);
  assert.equal(DB._filas.length, 1);
  assert.equal(DB._filas[0].merchant_domain, "shop.example.com");
  assert.equal(r.meta.corpus_id, DB._filas[0].id);
});
