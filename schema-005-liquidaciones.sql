-- W57 — REGISTRO DE LIQUIDACIONES.
--
-- EL AGUJERO QUE CIERRA, medido el 3 de septiembre de 2026 sobre el primer pago
-- real en Base mainnet (check_id be7cb294..., tx 0xbdbac71f...):
--
--   1. `answer_log` no tiene ninguna columna de cadena. El registro que dura 12
--      meses sabe que se cobro (`charged`, `price_usd`) y NO sabe con que
--      transaccion. Justo el sitio donde un auditor mirara dentro de seis meses
--      es el que no podia responder.
--   2. El unico enlace entre la respuesta y la transaccion vivia en
--      `payment_idempotency`, y ahi habia dos problemas peores que la ausencia:
--        a) la fila SOLO se escribe si el comprador manda la extension
--           `payment-identifier`, que es invencion nuestra y opcional. Un agente
--           que pague sin ella dejaba CERO correlacion.
--        b) `expires_at` es de 24 horas. Sobrevivia por accidente, porque
--           `purgarCaducados` existe y nadie la llama.
--
-- LO QUE ESTA TABLA NO ARREGLA, y conviene no confundirlo: sigue siendo un
-- registro NUESTRO. Que el pago pagara ESTA respuesta continua siendo una
-- afirmacion de ReturnCheck, no algo que un tercero pueda comprobar contra la
-- cadena — la transaccion no lleva el check_id y `transferWithAuthorization` no
-- tiene campo libre donde meterlo. Esto sube el enlace de 24 horas a 12 meses y
-- lo hace independiente de una extension opcional. Nada mas, y asi hay que
-- declararlo.
--
-- CLAVE PRIMARIA = check_id. Es el enlace DIRECTO con answer_log.id, y de paso
-- hace imposible por construccion escribir dos liquidaciones para la misma
-- respuesta.

CREATE TABLE IF NOT EXISTS settlement_log (
  -- answer_log.id. Uno a uno: una respuesta cobrada, una liquidacion.
  check_id         TEXT PRIMARY KEY,

  settled_at       TEXT NOT NULL,

  -- Los TRES estados de W41, no dos. `confirmed` solo cuando el facilitador lo
  -- confirma Y los datos cuadran; ver `mismatch`.
  status           TEXT NOT NULL CHECK (status IN ('confirmed','pending','unconfirmed')),

  transaction_hash TEXT,
  network          TEXT,
  payer            TEXT,

  -- TEXTO, no numero. Son unidades atomicas y pueden no caber en un numero
  -- seguro de JavaScript. Es la misma razon por la que `aceptadoCoincide`
  -- compara la cantidad como cadena.
  amount_atomic    TEXT,

  asset            TEXT,

  -- El nonce de la autorizacion EIP-3009. Va aqui porque es el UNICO dato que
  -- esta a la vez en nuestro registro y en la cadena: la transaccion lo lleva en
  -- los datos de entrada y en el registro AuthorizationUsed. No prueba la
  -- asociacion, pero es por donde se empezaria a reconstruirla.
  nonce            TEXT,

  pay_to           TEXT,

  -- Por que no se pudo dar por confirmado, cuando el facilitador decia que si.
  -- NULL si todo cuadraba. Se guarda el motivo y no solo el estado: "no cuadro"
  -- sin decir que campo es una alarma que no se puede investigar.
  mismatch         TEXT,

  retention_until  TEXT
);

-- Para conciliar: que hay pendiente o sin confirmar, por fecha.
CREATE INDEX IF NOT EXISTS idx_settlement_status ON settlement_log(status, settled_at);
-- Para el barrido de retencion.
CREATE INDEX IF NOT EXISTS idx_settlement_retention ON settlement_log(retention_until);
-- Para ir de una transaccion de la cadena a la respuesta que pago.
CREATE INDEX IF NOT EXISTS idx_settlement_tx ON settlement_log(transaction_hash);
