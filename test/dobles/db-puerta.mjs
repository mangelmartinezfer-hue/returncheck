// Doble mínimo de D1 para las pruebas del camino x402. La operación de claim es
// síncrona sobre el Map: dos promesas concurrentes observan exactamente una fila
// insertada, igual que el UNIQUE(payment_id) de SQLite.
export function dbPuerta({ idemFila = null, falloAlReclamar = null, sinMetaAlReclamar = false } = {}) {
  const filas = new Map();
  if (idemFila) filas.set(idemFila.payment_id, { gate_state: "completed", ...idemFila });

  const generico = {
    run: async () => ({ meta: { changes: 0 } }),
    first: async () => null,
    all: async () => ({ results: [] }),
  };

  return {
    _filas: filas,
    prepare(sql) {
      return {
        ...generico,
        bind(...a) {
          return {
            ...generico,
            first: async () => /FROM payment_idempotency/.test(sql)
              ? (filas.get(a[0]) || null)
              : null,
            run: async () => {
              const s = sql.replace(/\s+/g, " ").trim();

              if (s.startsWith("INSERT INTO payment_idempotency") && s.includes("gate_state")) {
                if (falloAlReclamar) throw falloAlReclamar;
                if (sinMetaAlReclamar) return { meta: {} };
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

              if (s.startsWith("UPDATE payment_idempotency") && s.includes("gate_state = 'settling'")) {
                const fila = filas.get(a[3]);
                if (!fila || fila.fingerprint !== a[4] || fila.attempt_id !== a[5] || fila.gate_state !== "claimed")
                  return { meta: { changes: 0 } };
                Object.assign(fila, {
                  gate_state: "settling", response_json: a[0], http_status: a[1],
                  settlement_state: "unconfirmed", updated_at: a[2],
                });
                return { meta: { changes: 1 } };
              }

              if (s.startsWith("UPDATE payment_idempotency") && s.includes("gate_state = 'completed'")) {
                const fila = filas.get(a[5]);
                if (!fila || fila.fingerprint !== a[6] || fila.attempt_id !== a[7] ||
                    !["claimed", "settling"].includes(fila.gate_state))
                  return { meta: { changes: 0 } };
                Object.assign(fila, {
                  gate_state: "completed", response_json: a[0], http_status: a[1],
                  transaction_hash: a[2], settlement_state: a[3], updated_at: a[4],
                });
                return { meta: { changes: 1 } };
              }

              if (s.startsWith("DELETE FROM payment_idempotency") && s.includes("attempt_id")) {
                const fila = filas.get(a[0]);
                if (!fila || fila.fingerprint !== a[1] || fila.attempt_id !== a[2] ||
                    fila.gate_state !== "claimed")
                  return { meta: { changes: 0 } };
                filas.delete(a[0]);
                return { meta: { changes: 1 } };
              }

              return generico.run();
            },
          };
        },
      };
    },
  };
}
