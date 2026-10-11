// FICHA DE EVIDENCIA — ebay.com, quien decide la devolucion.
//
// ESTE FICHERO ES DATO, NO CODIGO. Se edita a mano y se lee en el diff antes de
// publicar. La forma de la pagina y del gemelo JSON vive en src/cards.mjs.
//
// PROCEDENCIA: tablero maestro, bloque de reglas normalizadas. Van LITERALES.
//
// RECAPTURA 11 OCT 2026. Las tres clausulas se cotejaron contra las paginas
// oficiales con navegador real y sus capturas quedan archivadas en
// test/fixtures/ebay-returning-item-2026-10-11.txt y
// test/fixtures/ebay-money-back-guarantee-2026-10-11.txt (extracto).
//
// UNA NO COINCIDIA. La primera clausula publicaba «see the seller's full return
// policy». La pagina 4041 dice «Check the listing in your Purchases ... for the
// seller's full return policy»: el verbo «see» no esta en la fuente. Se corrige
// al fragmento literal verificado, «for the seller's full return policy», y las
// tres fechas pasan a 2026-10-11 porque hoy hay captura propia de las tres.
// Lo encontro el guarda estricto de citas: era exactamente el patron que rechaza.
//
// Cambio de opinion y falta de conformidad requieren revisar reglas distintas.
// La garantia puede cubrir una transaccion aunque el vendedor no acepte
// devoluciones, pero exige requisitos: no anula universalmente su politica.
//
// Ninguna rama exporta days/basis. Dos citas no dan plazo; la segunda contiene
// 30 dias, pero su origen estimated/actual no cabe en el basis delivery simple.
// Conservamos la cita sin convertirla en una ventana universal calculable.
// Esta correccion no es una nueva captura: las fechas historicas se conservan.
export default {
  card_id: "rc-card-ebay-seller-decides",
  merchant: "ebay",
  merchant_name: "eBay",
  country: "US",

  // Publicada el 31 ago 2026 con los literales del tablero ya pegados.
  published: true,

  verified_on: "2026-10-11",
  source_url:
    "https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210",

  question: "Can I return an eBay purchase?",
  answer: "conditional",
  depends_on: ["seller_name", "item_condition", "reason"],

  page: {
    title: "eBay returns depend on the listing and the reason",
    meta_title: "eBay returns: seller terms and guarantee eligibility — ReturnCheck",
    meta_description:
      "Review the listing, return reason and eBay Money Back Guarantee eligibility. Source clauses and dates, with unresolved terms kept explicit.",
    lede:
      "For a change of mind, check the seller's return terms on the listing. An item that is damaged, faulty or not as described may qualify for eBay Money Back Guarantee even if the seller does not accept returns. Coverage depends on eligibility requirements, deadlines and exclusions.",
    outcomes_heading: "Who decides, and when",
    denials_heading: "Coverage limits",
    example: {
      q: "Two listings, same headphones, same price. Same return rights?",
      a: "For a change of mind, compare each listing's return terms. If the headphones arrive broken, check Money Back Guarantee eligibility rather than treating «no returns» as a complete answer. The cited time limit refers to the estimated or actual delivery date; check the full rule, any seller's longer window and exclusions before calculating a deadline.",
    },
  },

  outcomes: [
    {
      days: null,
      when: "changed your mind — the seller's own policy decides",
      when_long: "set by the seller, published on the listing",
      conditions: ["seller_accepts_returns"],
      conditions_text:
        "eBay does not set this window. The return period, and who pays return shipping, are chosen by the seller and shown on the listing.",
      clause: "for the seller's full return policy",
      source_url: "https://www.ebay.com/help/buying/returns-refunds/returning-item?id=4041",
      source_label: "Returning an item",
      verified_on: "2026-10-11",
      tone: "limit",
    },
    {
      days: null,
      when: "item arrived damaged, faulty, or not as described — if the transaction is eligible",
      when_long: "Money Back Guarantee timing requires the full rule",
      conditions: ["defective_or_not_as_described"],
      conditions_text:
        "The quoted rule refers to the estimated or actual delivery date. A single delivery anchor does not express that choice. Check eligibility requirements, any seller's longer window and exclusions in the full policy; this card does not calculate a deadline.",
      clause: "30 calendar days after the estimated or actual delivery date",
      source_url:
        "https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210",
      source_label: "eBay Money Back Guarantee",
      verified_on: "2026-10-11",
      tone: "allow",
    },
    {
      days: null,
      when: "the seller accepts no returns, but the item is not as described — if the transaction is eligible",
      when_long: "no returns does not by itself exclude guarantee coverage",
      conditions: ["defective_or_not_as_described"],
      conditions_text:
        "The cited clause allows coverage despite a seller's no-returns policy. The transaction must still meet the guarantee's eligibility requirements and deadlines; exclusions apply.",
      clause:
        "they are entitled to return it for a refund, even if the seller doesn't offer returns",
      source_url:
        "https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210",
      source_label: "eBay Money Back Guarantee",
      verified_on: "2026-10-11",
      tone: "allow",
    },
  ],

  denials: [],
};
