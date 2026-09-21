// Una base D1 de mentira por fuera y de VERDAD por dentro.
//
// POR QUÉ EXISTE, que es el punto entero de PR-2. El resto de las pruebas del
// repositorio simulan D1 con un `Map` escrito a mano. Para casi todo vale. Para
// una PUERTA no vale nada: la puerta consiste en que el motor devuelva 1 al
// ganador y 0 al perdedor, y si el 1 y el 0 los escribe el propio doble,
// entonces la prueba solo demuestra que el doble hace lo que yo le dije que
// hiciera. Eso no es una medición, es un eco.
//
// Aquí debajo hay un SQLite real. El `changes` sale del motor. La restricción
// de clave primaria la impone el motor. Si `ON CONFLICT ... DO NOTHING` se
// comportara de otra manera, estas pruebas se enterarían.
//
// Y el esquema no se copia: se LEE de los ficheros .sql de producción. Así la
// prueba no puede quedarse atrás respecto al esquema, y de paso comprueba que
// schema-005 se aplica limpiamente encima de schema-004.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Crea una base en memoria con los esquemas reales aplicados en orden. */
export function baseReal(ficheros = ["schema-004-idempotencia.sql", "schema-005-puerta-idempotencia.sql"]) {
  const db = new DatabaseSync(":memory:");
  for (const f of ficheros) db.exec(readFileSync(join(RAIZ, f), "utf8"));
  return envolver(db);
}

/** Envuelve un SQLite en la forma que espera D1: prepare().bind().run()/first(). */
export function envolver(db) {
  return {
    _sqlite: db,
    prepare(sql) {
      const ejecutar = (a) => {
        const st = db.prepare(sql);
        const r = st.run(...a);
        return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid || 0) } };
      };
      return {
        bind(...args) {
          // D1 no admite `undefined`; en la vida real eso es un null.
          const a = args.map((v) => (v === undefined ? null : v));
          return {
            run: async () => ejecutar(a),
            first: async () => db.prepare(sql).get(...a) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...a) }),
          };
        },
        run: async () => ejecutar([]),
        first: async () => db.prepare(sql).get() ?? null,
        all: async () => ({ results: db.prepare(sql).all() }),
      };
    },
  };
}

/** Lee la fila de idempotencia sin pasar por el código que se está probando. */
export function filaIdem(D1, id) {
  return D1._sqlite.prepare("SELECT * FROM payment_idempotency WHERE payment_id = ?").get(id) ?? null;
}

/** Cuenta filas, para comprobar que no se cuela ninguna de más. */
export function cuantasIdem(D1) {
  return Number(D1._sqlite.prepare("SELECT COUNT(*) AS n FROM payment_idempotency").get().n);
}
