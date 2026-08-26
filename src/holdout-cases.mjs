// W06 — HOLDOUT DE 25 CASOS. No los escribimos nosotros.
//
// De donde salen: los preparo el equipo de ChatGPT y se corrieron contra produccion
// el 24 de agosto (25 casos x 5 pasadas = 125 llamadas). Veredicto de entonces:
// NO-GO. Peor pasada: 50 % de cobertura sobre resolubles, 63,6 % de precision
// afirmada, hasta 4 errores peligrosos, y solo 11 de 25 casos estables.
//
// Desde entonces han entrado diez cambios (W01b, W02, W03, W04, W05, W07, W08,
// W09, W10, W11, W12) y NADIE ha vuelto a correrlo. Es el unico numero que hoy
// puede decir algo que no sepamos: el banco de 18 lo escribimos nosotros y esta
// en su techo.
//
// DOS COSAS QUE HAY QUE SABER ANTES DE LEER EL RESULTADO:
//
// 1. TECHO DE COBERTURA = 80,0 %. Cinco de los 25 casos esperan UNKNOWN. O sea
//    que el criterio de H4 de "cobertura >= 80 %" sobre ESTE banco no es un
//    aprobado holgado: es la perfeccion, sin un solo caso de margen.
//
// 2. TAXONOMIA. El holdout distingue YES de YES_WITH_CONDITIONS. En las 125
//    llamadas de agosto el motor no emitio ni un solo YES: convierte toda
//    devolucion permitida en YES_WITH_CONDITIONS. Por eso se puntua DOS veces —
//    estricta (etiquetas distintas) y operativa (ambas cuentan como POSITIVE) —
//    y se informan las dos. Cual de las dos es la buena es una decision de
//    producto que sigue abierta, no un detalle de medicion.
//
// Adaptador congelado el 24 ago, reproducido tal cual para que sea comparable:
//   country -> buyer_country · condition -> item_condition
//   wrong_size -> wrong_size_or_model · damaged_in_transit -> defective
// membership y purchase_channel se envian sin tocar (W03 ya los soporta).

export const HOLDOUT_CASES = [
  {
    id: "RC25-01",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-01", "delivery_date": "2026-08-05", "as_of": "2026-08-20", "seller_name": "Northstar Retail", "purchase_channel": "online"},
    page_text: "Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery. Items must be unopened and include all original accessories. Approved returns are refunded to the original payment method.",
    expected: {"verdict": "YES", "days": 30, "window_basis": "delivery_date", "deadline": "2026-09-04"},
    note: "Unopened standard merchandise is within the stated 30-day delivery-based window.",
  },
  {
    id: "RC25-02",
    request: {"buyer_country": "US", "item_condition": "opened", "reason": "changed_mind", "purchase_date": "2026-08-06", "delivery_date": "2026-08-10", "as_of": "2026-08-20", "seller_name": "BluePine Electronics", "purchase_channel": "online"},
    page_text: "Opened headphones may be exchanged, but not refunded, within 14 calendar days after delivery. The customer must return the headphones with the serial-numbered box and all included parts.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 14, "window_basis": "delivery_date", "deadline": "2026-08-24"},
    note: "The opened item is eligible only for exchange and requires the box and parts.",
  },
  {
    id: "RC25-03",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "wrong_size_or_model", "purchase_date": "2026-08-12", "delivery_date": "2026-08-15", "as_of": "2026-08-20", "seller_name": "Coastline Apparel", "purchase_channel": "online"},
    page_text: "All merchandise marked Final Sale, including clearance swimwear, is not eligible for return, refund, exchange, or store credit.",
    expected: {"verdict": "NO"},
    note: "The policy explicitly excludes this final-sale category.",
  },
  {
    id: "RC25-04",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-08", "delivery_date": "2026-08-12", "as_of": "2026-08-20", "seller_name": "BrightHome Partners", "purchase_channel": "marketplace"},
    page_text: "Products sold and shipped by MarketHub may be returned within 30 days of delivery. Products sold by marketplace partners are governed by the individual seller's return policy.",
    expected: {"verdict": "UNKNOWN"},
    trap: true,
    note: "The supplied policy covers MarketHub-owned items and defers partner sales to an absent seller-specific policy.",
  },
  {
    id: "RC25-05",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-11-20", "delivery_date": "2026-11-25", "as_of": "2027-01-10", "seller_name": "Evergreen Gifts", "purchase_channel": "online"},
    page_text: "Purchases made from November 1 through December 24 may be returned within 60 calendar days of the purchase date. Eligible merchandise receives a refund to the original payment method.",
    expected: {"verdict": "YES", "days": 60, "window_basis": "purchase_date", "deadline": "2027-01-19"},
    note: "The purchase is in the holiday range and the as-of date is inside the 60-day purchase-based window.",
  },
  {
    id: "RC25-06",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-06-27", "delivery_date": "2026-07-01", "as_of": "2026-08-02", "seller_name": "RedMaple Home", "purchase_channel": "online"},
    page_text: "Standard merchandise may be returned within 30 calendar days after delivery. Returns received after the 30-day window are not accepted.",
    expected: {"verdict": "NO", "days": 30, "window_basis": "delivery_date", "deadline": "2026-07-31"},
    note: "The as-of date is after the explicit 30-day delivery-based deadline.",
  },
  {
    id: "RC25-07",
    request: {"buyer_country": "US", "item_condition": "defective", "reason": "defective", "purchase_date": "2026-08-10", "delivery_date": "2026-08-15", "as_of": "2026-08-20", "seller_name": "Parcel & Co.", "purchase_channel": "online"},
    page_text: "Items damaged in transit qualify for a refund or replacement only when the customer contacts support within 7 calendar days after delivery and provides photographs of the shipping box and damaged item.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 7, "window_basis": "delivery_date", "deadline": "2026-08-22"},
    note: "The claim is timely but requires support contact and photographs.",
  },
  {
    id: "RC25-08",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-14", "delivery_date": "2026-08-18", "as_of": "2026-08-20", "seller_name": "Monogram House", "purchase_channel": "online"},
    page_text: "Personalized, monogrammed, and engraved products are made to order and cannot be returned or exchanged unless the product arrived damaged or was produced incorrectly.",
    expected: {"verdict": "NO"},
    note: "The item is personalized and the stated reason is changed mind, not either exception.",
  },
  {
    id: "RC25-09",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-09", "delivery_date": "2026-08-12", "as_of": "2026-08-20", "seller_name": "SoftBox Store", "purchase_channel": "online"},
    page_text: "Physical software packages may be returned for a refund within 14 calendar days after delivery if the activation seal remains intact and the package has not been opened.",
    expected: {"verdict": "YES", "days": 14, "window_basis": "delivery_date", "deadline": "2026-08-26"},
    note: "The supplied condition satisfies the intact/unopened rule and the request is timely.",
  },
  {
    id: "RC25-10",
    request: {"buyer_country": "US", "item_condition": "opened", "reason": "changed_mind", "purchase_date": "2026-08-09", "delivery_date": "2026-08-12", "as_of": "2026-08-20", "seller_name": "SoftBox Store", "purchase_channel": "online"},
    page_text: "Opened or activated software is not returnable. Unopened physical software may be returned within 14 calendar days after delivery.",
    expected: {"verdict": "NO"},
    note: "The query states that the software is opened.",
  },
  {
    id: "RC25-11",
    request: {"buyer_country": "US", "item_condition": "opened", "reason": "changed_mind", "purchase_date": "2026-08-01", "delivery_date": "2026-08-05", "as_of": "2026-08-20", "seller_name": "Circuit Barn", "purchase_channel": "online"},
    page_text: "Opened cameras may be returned within 30 calendar days after delivery when all accessories are included. A 15 percent restocking fee is deducted from the refund.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 30, "window_basis": "delivery_date", "deadline": "2026-09-04"},
    note: "The return is timely but depends on accessories and carries a restocking fee.",
  },
  {
    id: "RC25-12",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-07-01", "delivery_date": "2026-07-05", "as_of": "2026-08-15", "seller_name": "ClubMarket", "purchase_channel": "online", "membership": "Plus"},
    page_text: "ClubMarket Plus members may return eligible standard merchandise within 90 calendar days of purchase. Customers without an active Plus membership have 30 calendar days from purchase.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 90, "window_basis": "purchase_date", "deadline": "2026-09-29"},
    note: "Eligibility depends on the stated active Plus membership; the request is within 90 days.",
  },
  {
    id: "RC25-13",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "wrong_size_or_model", "purchase_date": "2026-08-08", "delivery_date": "2026-08-12", "as_of": "2026-08-20", "seller_name": "Northern Outfitters", "purchase_channel": "online"},
    page_text: "Canada Return Policy. Orders delivered to Canadian addresses may be returned within 30 days of delivery. Refunds are issued in Canadian dollars. This policy applies only to purchases made on our Canadian storefront.",
    expected: {"verdict": "UNKNOWN"},
    trap: true,
    note: "The supplied policy explicitly applies only to Canada while the buyer country is US.",
  },
  {
    id: "RC25-14",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-08", "delivery_date": "2026-08-12", "as_of": "2026-08-20", "seller_name": "SwiftShip Store", "purchase_channel": "online"},
    page_text: "Shipping Information. Standard delivery takes 3 to 5 business days. Expedited delivery takes 1 to 2 business days. Shipping fees are calculated at checkout. Tracking details are emailed after dispatch.",
    expected: {"verdict": "UNKNOWN"},
    trap: true,
    note: "The page contains shipping information only and no return rule.",
  },
  {
    id: "RC25-15",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-08", "delivery_date": "2026-08-12", "as_of": "2026-08-20", "seller_name": "Harbor Kitchen", "purchase_channel": "online"},
    page_text: "Customer Help. You can view order status in your account, download an invoice, update a delivery address before dispatch, or contact support for product questions. Support is available Monday through Friday.",
    expected: {"verdict": "UNKNOWN"},
    trap: true,
    note: "The help text contains no return eligibility evidence.",
  },
  {
    id: "RC25-16",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-05", "delivery_date": "2026-08-10", "as_of": "2026-08-20", "seller_name": "OfficeDeals LLC", "purchase_channel": "marketplace"},
    page_text: "Items sold directly by Central Marketplace may be returned within 30 days of delivery. This policy does not apply to independent marketplace sellers, whose return terms appear on the seller profile.",
    expected: {"verdict": "UNKNOWN"},
    trap: true,
    note: "The item is sold by an independent marketplace seller and the applicable seller policy is absent.",
  },
  {
    id: "RC25-17",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-08-06", "delivery_date": "2026-08-10", "as_of": "2026-08-20", "seller_name": "PureCare", "purchase_channel": "online"},
    page_text: "For hygiene reasons, electric toothbrushes may be returned within 14 calendar days after delivery only when the retail seal is unbroken. Opened hygiene products are not eligible for return.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 14, "window_basis": "delivery_date", "deadline": "2026-08-24"},
    note: "The item is timely and unopened, but eligibility depends on the hygiene seal.",
  },
  {
    id: "RC25-18",
    request: {"buyer_country": "US", "item_condition": "opened", "reason": "changed_mind", "purchase_date": "2026-08-06", "delivery_date": "2026-08-10", "as_of": "2026-08-20", "seller_name": "PureCare", "purchase_channel": "online"},
    page_text: "Opened personal-care and hygiene products cannot be returned. Unopened products with the retail seal intact may be returned within 14 calendar days after delivery.",
    expected: {"verdict": "NO"},
    note: "The query states that the hygiene product is opened.",
  },
  {
    id: "RC25-19",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-07-25", "delivery_date": "2026-08-01", "as_of": "2026-08-20", "seller_name": "OakRoom Furniture", "purchase_channel": "online"},
    page_text: "Furniture may be returned within 30 calendar days after delivery. Home pickup is required for assembled furniture, and a 49 dollar pickup fee is deducted from the refund.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 30, "window_basis": "delivery_date", "deadline": "2026-08-31"},
    note: "The return is timely but requires pickup and carries a fee.",
  },
  {
    id: "RC25-20",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "wrong_size_or_model", "purchase_date": "2026-08-02", "delivery_date": "2026-08-06", "as_of": "2026-08-20", "seller_name": "Urban Thread", "purchase_channel": "online"},
    page_text: "Seasonal collection items may be returned within 21 calendar days of purchase. Eligible returns receive store credit only; refunds to the original payment method are not offered.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 21, "window_basis": "purchase_date", "deadline": "2026-08-23"},
    note: "The item is timely but the remedy is store credit only.",
  },
  {
    id: "RC25-21",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "wrong_size_or_model", "purchase_date": "2026-08-18", "as_of": "2026-08-24", "seller_name": "Factory Outlet", "purchase_channel": "store"},
    page_text: "Outlet purchases may be returned within 7 calendar days of purchase. They must be returned in person to a Factory Outlet location with the receipt and original packaging.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 7, "window_basis": "purchase_date", "deadline": "2026-08-25"},
    note: "The store purchase is timely but must be returned in person with receipt and packaging.",
  },
  {
    id: "RC25-22",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "wrong_size_or_model", "purchase_date": "2026-08-18", "as_of": "2026-08-20", "seller_name": "Factory Outlet", "purchase_channel": "store"},
    page_text: "Clearance merchandise labeled Final Sale is not eligible for return, exchange, or store credit, even when unused and accompanied by a receipt.",
    expected: {"verdict": "NO"},
    note: "The policy explicitly excludes final-sale clearance merchandise.",
  },
  {
    id: "RC25-23",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "changed_mind", "purchase_date": "2026-07-10", "delivery_date": "2026-07-15", "as_of": "2026-08-20", "seller_name": "GiftLane", "purchase_channel": "online"},
    page_text: "Gift recipients may return eligible unopened merchandise within 45 calendar days after delivery. Without the purchaser's original payment card, the refund is issued as GiftLane store credit.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 45, "window_basis": "delivery_date", "deadline": "2026-08-29"},
    note: "The gift return is timely but the recipient receives store credit without the purchaser's card.",
  },
  {
    id: "RC25-24",
    request: {"buyer_country": "US", "item_condition": "defective", "reason": "defective", "purchase_date": "2026-07-28", "delivery_date": "2026-08-01", "as_of": "2026-08-20", "seller_name": "ToolWorks", "purchase_channel": "online"},
    page_text: "Defective power tools reported within 30 calendar days after delivery qualify for replacement with the same model. Cash refunds are not available under this defective-item program.",
    expected: {"verdict": "YES_WITH_CONDITIONS", "days": 30, "window_basis": "delivery_date", "deadline": "2026-08-31"},
    note: "The defective item is timely but qualifies for replacement only.",
  },
  {
    id: "RC25-25",
    request: {"buyer_country": "US", "item_condition": "unopened", "reason": "wrong_size_or_model", "purchase_date": "2026-08-04", "delivery_date": "2026-08-08", "as_of": "2026-08-20", "seller_name": "Meadow Style", "purchase_channel": "online"},
    page_text: "Regular-price apparel may be returned for a refund within 30 calendar days after delivery when it is unworn and the original tags remain attached.",
    expected: {"verdict": "YES", "days": 30, "window_basis": "delivery_date", "deadline": "2026-09-07"},
    note: "The supplied condition satisfies the apparel rule and the request is timely.",
  },
];
