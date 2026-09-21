-- PR-2 — LA PUERTA ATÓMICA ANTES DE /settle (BLQ-X402-GATE-01)
--
-- Se aplica SOBRE una base que ya tiene schema.sql, 002, 003 y 004.
-- Se ejecuta UNA sola vez y ANTES de desplegar el código que escribe aquí:
--   npx wrangler d1 execute returncheck --remote --file=schema-005-puerta-idempotencia.sql
--
-- QUÉ ARREGLA. Hasta ahora el camino de cobro leía `payment_idempotency`, hacía
-- el trabajo, llamaba al facilitador y DESPUÉS escribía la fila con un
-- `INSERT OR REPLACE`. Entre la lectura y la escritura no había nada atómico:
-- dos peticiones con el mismo identificador de pago pasaban las dos el control,
-- gastaban el motor las dos y llamaban a /settle LAS DOS. Y un `INSERT OR
-- REPLACE` siempre tiene éxito, así que por construcción no podía servir de
-- puerta: nunca devuelve el cero que distingue al perdedor.
--
-- CÓMO SE ARREGLA. La fila se crea ANTES de verificar, con
-- `INSERT ... ON CONFLICT (payment_id) DO NOTHING`. El motor devuelve 1 al
-- ganador y 0 al perdedor, y ese número —el de verdad, el del motor, no uno
-- fabricado en un `catch`— es lo único que da permiso para seguir.
--
-- MIGRACIÓN ADITIVA, como manda el contrato congelado: solo se añaden columnas.
-- Ninguna fila existente cambia de significado. Las que ya están se quedan en
-- 'done', que es lo que son: respuestas ya servidas.

-- 'in_flight' = alguien reclamó el identificador y todavía está trabajando.
-- 'done'      = la respuesta está guardada y se puede devolver tal cual.
ALTER TABLE payment_idempotency ADD COLUMN status TEXT NOT NULL DEFAULT 'done';

-- Cuándo se reclamó. Sin esto, una petición que muere a medio camino dejaría el
-- identificador bloqueado para siempre y el cliente no podría reintentar nunca.
ALTER TABLE payment_idempotency ADD COLUMN claimed_at TEXT;

-- Para encontrar reclamaciones colgadas en la conciliación.
CREATE INDEX IF NOT EXISTS idx_idem_en_curso ON payment_idempotency(status, claimed_at);
