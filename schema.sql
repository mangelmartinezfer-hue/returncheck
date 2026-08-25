-- ReturnCheck — esquema de base de datos (Cloudflare D1 / SQLite)
-- Ejecutar una vez al crear la base. Ver README paso 3.

-- Clientes (devs que integran la API). El saldo prepago vive aquí.
-- El crédito de prueba es simplemente saldo inicial > 0.
CREATE TABLE IF NOT EXISTS clients (
  api_key       TEXT PRIMARY KEY,           -- clave pública del cliente (rc_live_...)
  email         TEXT NOT NULL,
  balance_usd   REAL NOT NULL DEFAULT 0,    -- saldo en USD; el cobro atómico resta de aquí
  status        TEXT NOT NULL DEFAULT 'active',  -- active | suspended
  calls_charged INTEGER NOT NULL DEFAULT 0, -- consultas cobradas (útiles)
  calls_free    INTEGER NOT NULL DEFAULT 0, -- consultas servidas gratis (UNKNOWN)
  created_at    TEXT NOT NULL,
  stripe_customer_id TEXT                    -- para reconciliar recargas
);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_stripe ON clients(stripe_customer_id);

-- Libro mayor: cada movimiento de saldo (recarga + / cobro -). Para reconciliar y auditar.
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key    TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- topup | charge
  amount_usd REAL NOT NULL,                 -- + recarga, - cobro
  ref        TEXT,                          -- id de sesión Stripe o id de consulta
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_key ON ledger(api_key);

-- Caché del extracto de política por producto. Separa lo caro (leer+IA) de lo barato
-- (decidir por consulta). La ventana/fecha límite se recalcula por petición.
CREATE TABLE IF NOT EXISTS policy_cache (
  cache_key   TEXT PRIMARY KEY,             -- normalizado: producto + condición + motivo
  payload     TEXT NOT NULL,                -- JSON del check_return (sin deadline por fecha)
  verified_on TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON policy_cache(expires_at);

-- Idempotencia de webhooks de Stripe (no acreditar dos veces el mismo evento).
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Contadores del tramo de prueba SIN clave (por IP/día y global/día).
-- El código la crea sola (CREATE IF NOT EXISTS) en la 1ª llamada; se incluye aquí
-- por documentación. bucket = 'global:YYYY-MM-DD' o 'ip:<hash>:YYYY-MM-DD'.
CREATE TABLE IF NOT EXISTS free_usage (
  bucket TEXT PRIMARY KEY,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL
);

-- Contadores de producto para el panel (/dashboard, /stats). Se autocrea.
-- name = 'checks_total' | 'verdict_YES' | 'via_structured_data_jsonld' | ...
CREATE TABLE IF NOT EXISTS metrics (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- =====================================================================
-- policy_corpus — banco de políticas (añadido 25 ago 2026, doc 39)
-- =====================================================================
-- POR QUÉ EXISTE, y por qué NO es policy_cache:
--   policy_cache SIRVE RESPUESTAS. Por eso engine.mjs no cachea contenido
--   aportado por terceros (`if (!agentSupplied)`, líneas 423 y 482): evita que
--   una página aportada por un agente envenene lo que respondemos a otros. Esa
--   protección es correcta y NO se toca.
--   policy_corpus SOLO ACUMULA. No responde a nadie, no alimenta decisiones.
--   Por eso puede guardar lo que la caché no debe guardar. Consecuencia directa:
--   443 de 446 consultas de rodaje se tiraron; con esta tabla ya no se tiran.
--
-- REGLAS QUE ESTE ESQUEMA HACE CUMPLIR (no solo documenta):
--   R3 "el motor autónomo solo confía en entradas revisadas"
--      -> vista policy_corpus_reviewed. El motor lee la VISTA, nunca la tabla.
--   R4 "preservar el texto original y su procedencia"
--      -> `content` se guarda sin normalizar + source_kind/provenance/source_url.
--   R5 "nada de datos personales del comprador ni secretos del cliente"
--      -> no hay columna de comprador; el cliente se referencia por `client_ref`,
--         que es un HASH de su api_key, nunca el email ni la clave.
--   R6 "migraciones idempotentes y no destructivas"
--      -> solo CREATE ... IF NOT EXISTS. Ni ALTER, ni DROP, ni UPDATE.
--   R7 "el contenido del cliente marcado como autorizado, no como scraping"
--      -> `provenance` es obligatorio y separado de `source_kind`.
--   R8 "retención / borrado por cliente"
--      -> `client_ref` + `retention_until` + `deleted_at` (borrado lógico).
--
-- LO QUE ESTE ESQUEMA NO PUEDE HACER SOLO: ver el informe adjunto, §PII.

CREATE TABLE IF NOT EXISTS policy_corpus (
  id              TEXT PRIMARY KEY,          -- uuid v4 generado al capturar

  -- Identidad del comercio
  merchant_domain TEXT NOT NULL,             -- host en minúsculas, sin "www."
  merchant_name   TEXT,                      -- nombre legible, opcional
  country         TEXT,                      -- ISO-3166-1 alpha-2, o NULL si la política no lo declara

  -- Procedencia: DOS ejes distintos, deliberadamente separados
  source_url      TEXT,                      -- URL exacta si la hubo; NULL si solo llegó texto
  source_kind     TEXT NOT NULL              -- CÓMO llegaron los bytes
                  CHECK (source_kind IN ('fetched_url','page_text','page_html','jsonld')),
  provenance      TEXT NOT NULL              -- QUIÉN autorizó que los tuviéramos
                  CHECK (provenance IN ('self_fetched','client_supplied','agent_supplied')),
  authorized_by   TEXT,                      -- referencia del permiso (nº de pedido de auditoría,
                                             -- id de contrato). Obligatorio de facto si client_supplied.

  -- El documento
  content         TEXT NOT NULL CHECK (length(content) <= 200000),  -- texto ORIGINAL, sin normalizar
  content_hash    TEXT NOT NULL,             -- sha-256 hex del content exacto
  content_chars   INTEGER NOT NULL,
  captured_at     TEXT NOT NULL,             -- cuándo lo capturamos NOSOTROS (ISO-8601)
  effective_at    TEXT,                      -- fecha que declara la propia política, si la declara

  -- Alcance: NO es un enum único. Una misma política puede estar acotada por
  -- membresía Y categoría a la vez (visto en RC25-12). Columnas independientes.
  scope_general   INTEGER NOT NULL DEFAULT 1 CHECK (scope_general IN (0,1)),
  scope_category  TEXT,
  scope_product   TEXT,
  scope_seller    TEXT,
  scope_channel   TEXT,                      -- online | in_store | marketplace | ...
  scope_membership TEXT,                     -- Plus | Prime | ...

  -- Revisión humana
  review_state    TEXT NOT NULL DEFAULT 'unreviewed'
                  CHECK (review_state IN ('unreviewed','reviewed','rejected')),
  reviewed_at     TEXT,
  reviewed_by     TEXT,                      -- iniciales o alias, NO email
  review_note     TEXT,

  -- Señal automática: si el filtro determinista sospecha datos personales dentro
  -- del texto, se marca 1 y la entrada NO puede pasar a 'reviewed' sin que un
  -- humano lo mire. Ver §PII del informe.
  pii_suspected   INTEGER NOT NULL DEFAULT 0 CHECK (pii_suspected IN (0,1)),

  -- Versionado: nunca se sobrescribe. Cambio de contenido = fila nueva que apunta
  -- a la anterior. Así se conserva el histórico de políticas de un comercio.
  supersedes_id   TEXT,

  -- Retención y borrado por cliente
  client_ref      TEXT,                      -- sha-256 de la api_key. NUNCA la clave ni el email.
  retention_until TEXT,                      -- fecha tras la cual se elimina
  deleted_at      TEXT                       -- borrado lógico; el purgado físico es un job aparte
);

-- Identidad del documento: dominio + contenido. NO el hash a secas: miles de
-- tiendas Shopify comparten el texto por defecto palabra por palabra, y con un
-- UNIQUE(content_hash) la segunda tienda no entraría nunca.
CREATE UNIQUE INDEX IF NOT EXISTS idx_corpus_identity
  ON policy_corpus(merchant_domain, content_hash);
CREATE INDEX IF NOT EXISTS idx_corpus_merchant  ON policy_corpus(merchant_domain);
CREATE INDEX IF NOT EXISTS idx_corpus_review    ON policy_corpus(review_state);
CREATE INDEX IF NOT EXISTS idx_corpus_client    ON policy_corpus(client_ref);
CREATE INDEX IF NOT EXISTS idx_corpus_retention ON policy_corpus(retention_until);

-- R3 hecha cumplir por construcción: lo único que el motor autónomo puede leer.
-- Si algún día alguien consulta policy_corpus directamente desde el motor, será
-- una decisión visible en el diff, no un descuido.
CREATE VIEW IF NOT EXISTS policy_corpus_reviewed AS
  SELECT * FROM policy_corpus
  WHERE review_state = 'reviewed' AND pii_suspected = 0 AND deleted_at IS NULL;

-- Un documento se usa muchas veces. Guardar el "para qué" en la fila del documento
-- obligaría a duplicar el texto por cada uso. Tabla de enlace, deliberadamente mínima.
CREATE TABLE IF NOT EXISTS policy_corpus_use (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  corpus_id    TEXT NOT NULL,
  used_at      TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('check','audit','manual')),
  context_ref  TEXT,          -- id de auditoría o de consulta. NUNCA datos del comprador.
  verdict      TEXT           -- veredicto que salió, para medir aciertos después
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_corpus_use_unique
  ON policy_corpus_use(corpus_id, context_kind, context_ref);
CREATE INDEX IF NOT EXISTS idx_corpus_use_doc ON policy_corpus_use(corpus_id);
