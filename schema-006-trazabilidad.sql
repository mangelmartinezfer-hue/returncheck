-- PR-1 — EL IDENTIFICADOR DE PETICION EN LAS FILAS.
--
-- Se aplica SOBRE una base que ya tiene schema.sql, 002, 003 y 004.
-- Se ejecuta UNA sola vez y ANTES de desplegar el codigo que escribe aqui:
--   npx wrangler d1 execute returncheck --remote --file=schema-006-trazabilidad.sql
--
-- NO DEPENDE DE schema-005. Esta migracion solo toca tablas creadas por
-- schema-003 (`answer_log`) y schema-004 (`payment_idempotency`). Se puede
-- aplicar sobre una base que nunca haya visto schema-005, y ese es justamente el
-- motivo por el que esta escrita asi: `ALTER TABLE` no admite `IF NOT EXISTS`,
-- de modo que nombrar aqui una tabla que quiza no exista convertiria un PR de
-- trazabilidad en un PR que falla en duro contra produccion.
--
-- EL AGUJERO QUE CIERRA. Hasta hoy, lo unico que un cliente podia citarnos era
-- `check_id`, y `check_id` SOLO existe si el motor llego a contestar
-- (engine.mjs:595). Cuando algo se cae —un 402, un 409, un 500— no habia nada:
-- ni en la respuesta ni en las filas. Una reclamacion del tipo "vuestra API me
-- dio un 500 el martes" no se podia mirar, porque no habia por donde entrar.
--
-- `request_id` (rc_req_<uuid>) existe SIEMPRE, se genera en la primera linea del
-- router y viaja en la cabecera X-ReturnCheck-Request-Id de toda respuesta. Esta
-- columna es lo que lo convierte en algo que se puede buscar despues.
--
-- ADITIVA Y NULLABLE, Y ESO NO ES PEREZA:
--
--   · Aditiva: no se toca ninguna clave primaria ni ninguna columna existente.
--     Las garantias que ya daban las dos tablas se quedan intactas.
--   · Nullable: las filas que ya existen no tienen identificador de peticion y
--     nunca lo van a tener. Inventarles uno seria fabricar trazabilidad que no
--     existio, que es exactamente lo contrario de para lo que sirve esta
--     columna. NULL aqui significa "no lo se", igual que `charged IS NULL`
--     significa "no sabemos si se cobro" desde W41.
--
-- LO QUE ESTA MIGRACION HABILITA Y LO QUE TODAVIA NO SE ESCRIBE. En PR-1 solo
-- `answer_log` recibe valor. La columna de `payment_idempotency` queda creada y
-- vacia: la escribiria `guardar` (idempotencia.mjs:147), que no se toca en este
-- PR. Se crea ahora, en la misma migracion, a proposito: una migracion aditiva
-- sobre D1 es una operacion que hay que programar y ejecutar contra produccion,
-- y partirla en dos visitas por dos PR distintos duplica las ocasiones de que
-- una se quede sin aplicar y el codigo salga escribiendo en una columna que no
-- existe. La columna vacia no hace dano; la columna que falta el dia del
-- despliegue, si.
--
-- LA TRAZABILIDAD DE `settlement_log` QUEDA APLAZADA A PR-2. No se nombra esa
-- tabla en ninguna sentencia de este fichero.

ALTER TABLE answer_log          ADD COLUMN request_id TEXT;
ALTER TABLE payment_idempotency ADD COLUMN request_id TEXT;

-- Entrar por el identificador que cita el cliente. Es LA consulta de esta
-- columna: alguien pega un rc_req_... en un correo y hay que encontrar la fila.
CREATE INDEX IF NOT EXISTS idx_answer_request      ON answer_log(request_id);
CREATE INDEX IF NOT EXISTS idx_idem_request        ON payment_idempotency(request_id);
