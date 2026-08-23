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
    expected: { verdict: "YES_WITH_CONDITIONS", days: 30 },
    note: "Ventana clara de 30 días.",
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
    expected: { verdict: "YES_WITH_CONDITIONS" },
    note: "Ventana ilimitada (UnlimitedWindow).",
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
    expected: { verdict: "YES_WITH_CONDITIONS", days: 30 },
    note: "Dentro de ventana desde entrega (18-ago).",
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
