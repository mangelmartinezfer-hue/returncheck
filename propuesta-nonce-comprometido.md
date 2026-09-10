# Propuesta para la matriz externa: nonce comprometido

**Estado: propuesta. NO implementada.** No hay código de esto en el repositorio.
Se documenta para que la matriz externa (Atinamos / SOJA) pueda evaluarla.

## El hueco que intenta cerrar

Medido el 3 de septiembre de 2026 sobre el primer pago real en Base mainnet
(`check_id` `be7cb294…`, tx `0xbdbac71f…`):

- Un tercero **sí** puede comprobar el pago entero. La transacción lleva la firma
  del comprador en los datos de entrada, así que cualquiera recupera al firmante,
  verifica el dominio EIP-712 y ve el `Transfer` de 0,02 USDC a nuestra cuenta.
- Un tercero **no** puede comprobar que ese pago pagara *esa* respuesta. La
  transacción no lleva el `check_id`, y `transferWithAuthorization` no tiene
  ningún campo de texto libre donde meterlo.

W57 sube ese enlace de 24 horas a 12 meses y lo hace independiente de una
extensión opcional, pero **no cambia su naturaleza**: sigue siendo una afirmación
de ReturnCheck. Dos filas nuestras siguen siendo nuestras.

## La idea

El único dato que ya viaja a la vez por nuestro registro y por la cadena es el
**nonce** de la autorización EIP-3009. Está en los datos de entrada de la
transacción y en el registro `AuthorizationUsed`, es de 32 bytes, lo elige el
comprador y va **dentro de lo que firma**.

Si en vez de aleatorio puro fuera un **compromiso con la petición**, el pago
quedaría atado criptográficamente a la pregunta en el momento de firmar, sin que
nadie tenga que fiarse de nosotros.

```
nonce = SHA-256(
          "x402-commit/v1"            ‖ 0x00 ‖   # dominio, versionado
          sha256(peticion_canonica)   ‖ 0x00 ‖   # a qué se compromete
          sal                                     # ≥ 16 bytes del comprador
        )
```

Tres piezas, y ninguna es decorativa:

- **Dominio versionado** (`"x402-commit/v1"`). Impide que un compromiso hecho
  para esto se pueda reinterpretar como un compromiso para otra cosa, y deja sitio
  a cambiar el esquema sin volver ilegibles los compromisos viejos. Un `v2` sería
  un dominio distinto y por tanto un espacio de hashes disjunto.
- **Hash de la petición canónica.** La canonicalización ya existe en el
  repositorio: `canonico()` en `src/idempotencia.mjs` serializa con las claves
  ordenadas recursivamente, que es justo lo que hace falta para que dos clientes
  que mandan la misma pregunta produzcan el mismo hash.
- **Sal aleatoria del comprador.** No es opcional. Sin ella el compromiso no
  esconde nada: ver los límites de privacidad.

## Qué demostraría, y ante quién

Un comprador que quiera acreditar el pago le entrega a un auditor la petición y
la sal. El auditor, **sin preguntarnos nada**:

1. recalcula el nonce;
2. lo busca en la cadena, en el `AuthorizationUsed` del contrato USDC;
3. comprueba en esa misma transacción el pagador, el destinatario y el importe;
4. recupera al firmante de la firma que va en los datos de entrada.

Conclusión que obtiene sin confiar en ReturnCheck: *esta dirección autorizó
exactamente este importe a esta cuenta, y lo hizo comprometiéndose a esta
pregunta concreta.*

## Qué NO demostraría

Conviene decirlo antes de que alguien lo asuma:

- **No demuestra qué respondimos**, ni que respondiéramos. Ata el pago a la
  *pregunta*, no a la *respuesta*.
- **No demuestra que la respuesta fuera correcta.** Eso no lo resuelve ninguna
  criptografía.
- Para atar la respuesta hace falta la otra mitad: **un recibo firmado por
  ReturnCheck** con `check_id`, `transaction_hash`, `network`, `payer`, `nonce`,
  hash de la petición y hash de la respuesta. Eso sí acredita **autoría e
  integridad**: fija que ese contenido salió de nuestra clave y no se ha alterado.
  Lo que no hace es demostrar por sí solo que la asociación sea cierta — sigue
  siendo nuestra afirmación, pero pasa a ser una afirmación *firmada, fechada y no
  repudiable*, que es un objeto muy distinto de una fila en nuestra base de datos.
- Las dos piezas juntas dejan una cadena completa en la que lo único que queda
  bajo palabra nuestra es «hicimos el trabajo y esta es la respuesta»; el resto lo
  verifica cualquiera.

## Límites de privacidad

Esta es la parte que hay que leer despacio, porque el coste es **permanente**.

1. **El nonce es público y no se puede borrar.** Va en una cadena pública. Todo
   lo que se comprometa ahí queda comprometido para siempre, y ninguna política
   de retención nuestra lo alcanza. No hay derecho al olvido sobre Base.

2. **Sin sal, el compromiso no esconde nada.** El espacio de peticiones es
   pequeño y adivinable: una URL de producto, un país de dos letras, un estado de
   artículo de entre cuatro, un motivo de entre cinco. Cualquiera que sospeche qué
   producto se consultó puede probar la hipótesis y confirmarla. La sal es lo que
   convierte el hash en un compromiso *ocultante*, y por eso se exige **≥ 16 bytes
   de aleatoriedad criptográfica**. Una sal corta, derivada o reutilizada anula la
   propiedad entera.

3. **Revelar la sal es irreversible y no es selectivo de verdad.** El comprador
   decide a quién se la enseña, pero una vez enseñada no puede retirarla: quien la
   tenga puede demostrárselo a cualquiera, para siempre. «Divulgación selectiva»
   describe el primer paso, no el segundo.

4. **La dirección pagadora ya es enlazable de por sí.** Todos los pagos de una
   dirección son observables y correlacionables entre ellos, con compromiso o sin
   él. Lo que el compromiso añade es que, si una sola sal se filtra, esa compra
   concreta queda identificada dentro de ese historial.

5. **Nosotros no ganamos información nueva**, y conviene decirlo: el nonce ya nos
   llega hoy en el sobre, y la petición la conocemos porque nos la mandan. Lo que
   cambia es que dejaríamos de poder *negar* una asociación cierta — que es
   precisamente el objetivo.

6. **No comprometer datos personales.** La petición canónica que entra en el hash
   debería limitarse a los campos del contrato y **excluir `page_text` y
   `page_html`**, que son contenido arbitrario que el comprador pega y puede
   arrastrar datos de terceros. Comprometer eso sería fijar en una cadena pública,
   de forma indeleble, un hash de material que ni siquiera es suyo.

## Adopción

Es una **convención del cliente**, no algo que podamos imponer: el nonce lo elige
quien firma. Lo que nos toca es publicarla —en el manifiesto y como campo
recomendado en `/.well-known/x402`— y guardar el nonce en nuestro lado para poder
verificar una reclamación. Eso último **ya lo hace W57**: `settlement_log.nonce`.

Un comprador que no la use no pierde servicio; pierde la capacidad de demostrarle
a un tercero para qué pagó.
