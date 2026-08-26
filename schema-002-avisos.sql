-- W16 — AVISOS DE CAMBIO DE POLÍTICA
--
-- Se aplica SOBRE una base que ya tiene schema.sql. Se ejecuta una sola vez:
--   npx wrangler d1 execute returncheck --remote --file=schema-002-avisos.sql
--
-- Por qué en un fichero aparte y no en schema.sql: `CREATE TABLE IF NOT EXISTS`
-- no añade columnas a una tabla que ya existe. Estas dos columnas hay que
-- meterlas con ALTER, y un ALTER no es idempotente — si se ejecuta dos veces
-- falla. Mezclarlo con schema.sql convertiría un fichero que se puede volver a
-- pasar sin miedo en uno que no.

-- Lo que el motor EXTRAJO de esta versión de la política. Sin esto, detectar que
-- una política cambió es fácil (el hash basta) pero decir EN QUÉ cambió es
-- imposible: habría que volver a pasar el texto viejo por el modelo. Guardarlo al
-- capturar cuesta cero y convierte el aviso en "pasó de 60 a 30 días" en vez de
-- "algo cambió", que es la diferencia entre un producto y una notificación inútil.
ALTER TABLE policy_corpus ADD COLUMN parsed_days INTEGER;
ALTER TABLE policy_corpus ADD COLUMN parsed_category TEXT;

-- Qué dominios vigila cada cliente. Del cliente solo su sha-256: se puede borrar
-- todo lo suyo sin saber nunca quién es.
CREATE TABLE IF NOT EXISTS policy_watch (
  id              TEXT PRIMARY KEY,
  client_ref      TEXT NOT NULL,
  merchant_domain TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE(client_ref, merchant_domain)
);
CREATE INDEX IF NOT EXISTS idx_watch_client ON policy_watch(client_ref, active);

-- Los cambios detectados. NO se borran cuando un cliente deja de vigilar: el
-- histórico de cómo se mueven las políticas es el activo, y no pertenece a un
-- cliente concreto.
CREATE TABLE IF NOT EXISTS policy_change (
  id              TEXT PRIMARY KEY,
  merchant_domain TEXT NOT NULL,
  from_corpus_id  TEXT,
  to_corpus_id    TEXT NOT NULL,
  detected_at     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('window_shortened','window_extended','window_added',
                     'window_removed','category_changed','text_only')),
  days_before     INTEGER,
  days_after      INTEGER,
  category_before TEXT,
  category_after  TEXT,
  summary         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_domain ON policy_change(merchant_domain, detected_at);
