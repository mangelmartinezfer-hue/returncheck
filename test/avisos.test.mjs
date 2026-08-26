// W16 — avisos de cambio de política.
//
// La idea es de Miguel (doc 45 §5): a un robot no se le puede llamar, así que se
// le da la vuelta — que nos pidan ellos que les avisemos. Un integrador registra
// los dominios que le importan y le espera «Nike pasó ayer de 60 a 30 días».
//
// Lo que estas pruebas vigilan de verdad es el TEXTO del aviso. Es lo único que
// el cliente lee, y es lo que separa un producto de una notificación que se
// ignora: «algo cambió» no vale para nada; «pasó de 60 a 30 días» se puede
// programar contra ello.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChange, normalizeDomain, addWatch, removeWatch, listWatches, changesFor } from "../src/watch.mjs";

// ---------- el texto del aviso ----------

test("aviso EL URGENTE: acortar la ventana se dice con todas las letras", () => {
  // Es la única noticia que puede costarle dinero a alguien: creía tener 60 días
  // y tiene 30. Por eso va primero en la clasificación.
  const c = classifyChange({ days: 60 }, { days: 30 }, "nike.com");
  assert.equal(c.kind, "window_shortened");
  assert.match(c.summary, /nike\.com/);
  assert.match(c.summary, /from 60 to 30 days/);
});

test("aviso: alargar la ventana también se avisa, pero es otra cosa", () => {
  const c = classifyChange({ days: 30 }, { days: 60 }, "shop.com");
  assert.equal(c.kind, "window_extended");
  assert.match(c.summary, /extended from 30 to 60/);
});

test("aviso: aparece o desaparece una ventana donde no la había", () => {
  assert.equal(classifyChange({ days: null }, { days: 30 }, "a.com").kind, "window_added");
  assert.equal(classifyChange({ days: 30 }, { days: null }, "a.com").kind, "window_removed");
});

test("aviso: cambia la categoría con la misma ventana", () => {
  const c = classifyChange({ days: null, category: "FiniteReturnWindow" },
                           { days: null, category: "NotPermitted" }, "a.com");
  assert.equal(c.kind, "category_changed");
  assert.match(c.summary, /from FiniteReturnWindow to NotPermitted/);
});

test("aviso EL MATIZ QUE IMPORTA: si solo cambió la redacción, se dice que solo cambió la redacción", () => {
  // Se registra igual —puede importar— pero NUNCA se puede leer como un cambio de
  // condiciones. Un aviso que exagera se deja de leer a la tercera vez.
  const c = classifyChange({ days: 30, category: "FiniteReturnWindow" },
                           { days: 30, category: "FiniteReturnWindow" }, "a.com");
  assert.equal(c.kind, "text_only");
  assert.match(c.summary, /unchanged/);
});

test("dominio: se normaliza venga como venga", () => {
  assert.equal(normalizeDomain("https://www.Nike.com/returns"), "nike.com");
  assert.equal(normalizeDomain("WWW.NIKE.COM"), "nike.com");
  assert.equal(normalizeDomain("nike.com"), "nike.com");
  assert.equal(normalizeDomain("   "), null);
  assert.equal(normalizeDomain(null), null);
});

// ---------- suscripciones, con una base falsa ----------

function db() {
  const watches = [];
  const changes = [];
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("INSERT INTO policy_watch"))
      watches.push({ id: a[0], client_ref: a[1], merchant_domain: a[2], created_at: a[3], active: 1 });
    if (s.startsWith("UPDATE policy_watch SET active = 1"))
      for (const w of watches) if (w.id === a[0]) w.active = 1;
    if (s.startsWith("UPDATE policy_watch SET active = 0"))
      for (const w of watches) if (w.client_ref === a[0] && w.merchant_domain === a[1]) w.active = 0;
    if (s.startsWith("INSERT INTO policy_change"))
      changes.push({ id: a[0], merchant_domain: a[1], detected_at: a[4], kind: a[5],
                     days_before: a[6], days_after: a[7], category_before: a[8],
                     category_after: a[9], summary: a[10] });
    return {};
  };
  const first = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id FROM policy_watch"))
      return watches.find((w) => w.client_ref === a[0] && w.merchant_domain === a[1]) || null;
    return null;
  };
  const all = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT merchant_domain, created_at FROM policy_watch"))
      return { results: watches.filter((w) => w.client_ref === a[0] && w.active === 1) };
    if (s.startsWith("SELECT c.id")) {
      const [ref, since] = a;
      const míos = new Set(watches.filter((w) => w.client_ref === ref && w.active === 1).map((w) => w.merchant_domain));
      return { results: changes
        .filter((c) => míos.has(c.merchant_domain))
        .filter((c) => !since || c.detected_at > since)
        .sort((x, y) => (x.detected_at < y.detected_at ? 1 : -1))
        .slice(0, a[3]) };
    }
    return { results: [] };
  };
  return { _w: watches, _c: changes,
    prepare: (sql) => ({ bind: (...a) => ({ run: async () => run(sql, a), first: async () => first(sql, a), all: async () => all(sql, a) }) }) };
}

const REF = "hash-de-la-clave-del-cliente";

test("suscripción: se registra un dominio y se lista", async () => {
  const DB = db();
  const r = await addWatch({ DB }, REF, "https://www.Nike.com/help/returns");
  assert.equal(r.ok, true);
  assert.equal(r.domain, "nike.com");         // normalizado
  assert.equal(r.created, true);
  assert.deepEqual((await listWatches({ DB }, REF)).map((x) => x.domain), ["nike.com"]);
});

test("suscripción EL DETALLE PARA MÁQUINAS: pedir dos veces lo mismo no es un error", async () => {
  // Un programa que reintenta no debe encontrarse un 409 que haya que rodear con
  // código. Repetir la petición reactiva y devuelve el mismo id.
  const DB = db();
  const a = await addWatch({ DB }, REF, "nike.com");
  const b = await addWatch({ DB }, REF, "www.nike.com");
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  assert.equal(DB._w.length, 1);
});

test("suscripción: darse de baja y volver a darse de alta", async () => {
  const DB = db();
  await addWatch({ DB }, REF, "nike.com");
  await removeWatch({ DB }, REF, "nike.com");
  assert.equal((await listWatches({ DB }, REF)).length, 0);
  await addWatch({ DB }, REF, "nike.com");
  assert.equal((await listWatches({ DB }, REF)).length, 1);
});

test("cambios: solo se ven los de los dominios que ESTE cliente vigila", async () => {
  // Si esto fallara, un cliente vería la actividad de comercios que otro está
  // vigilando. Es una fuga, no un detalle de filtrado.
  const DB = db();
  await addWatch({ DB }, REF, "nike.com");
  DB._c.push({ id: "c1", merchant_domain: "nike.com", detected_at: "2026-08-26T10:00:00Z", kind: "window_shortened", summary: "nike.com: shortened" });
  DB._c.push({ id: "c2", merchant_domain: "otro.com", detected_at: "2026-08-26T11:00:00Z", kind: "window_shortened", summary: "otro.com: shortened" });
  const r = await changesFor({ DB }, REF);
  assert.equal(r.count, 1);
  assert.equal(r.changes[0].merchant_domain, "nike.com");
});

test("cambios: `since` deja fuera lo que el cliente ya vio", async () => {
  const DB = db();
  await addWatch({ DB }, REF, "nike.com");
  DB._c.push({ id: "c1", merchant_domain: "nike.com", detected_at: "2026-08-25T10:00:00Z", summary: "viejo", kind: "text_only" });
  DB._c.push({ id: "c2", merchant_domain: "nike.com", detected_at: "2026-08-26T10:00:00Z", summary: "nuevo", kind: "window_shortened" });
  const r = await changesFor({ DB }, REF, { since: "2026-08-25T23:00:00Z" });
  assert.equal(r.count, 1);
  assert.equal(r.changes[0].id, "c2");
});

test("cambios: el cursor de la próxima llamada viene ya calculado", async () => {
  // Que el cliente no tenga que deducirlo de la lista es la diferencia entre una
  // API que se integra en diez minutos y una que se integra en una tarde.
  const DB = db();
  await addWatch({ DB }, REF, "nike.com");
  DB._c.push({ id: "c1", merchant_domain: "nike.com", detected_at: "2026-08-26T10:00:00Z", summary: "x", kind: "text_only" });
  const r = await changesFor({ DB }, REF);
  assert.equal(r.next_since, "2026-08-26T10:00:00Z");
  // Y sin cambios nuevos, el cursor no se mueve.
  const r2 = await changesFor({ DB }, REF, { since: r.next_since });
  assert.equal(r2.count, 0);
  assert.equal(r2.next_since, r.next_since);
});

test("cambios: sin suscripciones no se ve nada, aunque haya cambios", async () => {
  const DB = db();
  DB._c.push({ id: "c1", merchant_domain: "nike.com", detected_at: "2026-08-26T10:00:00Z", summary: "x", kind: "text_only" });
  assert.equal((await changesFor({ DB }, REF)).count, 0);
});
