// W19 — registro de respuestas.
//
// Lo que estas pruebas vigilan de verdad no es que se escriba una fila: es que la
// fila sirva para lo único que justifica su existencia — que ante un «el martes
// me respondisteis mal a esto» se pueda REPRODUCIR la respuesta. Eso exige tres
// cosas: el enlace a la versión exacta de la política, las entradas que movieron
// el veredicto, y la cita que dimos.
//
// Y vigilan la otra mitad, que es la que puede meternos en un problema: que no se
// cuele en la base nada que prometimos no guardar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeUrl, recordAnswer, markAnswerCharged, findAnswers, purgeExpiredAnswers } from "../src/answerlog.mjs";

// Base falsa mínima: guarda las filas y sabe leerlas.
function db() {
  const filas = [];
  const cols = (sql) => {
    const m = sql.match(/INSERT INTO answer_log \(([\s\S]*?)\) VALUES/);
    return m[1].split(",").map((s) => s.trim()).filter(Boolean);
  };
  return {
    _f: filas,
    prepare: (sql) => ({
      bind: (...a) => ({
        run: async () => {
          const s = sql.replace(/\s+/g, " ").trim();
          if (s.startsWith("INSERT INTO answer_log")) {
            const nombres = cols(sql);
            const fila = {};
            nombres.forEach((n, idx) => { fila[n] = a[idx]; });
            filas.push(fila);
          }
          if (s.startsWith("UPDATE answer_log SET charged")) {
            for (const f of filas) if (f.id === a[2]) { f.charged = a[0]; f.price_usd = a[1]; }
          }
          if (s.startsWith("DELETE FROM answer_log WHERE retention_until")) {
            let n = 0;
            for (let k = filas.length - 1; k >= 0; k--)
              if (filas[k].retention_until && filas[k].retention_until < a[0]) { filas.splice(k, 1); n++; }
            return { meta: { changes: n } };
          }
          return { meta: { changes: 0 } };
        },
        all: async () => ({ results: filas.slice().reverse() }),
        first: async () => filas[0] || null,
      }),
    }),
  };
}

const RESP = {
  verdict: "NO",
  returnable: false,
  confidence: 0.9,
  checked_via: "agent_supplied",
  reason: "Return window elapsed: deadline was 2026-01-31.",
  policy: { merchant_return_days: 30, return_category: "FiniteReturnWindow",
            window_basis: "purchase_date", deadline_date: "2026-01-31" },
  evidence: { exact_clause: "Items may be returned within 30 days of purchase.",
              source_url: "https://www.tienda.example/returns" },
  meta: { corpus_id: "corp-1" },
};

const REQ = {
  product_url: "https://tienda.example/p/123?session=abc123&utm_source=x",
  buyer_country: "US", buyer_state: "CA", item_condition: "opened",
  reason: "changed_mind", membership: "none", purchase_channel: "online",
  purchase_date: "2026-01-01",
  __api_key: "rc_live_LA_CLAVE_SECRETA",
};

// ---------- lo que hace útil el registro ----------

test("LO QUE JUSTIFICA LA TABLA: la respuesta queda reproducible", async () => {
  const DB = db();
  const id = await recordAnswer({ DB }, { resp: RESP, req: REQ, apiKey: REQ.__api_key, build: "w19" });
  assert.ok(id);
  const f = DB._f[0];
  // El enlace a la version EXACTA de la politica que leimos.
  assert.equal(f.corpus_id, "corp-1");
  // Las entradas que movieron el veredicto. Sin la fecha de compra, una queja
  // sobre una ventana vencida no se puede resolver.
  assert.equal(f.purchase_date, "2026-01-01");
  assert.equal(f.buyer_state, "CA");
  assert.equal(f.item_condition, "opened");
  // Y lo que respondimos, con la cita literal y el porque.
  assert.equal(f.verdict, "NO");
  assert.equal(f.return_days, 30);
  assert.equal(f.deadline_date, "2026-01-31");
  assert.match(f.exact_clause, /within 30 days/);
  assert.equal(f.build, "w19");
});

test("EL DETALLE QUE LO HACE USABLE: el guardian que disparo queda anotado", async () => {
  // Sin esto, un UNKNOWN es indistinguible de otro y no se puede explicar al
  // cliente POR QUE no respondimos.
  const DB = db();
  const resp = { ...RESP, verdict: "UNKNOWN", policy: null, evidence: null,
                 meta: { guard: { name: "jurisdiction_conditional", rejected_clause: "Where permitted by state law..." } } };
  await recordAnswer({ DB }, { resp, req: REQ, apiKey: REQ.__api_key, build: "w19" });
  assert.equal(DB._f[0].guard_name, "jurisdiction_conditional");
  assert.match(DB._f[0].guard_rejected_clause, /state law/);
});

// ---------- lo que NO puede colarse ----------

test("LA PROMESA PUBLICA: la clave de API no se guarda nunca, solo su huella", async () => {
  const DB = db();
  await recordAnswer({ DB }, { resp: RESP, req: REQ, apiKey: REQ.__api_key, build: "w19" });
  const f = DB._f[0];
  assert.notEqual(f.client_ref, REQ.__api_key);
  assert.equal(f.client_ref.length, 64);              // sha-256 completo
  assert.equal(JSON.stringify(f).includes("LA_CLAVE_SECRETA"), false);
});

test("URL: se corta en el ? porque ahi viajan los identificadores de sesion", () => {
  assert.equal(sanitizeUrl("https://tienda.example/p/123?session=abc&utm_source=x"),
               "https://tienda.example/p/123");
  assert.equal(sanitizeUrl("  "), null);
});

test("URL EL CASO FEO: si la RUTA huele a dato personal, solo se guarda el origen", async () => {
  // Hay tiendas que meten el correo en la ruta. Perder la ruta es barato;
  // guardar el correo de un comprador en nuestra base, no.
  assert.equal(sanitizeUrl("https://tienda.example/cuenta/ana.perez@correo.com/pedido"),
               "https://tienda.example");
});

test("el registro NUNCA rompe una consulta", async () => {
  // Regla 1, la misma que el corpus. Si la base falla, el cliente no se entera.
  const rota = { prepare: () => { throw new Error("base caida"); } };
  const id = await recordAnswer({ DB: rota }, { resp: RESP, req: REQ, build: "w19" });
  assert.equal(id, null);
  // Y sin base tampoco lanza.
  assert.equal(await recordAnswer({}, { resp: RESP, req: REQ }), null);
});

test("se puede apagar sin desplegar", async () => {
  const DB = db();
  await recordAnswer({ DB, ANSWER_LOG: "false" }, { resp: RESP, req: REQ, build: "w19" });
  assert.equal(DB._f.length, 0);
});

// ---------- cobro y retencion ----------

test("el cobro queda anotado: 'me cobrasteis por una respuesta mala' se puede mirar", async () => {
  const DB = db();
  const id = await recordAnswer({ DB }, { resp: RESP, req: REQ, build: "w19" });
  assert.equal(DB._f[0].charged, null);              // sin resolver al escribir
  await markAnswerCharged({ DB }, id, 0.02, true);
  assert.equal(DB._f[0].charged, 1);
  assert.equal(DB._f[0].price_usd, 0.02);
});

test("RETENCION: prometer 12 meses y no tener el barrido es peor que no prometerlo", async () => {
  const DB = db();
  await recordAnswer({ DB, ANSWER_RETENTION_MONTHS: "12" }, { resp: RESP, req: REQ, build: "w19" });
  const f = DB._f[0];
  assert.ok(f.retention_until);
  assert.ok(f.retention_until > f.answered_at);
  // Nada que borrar hoy...
  assert.equal((await purgeExpiredAnswers({ DB }, f.answered_at)).rows_affected, 0);
  // ...y pasada la fecha, se borra de verdad.
  assert.equal((await purgeExpiredAnswers({ DB }, "2099-01-01T00:00:00Z")).rows_affected, 1);
  assert.equal(DB._f.length, 0);
});

test("busqueda: se puede llegar por el check_id que cita el cliente", async () => {
  const DB = db();
  await recordAnswer({ DB }, { resp: RESP, req: REQ, build: "w19" });
  const r = await findAnswers({ DB }, { id: DB._f[0].id });
  assert.equal(r.count, 1);
  assert.equal(r.answers[0].verdict, "NO");
});

// ---------------------------------------------------------------------------
// W20 — dos puertas que estaban mal cerradas.
// ---------------------------------------------------------------------------

test("W20 EL FALLO DE W19: la via se lee de resp.meta, no de la raiz", async () => {
  // Sin esto la columna salia siempre vacia y el registro no sabia si una
  // respuesta venia de la cache, del JSON-LD o del modelo — que es justo lo que
  // decide si se puede reproducir igual.
  const DB = db();
  const resp = { ...RESP, meta: { corpus_id: "corp-1", checked_via: "agent_supplied", cache_hit: false } };
  await recordAnswer({ DB }, { resp, req: REQ, apiKey: REQ.__api_key, build: "w20" });
  assert.equal(DB._f[0].via, "agent_supplied");
});

test("W20: una respuesta servida de cache queda marcada como tal", async () => {
  const DB = db();
  const resp = { ...RESP, meta: { checked_via: "cache", cache_hit: true } };
  await recordAnswer({ DB }, { resp, req: REQ, apiKey: REQ.__api_key, build: "w20" });
  assert.equal(DB._f[0].via, "cache");
  assert.equal(DB._f[0].cache_hit, 1);
});

test("W22 EL EXAMEN NO ENSUCIA EL REGISTRO: una pasada de /eval no deja ni una fila", async () => {
  // Mismo criterio que W15 con el corpus. 43 respuestas sinteticas por pasada
  // mezcladas con las reales convierten el registro de reclamaciones en un sitio
  // donde hay que filtrar antes de mirar — y un archivo que hay que limpiar para
  // usarlo deja de usarse.
  const DB = db();
  const id = await recordAnswer({ DB }, { resp: RESP, req: { ...REQ, __no_corpus: true }, build: "w22" });
  assert.equal(id, null);
  assert.equal(DB._f.length, 0);
  // Y una consulta normal SI se registra: la proteccion no puede tragarse todo.
  await recordAnswer({ DB }, { resp: RESP, req: REQ, build: "w22" });
  assert.equal(DB._f.length, 1);
});
