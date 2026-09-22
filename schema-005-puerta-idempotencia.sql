-- PR-2 — PUERTA ATOMICA ANTES DE /settle
--
-- Se aplica SOBRE una base que ya tiene schema-004-idempotencia.sql.
-- Se ejecuta UNA sola vez y ANTES de desplegar el codigo de PR-2:
--   npx wrangler d1 execute returncheck --remote --file=schema-005-puerta-idempotencia.sql
--
-- IMPORTANTE: un UPDATE que afecta cero filas no aborta un lote D1. Por eso el
-- permiso monetario nace de un INSERT con conflicto sobre payment_id, y el Worker
-- solo puede continuar cuando el motor devuelve meta.changes === 1.

-- Las filas anteriores ya contienen una respuesta servida, por eso el valor por
-- defecto es completed. Las nuevas empiezan claimed, pasan a settling DESPUES de
-- persistir el resultado y ANTES de /settle, y terminan completed.
ALTER TABLE payment_idempotency
  ADD COLUMN gate_state TEXT NOT NULL DEFAULT 'completed'
    CHECK (gate_state IN ('claimed','settling','completed'));

-- Identidad generada por el servidor. Impide que una invocacion que solo conoce
-- payment_id pueda completar o liberar el intento de otra.
ALTER TABLE payment_idempotency ADD COLUMN attempt_id TEXT;

-- Estado propio de ReturnCheck. No se usa para fabricar un SettlementResponse:
-- pending y unconfirmed siguen sin emitir el sobre estandar.
ALTER TABLE payment_idempotency
  ADD COLUMN settlement_state TEXT
    CHECK (settlement_state IS NULL OR settlement_state IN
      ('not_charged','confirmed','pending','unconfirmed','rejected'));

ALTER TABLE payment_idempotency ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_idem_gate_state
  ON payment_idempotency(gate_state, updated_at);

-- Las filas historicas terminadas no tienen attempt_id. Las nuevas que pueden
-- conceder permiso monetario si lo necesitan: sin propietario no existe forma
-- de impedir que una invocacion complete o libere la fila de otra.
CREATE TRIGGER IF NOT EXISTS trg_idem_gate_owner_insert
BEFORE INSERT ON payment_idempotency
WHEN NEW.gate_state IN ('claimed','settling') AND NEW.attempt_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RC_PAYMENT_GATE_OWNER_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS trg_idem_gate_owner_update
BEFORE UPDATE ON payment_idempotency
WHEN NEW.gate_state IN ('claimed','settling') AND NEW.attempt_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RC_PAYMENT_GATE_OWNER_REQUIRED');
END;
