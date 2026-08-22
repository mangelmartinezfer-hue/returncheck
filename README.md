# ReturnCheck — API de producción (Fase 1, fiat-first)

Responde una pregunta: **¿se puede devolver de verdad este producto?** API de pago para agentes de compras. EEUU primero, lista para global.

- `POST /v1/signup` → alta + crédito de prueba, te da una API key.
- `POST /v1/check` → la consulta (alias `/v1/check_return`).
- `GET /v1/balance` → saldo del cliente.
- `POST /v1/agent/check` → x402 **dormido** (Fase 2): devuelve un 402 educado.
- `POST /webhooks/stripe` → recarga de saldo.

**Decisiones grabadas en el código:** precio $0,02/consulta · **UNKNOWN no se cobra** · crédito de prueba $2 (~100 consultas) · cobro **atómico** (imposible dejar saldo negativo) · x402 cableado pero apagado.

---

## Puesta en marcha SIN terminal (recomendado para Miguel)

Lo haremos por la web. Yo te acompaño en cada punto.

### Paso 1 — Subir el código a GitHub
1. Entra en github.com → **New repository** → nombre `returncheck` → **Private** → Create.
2. En el repo vacío: **uploading an existing file** → arrastra TODA la carpeta que te paso (package.json, wrangler.toml, schema.sql, la carpeta `src/`, `test/`) → **Commit changes**.

### Paso 2 — Crear la base de datos (D1)
1. En Cloudflare: **Storage & Databases → D1 → Create database** → nombre `returncheck` → Create.
2. Copia el **Database ID** que te muestra y pégalo en `wrangler.toml`, en `database_id = "..."` (edítalo en GitHub: abre el archivo → lápiz → pega → commit).
3. En la base, pestaña **Console**: abre `schema.sql` del repo, copia TODO su contenido, pégalo y **Execute**. (Crea las tablas.)

### Paso 3 — Conectar GitHub con Cloudflare (deploy automático)
1. **Workers & Pages → Create → Workers → Connect to Git** → elige el repo `returncheck`.
2. Deja el build por defecto (usa `wrangler.toml`). **Deploy**. En 1-2 min tendrás una URL tipo `https://returncheck.<tu-cuenta>.workers.dev`.
3. Copia esa URL y pégala en `wrangler.toml` → `PUBLIC_BASE_URL`. Commit → se redespliega solo.

### Paso 4 — Activar IA y navegador
- **Workers AI** ya funciona (nivel gratis: 10.000 neuronas/día).
- **Browser Rendering** necesita el plan **Workers Paid (~$5/mes)**. Actívalo en **Workers & Pages → Plans**. (Es el gasto que ya autorizaste.)

### Paso 5 — Probar SIN dinero (el hito importante)
Con el crédito de prueba ya puedes usar todo. Desde cualquier sitio que haga peticiones (o te doy un botón):
```
# 1) Alta
POST https://TU-URL/v1/signup   body: {"email":"tu@email.com"}
# -> te devuelve "api_key": "rc_live_..."

# 2) Consulta
POST https://TU-URL/v1/check
Header: Authorization: Bearer rc_live_...
body: {"product_url":"https://www.apple.com/shop/product/...","buyer_country":"US","item_condition":"unopened"}
```
Aquí es donde **medimos la precisión real** del motor contra el modelo de producción (el número que llevábamos esperando).

---

## Paso 6 — Cobro real con Stripe (cuando el motor pase la prueba)
1. Crea cuenta en stripe.com (como particular, de momento).
2. Crea un **Payment Link** o Checkout de recarga (p. ej. $10) que incluya en **metadata** el campo `api_key` del cliente.
3. **Webhooks → Add endpoint** → `https://TU-URL/webhooks/stripe` → evento `checkout.session.completed` → copia el **Signing secret**.
4. Guarda los secretos en Cloudflare (**Worker → Settings → Variables and Secrets**, tipo *Secret*):
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`

> 🔒 **REGLA DE ORO:** estas claves secretas se pegan SOLO en el panel de Cloudflare o Stripe, **NUNCA en el chat**. Si alguna vez te pido una clave secreta por aquí, párame: algo va mal.

---

## Alternativa con terminal (si algún día te animas)
```
npm install
npx wrangler d1 create returncheck            # copia el id a wrangler.toml
npx wrangler d1 execute returncheck --remote --file=schema.sql
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler deploy
```

## Pruebas
```
npm test      # valida contrato, invariantes, fecha límite y el cobro atómico (anti-sobregiro)
```

## Estructura
```
wrangler.toml      configuración + bindings (D1, IA, navegador) + variables públicas
schema.sql         tablas (clientes, libro mayor, caché, idempotencia Stripe)
src/index.mjs      router + flujo de cobro (UNKNOWN gratis, atómico)
src/engine.mjs     page_parse: caché -> navegador -> IA restringida -> contrato
src/prompt.mjs     el "cerebro" v0.3 + esquema de decodificación restringida
src/contract.mjs   validación de entrada + invariantes de salida (v1.0)
src/decision.mjs   fecha límite / ventana vencida (lógica pura)
src/billing.mjs    cobro ATÓMICO, recarga, alta, crédito de prueba
src/stripe.mjs     webhook firmado -> recarga de saldo
test/logic.test.mjs  11 pruebas (verde)
```
