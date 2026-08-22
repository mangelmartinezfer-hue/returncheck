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
