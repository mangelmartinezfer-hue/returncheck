# Verificación de las tres citas de la ficha de eBay contra la fuente oficial

**Fecha real de la comprobación:** 2026-10-11
**Método:** navegador real (panel integrado). Texto obtenido del DOM, no de un resumen.
**Alcance:** únicamente las tres citas ya publicadas en `cards/rc-card-ebay-seller-decides.mjs`.
No se ha revisado ninguna otra afirmación de la ficha.
**`verified_on` publicado en la ficha:** 2026-08-20 (no modificado por esta comprobación).

---

## Cita 1 — NO COINCIDE

**Publicada:** `see the seller's full return policy`
**Fuente declarada:** https://www.ebay.com/help/buying/returns-refunds/returning-item?id=4041

**Lo que dice hoy la página, literal:**

> Many sellers accept returns if you've changed your mind. Check the listing in your Purchases - opens in new window or tab for the seller's full return policy.

La página dice **«Check the listing in your Purchases … for the seller's full return policy»**.
No contiene la secuencia `see the seller's full return policy`: el verbo publicado (`see`) no
está en la fuente. Lo literal es `for the seller's full return policy`.

Comprobado sobre el DOM completo con normalización de mayúsculas, comillas y espacios:

- `see the sellers full return policy` → **ausente**
- `sellers full return policy` → presente
- `full return policy` → presente

Matiz: la frase vive dentro del acordeón plegado «When can I return an item?», así que no
aparece en el texto visible sin desplegarlo. Está en la página, pero no a la vista.

Captura completa: `test/fixtures/ebay-returning-item-2026-10-11.txt`

## Cita 2 — COINCIDE

**Publicada:** `30 calendar days after the estimated or actual delivery date`
**Fuente declarada:** https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210

**Literal en la página,** en la tabla de plazos de «not as described»:

> Latest: 30 calendar days after the estimated or actual delivery date or within the seller's stated returns window, whichever is longer

La cita publicada es una subcadena exacta. Reaparece en la fila de «Event tickets»:

> 30 calendar days after the estimated or actual delivery date or 7 calendar days after the event date, whichever is later

## Cita 3 — COINCIDE

**Publicada:** `they are entitled to return it for a refund, even if the seller doesn't offer returns`
**Fuente declarada:** https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210

**Literal en la página:**

> Sellers are required to deliver the item as it was described in the listing. If the buyer receives the wrong item, or the item arrives broken, damaged, or faulty (and was not clearly described as such), they are entitled to return it for a refund, even if the seller doesn't offer returns.

La cita publicada es una subcadena exacta.

---

## Resultado

2 de 3 coinciden. La cita 1 no es literal: es una paráfrasis con el verbo cambiado.

El recibo de eBay **no se ha preparado** para firma. Queda en `UNRESOLVED`, a la espera de
decisión sobre la cita 1.
