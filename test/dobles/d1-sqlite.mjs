// Adaptador minimo de SQLite real a la interfaz de D1 usada por el Worker.
// La puerta se prueba contra el UNIQUE y el `changes` del motor, no contra un
// Map programado para devolver el resultado esperado.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function baseReal(
  ficheros = ["schema-004-idempotencia.sql", "schema-005-puerta-idempotencia.sql"]
) {
  const sqlite = new DatabaseSync(":memory:");
  for (const fichero of ficheros)
    sqlite.exec(readFileSync(join(RAIZ, fichero), "utf8"));
  return envolver(sqlite);
}

export function aplicarEsquema(D1, fichero) {
  D1._sqlite.exec(readFileSync(join(RAIZ, fichero), "utf8"));
}

export function envolver(sqlite) {
  return {
    _sqlite: sqlite,
    prepare(sql) {
      const ejecutar = (args) => {
        const resultado = sqlite.prepare(sql).run(...args);
        return {
          meta: {
            changes: Number(resultado.changes),
            last_row_id: Number(resultado.lastInsertRowid || 0),
          },
        };
      };
      return {
        bind(...valores) {
          const args = valores.map((v) => (v === undefined ? null : v));
          return {
            run: async () => ejecutar(args),
            first: async () => sqlite.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
          };
        },
        run: async () => ejecutar([]),
        first: async () => sqlite.prepare(sql).get() ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all() }),
      };
    },
  };
}

export function filaIdem(D1, id) {
  return D1._sqlite
    .prepare("SELECT * FROM payment_idempotency WHERE payment_id = ?")
    .get(id) ?? null;
}

export function cuantasIdem(D1) {
  return Number(D1._sqlite
    .prepare("SELECT COUNT(*) AS n FROM payment_idempotency")
    .get().n);
}
