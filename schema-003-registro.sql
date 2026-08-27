-- W19 — REGISTRO DE RESPUESTAS
--
-- Se aplica SOBRE una base que ya tiene schema.sql y schema-002-avisos.sql.
-- Se ejecuta UNA sola vez y ANTES de desplegar el código que escribe aquí:
--   npx wrangler d1 execute returncheck --remote --file=schema-003-registro.sql
--
-- POR QUÉ EXISTE, y no es una mejora opcional:
--
-- En /data-policy ya publicamos, por escrito, que guardamos datos «to verify our
-- own answers, correct our errors». No podíamos. Guardábamos el TEXTO de las
-- políticas y un contador de veredictos sin fecha, así que ante un «el martes me
-- respondisteis mal a esto» no teníamos con qué mirarlo. Esto cierra esa promesa.
--
-- Y para un producto cuyo argumento entero es «toda afirmación con fuente», no
-- poder auditar las propias afirmaciones era el agujero más incoherente que
-- teníamos.
--
-- QUÉ SE GUARDA Y QUÉ NO (decisión de Miguel, 27 ago 2026):
--
--  · Sí: los campos ESTRUCTURADOS que de verdad cambian el veredicto. Sin ellos
--    se puede demostrar qué contestamos, pero no reproducir por qué — y una
--    reclamación sobre una ventana vencida no se resuelve sin la fecha de compra.
--  · No: texto libre del cliente, la clave de API, el correo, el cuerpo entero de
--    la petición. Del cliente solo su sha-256, igual que en el corpus, para poder
--    borrar todo lo suyo sin saber nunca quién es.
--  · La URL se guarda sin la parte posterior al «?»: ahí es donde viajan los
--    identificadores de sesión y los tokens de compartir.
--
-- RETENCIÓN: más corta que la del corpus. El texto de una política es un activo
-- que envejece bien; el registro de quién preguntó qué, no. 12 meses por defecto.

CREATE TABLE IF NOT EXISTS answer_log (
  id               TEXT PRIMARY KEY,
  answered_at      TEXT NOT NULL,
  build            TEXT,              -- versión del código que respondió
  model            TEXT,
  client_ref       TEXT,              -- sha-256 de la clave. NUNCA la clave.
  via              TEXT,              -- agent_supplied / structured_data / cache
  cache_hit        INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit IN (0,1)),

  -- La política EXACTA que leímos. Es el enlace que hace reproducible la
  -- respuesta: mismo texto + mismas entradas + mismo build = misma salida.
  corpus_id        TEXT,
  merchant_domain  TEXT,
  product_url      TEXT,              -- sin query string

  -- Entradas que cambian el veredicto. Estructuradas, nunca texto libre.
  buyer_country    TEXT,
  buyer_state      TEXT,
  item_condition   TEXT,
  return_reason    TEXT,
  membership       TEXT,
  purchase_channel TEXT,
  seller_name      TEXT,
  purchase_date    TEXT,
  delivery_date    TEXT,
  as_of            TEXT,

  -- Lo que respondimos, completo.
  verdict          TEXT NOT NULL,
  returnable       INTEGER,
  confidence       REAL,
  return_category  TEXT,
  return_days      INTEGER,
  window_basis     TEXT,
  deadline_date    TEXT,
  exact_clause     TEXT,              -- la cita que dimos, verbatim
  guard_name       TEXT,              -- qué guardián disparó, si disparó alguno
  guard_rejected_clause TEXT,         -- y qué cláusula rechazó
  reason           TEXT,

  charged          INTEGER,           -- NULL hasta que el cobro se resuelve
  price_usd        REAL,
  retention_until  TEXT
);

-- Buscar por cliente (reclamaciones y borrado por cliente).
CREATE INDEX IF NOT EXISTS idx_answer_client ON answer_log(client_ref, answered_at);
-- Buscar por comercio ("qué hemos respondido sobre nike.com este mes").
CREATE INDEX IF NOT EXISTS idx_answer_domain ON answer_log(merchant_domain, answered_at);
-- Barrido de retención.
CREATE INDEX IF NOT EXISTS idx_answer_retention ON answer_log(retention_until);
