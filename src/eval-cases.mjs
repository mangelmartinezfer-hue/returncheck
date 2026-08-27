// W27 — RECALIBRACIÓN DE TRES RESPUESTAS ESPERADAS (27 ago 2026, decide Miguel).
//
// AVISO, y va primero porque es lo que hay que vigilar: cambiar las respuestas
// esperadas del propio examen para que encajen con el código nuevo es EXACTAMENTE
// como un equipo se engaña a sí mismo. Si algún día alguien lee esto y no
// encuentra la justificación de abajo, que lo revierta.
//
// Lo que lo hace legítimo esta vez, y solo esta vez:
//
//  1. NO seguimos a nuestro código. Seguimos al HOLDOUT, que escribió el equipo de
//     ChatGPT sin conocer nuestra taxonomía y que espera YES en 4 de sus 25 casos.
//     El árbitro dijo primero cuál era la definición correcta.
//  2. El holdout lo confirmó DESPUÉS de forma independiente: tras W26 su
//     `taxonomy_only_diffs` es 0. No queda ni un caso donde discrepemos solo en
//     YES contra YES_WITH_CONDITIONS. Con 25 casos ajenos de acuerdo, mantener
//     nuestros tres en la definición vieja sería medir con dos varas.
//  3. Ninguno de los tres cambia de POSITIVO a NEGATIVO ni al revés. Solo cambia
//     la etiqueta dentro de lo positivo. Cero riesgo de sí falso.
//  4. Los otros CINCO casos que esperan YES_WITH_CONDITIONS se quedan como están
//     —C07, C08, C10, C16, C17— y por eso el campo sigue significando algo.
//
// La definición contra la que se justifica cada cambio:
//   YES = la cláusula permite la devolución, la ventana está abierta, y toda
//         condición que la cláusula NOMBRA está cubierta por lo que nos han dicho.
//   YWC = queda al menos una condición que no podemos dar por cumplida.
//
// Banco CIEGO para el examen v2. Casos NUEVOS (comercios ficticios y textos de política
// realistas con ruido), con veredicto esperado verificado a mano. Se pasan al motor de
// PRODUCCIÓN por la vía agent_supplied (page_text) para medir precisión, cobertura y
// honestidad SIN depender de leer webs en vivo. Incluye trampas: si el motor "adivina"
// en ellas, miente; lo correcto es UNKNOWN.
//
// expected.verdict: YES_WITH_CONDITIONS | NO | UNKNOWN  (no usamos YES "pelado")
// trap:true  -> caso diseñado para que el modelo caiga en la tentación de inventar.

export const EVAL_CASES = [
  {
    id: "C01_finite_30",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Returns & Refunds. We want you to love your purchase. Eligible items may be returned within 30 days of delivery for a full refund to the original payment method. Items must be unused and in their original packaging. Free standard shipping on orders over $50.",
    // W27 · antes YES_WITH_CONDITIONS. Lo que la cláusula exige —"unused" y
    // "original packaging"— son las dos condiciones de estado físico, y el
    // artículo viene declarado `unopened`, que las entraña. El resultado no se
    // toca: reembolso completo al método de pago original. No queda nada
    // pendiente que dependa del comprador.
    // El punto débil, dicho para que se pueda discutir: "Eligible items". Se
    // trata como fórmula genérica y no como exclusión nombrada; si valiera como
    // exclusión, casi toda política de internet sería condicional y la etiqueta
    // volvería a no informar de nada.
    expected: { verdict: "YES", days: 30 },
    note: "Ventana clara de 30 días. Condiciones de estado cubiertas por unopened (W27).",
  },
  {
    id: "C02_final_sale_NO",
    request: { buyer_country: "US", item_condition: "opened", reason: "changed_mind" },
    page_text: "Clearance Policy. All clearance and final sale items are sold as-is. Final sale items cannot be returned or exchanged for any reason. Regular-priced items follow our standard 30-day return policy.",
    expected: { verdict: "NO" },
    note: "Final sale explícito para el artículo en cuestión.",
  },
  {
    id: "C03_shipping_only_TRAP",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Shipping Information. We offer free ground shipping on all orders over $75. Orders placed before 2pm ET ship the same business day. Expedited and international shipping rates are calculated at checkout. Tracking is emailed once your order leaves our warehouse.",
    expected: { verdict: "UNKNOWN" },
    trap: true,
    note: "Solo habla de ENVÍOS, no de devoluciones. Debe ser UNKNOWN.",
  },
  {
    id: "C04_unlimited",
    request: { buyer_country: "US", item_condition: "used", reason: "changed_mind" },
    page_text: "Our Guarantee. We stand behind everything we sell. If you are not satisfied with your purchase for any reason, you may return it at any time for a full refund or replacement. There is no time limit on returns of general merchandise.",
    // W27 · antes YES_WITH_CONDITIONS. Es el caso más limpio de los tres: la
    // cláusula NO nombra ni una sola condición. "Por cualquier motivo", "en
    // cualquier momento", "sin límite de tiempo". Que el artículo esté usado da
    // igual porque la política no condiciona nada al estado. Devolver
    // YES_WITH_CONDITIONS aquí era decir "hay condiciones" cuando no las hay.
    expected: { verdict: "YES" },
    note: "Ventana ilimitada y sin condiciones nombradas (W27).",
  },
  {
    id: "C05_expired_window_NO",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind", purchase_date: "2026-05-01", delivery_date: "2026-05-03" },
    page_text: "Return Policy. Items may be returned within 30 days of delivery for a refund. After 30 days all sales are considered final and no returns will be accepted.",
    expected: { verdict: "NO" },
    note: "30 días desde entrega (03-may) → vencido a fecha de hoy. deadline flipea a NO.",
  },
  {
    id: "C06_marketplace_3P_TRAP",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind", seller_name: "ThirdPartyGoodsLLC" },
    page_text: "Returns. Items sold and shipped by us can be returned within 30 days. Please note that items sold by third-party sellers on our marketplace are subject to each seller's own return policy, which may differ from ours.",
    expected: { verdict: "UNKNOWN" },
    trap: true,
    note: "Vendedor 3P: la política propia no aplica; su política no consta → UNKNOWN.",
  },
  {
    id: "C07_defective_exchange_only",
    request: { buyer_country: "US", item_condition: "defective", reason: "defective" },
    page_text: "Damaged or Defective Items. If your item arrives damaged or defective, contact us within 15 days for a free replacement of the same item. Defective items are eligible for replacement only; cash refunds are not provided for defective merchandise.",
    expected: { verdict: "YES_WITH_CONDITIONS", days: 15 },
    note: "Devolución/reemplazo SÍ (cambio), no reembolso en dinero. Sigue siendo returnable.",
  },
  {
    id: "C08_opened_beauty_ok",
    request: { buyer_country: "US", item_condition: "opened", reason: "changed_mind" },
    page_text: "Returns & Exchanges. Products may be returned within 60 days of purchase. Items must be returned in new or gently used condition. Gift cards and items marked final sale are not returnable.",
    expected: { verdict: "YES_WITH_CONDITIONS", days: 60 },
    note: "Abierto/usado con suavidad SÍ se acepta (rompe intuición 'abierto=no').",
  },
  {
    id: "C09_state_law_TRAP",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Alcohol Returns. Returns of alcoholic beverages are not accepted where prohibited by law. Where returns are permitted, unopened bottles may be returned within 30 days with receipt.",
    expected: { verdict: "UNKNOWN" },
    trap: true,
    note: "Depende del estado del comprador (no consta) → UNKNOWN honesto.",
  },
  {
    id: "C10_restocking_still_yes",
    request: { buyer_country: "US", item_condition: "opened", reason: "changed_mind" },
    page_text: "Return Policy. Most items may be returned within 30 days. Opened electronics in the video card and television categories are subject to a 15% restocking fee. Returns must include all original accessories and packaging.",
    expected: { verdict: "YES_WITH_CONDITIONS", days: 30 },
    note: "Con restocking sigue siendo returnable (con condición).",
  },
  {
    id: "C11_software_opened_NO",
    request: { buyer_country: "US", item_condition: "opened", reason: "changed_mind" },
    page_text: "Software & Digital. Opened software, digital downloads and activated license keys cannot be returned or refunded once the seal is broken or the code has been revealed. Unopened physical software may be returned within 15 days.",
    expected: { verdict: "NO" },
    note: "Software abierto = no.",
  },
  {
    id: "C12_contradiction_TRAP",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Help Center. Our friendly team is available 24/7. We accept most major credit cards and offer gift wrapping at checkout. Sign up for our newsletter to get 10% off your first order. For wholesale inquiries, email our sales team.",
    expected: { verdict: "UNKNOWN" },
    trap: true,
    note: "No dice NADA de devoluciones. Debe ser UNKNOWN, no inventar.",
  },
  {
    id: "C13_late_delivery_ok",
    request: { buyer_country: "US", item_condition: "unopened", reason: "arrived_late", purchase_date: "2026-08-10", delivery_date: "2026-08-18" },
    page_text: "Returns. You may return unused items within 30 days of the delivery date for a full refund. Original shipping charges are non-refundable unless the item was defective.",
    // W27 · antes YES_WITH_CONDITIONS. Única condición nombrada: "unused",
    // entrañada por `unopened`. Los gastos de envío originales no reembolsables
    // NO cuentan como condición de resultado: no cambian lo que el comprador
    // recibe POR EL ARTÍCULO, y el envío no se devuelve casi en ningún sitio.
    // Hay una prueba dedicada a ese límite en test/taxonomia.test.mjs.
    expected: { verdict: "YES", days: 30 },
    note: "Dentro de ventana desde entrega (18-ago). Sin condiciones pendientes (W27).",
  },
  {
    id: "C14_custom_final_NO",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Custom & Personalized Orders. Made-to-order and personalized items are produced specifically for you and are final sale. They cannot be returned, exchanged or refunded except in the case of a manufacturing defect. Standard catalog items follow our 30-day policy.",
    expected: { verdict: "NO" },
    note: "Custom = final en ESTE comercio (el otro vértice del 'custom').",
  },
  {
    id: "C15_health_sealed_NO",
    request: { buyer_country: "US", item_condition: "opened", reason: "changed_mind" },
    page_text: "Health & Personal Care. For hygiene and safety reasons, opened health, personal care and intimate items cannot be returned. Items that are still factory-sealed may be returned within 30 days of purchase.",
    expected: { verdict: "NO" },
    note: "Higiene: abierto = no.",
  },
  {
    id: "C16_store_credit_ok",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Returns. Unworn items with tags may be returned within 45 days. Returns made after 14 days receive store credit rather than a refund to the original payment method. Final sale items are not eligible.",
    expected: { verdict: "YES_WITH_CONDITIONS", days: 45 },
    note: "Devolución SÍ (crédito de tienda) dentro de 45 días.",
  },
  {
    id: "C17_ambiguous_days_conflict",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Return Policy. Returns are accepted within 30 days. Holiday purchases made in November and December may be returned until January 31. Some categories may have different windows as noted on the product page.",
    expected: { verdict: "YES_WITH_CONDITIONS", days: 30 },
    note: "Ventana estándar 30 días aplica al caso normal.",
  },
  {
    id: "C18_no_country_scope_TRAP",
    request: { buyer_country: "US", item_condition: "unopened", reason: "changed_mind" },
    page_text: "Rücksendungen. Artikel können innerhalb von 14 Tagen nach Erhalt zurückgegeben werden. Die Rücksendung ist für Kunden in Deutschland kostenlos. Bitte legen Sie den Lieferschein bei.",
    expected: { verdict: "UNKNOWN" },
    trap: true,
    note: "Política en alemán y para Alemania; comprador US no está cubierto → UNKNOWN.",
  },
];
