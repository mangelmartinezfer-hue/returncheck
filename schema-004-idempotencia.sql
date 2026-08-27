-- W31 — IDEMPOTENCIA DE PAGOS (extensión Payment-Identifier de x402)
--
-- Se aplica SOBRE una base que ya tiene schema.sql, 002 y 003.
-- Se ejecuta UNA sola vez y ANTES de desplegar el código que escribe aquí:
--   npx wrangler d1 execute returncheck --remote --file=schema-004-idempotencia.sql
--
-- POR QUÉ EXISTE: un agente paga, la respuesta se pierde por el camino, y el
-- agente reintenta — que es lo único razonable que puede hacer. Sin esta tabla,
-- ese reintento es un segundo cobro por la misma pregunta.
--
-- Y sobre todo: sin ella, un cliente podría pagar UNA vez y reutilizar el mismo
-- identificador para preguntar por mil productos distintos. La huella lo impide.

CREATE TABLE IF NOT EXISTS payment_idempotency (
  -- El identificador que manda el cliente. 16-128 caracteres, [a-zA-Z0-9_-].
  payment_id      TEXT PRIMARY KEY,

  -- sha-256 de la petición normalizada: los cinco campos de dinero, el método, la
  -- ruta y EL CUERPO. El cuerpo va dentro porque en ReturnCheck la pregunta ES la
  -- operación: sin él, un pago compraría respuestas ilimitadas.
  fingerprint     TEXT NOT NULL,

  -- La respuesta tal cual se sirvió. Solo se guardan las que salieron bien: cachear
  -- un error dejaría al cliente sin poder reintentar, que es justo lo que debe
  -- hacer cuando algo falla.
  response_json   TEXT NOT NULL,
  http_status     INTEGER NOT NULL DEFAULT 200,

  -- La transacción con la que se cobró, para poder demostrar que ese identificador
  -- ya se liquidó y no se volvió a cobrar.
  transaction_hash TEXT,

  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

-- Para el barrido de caducados.
CREATE INDEX IF NOT EXISTS idx_idem_expira ON payment_idempotency(expires_at);
