// FICHA DE EVIDENCIA — ebay.com, quien decide la devolucion.
//
// ESTE FICHERO ES DATO, NO CODIGO. Se edita a mano y se lee en el diff antes de
// publicar. La forma de la pagina y del gemelo JSON vive en src/cards.mjs.
//
// PROCEDENCIA: tablero maestro, bloque de reglas normalizadas. Las tres clausulas
// verificadas el 20 ago 2026. Van LITERALES.
//
// LO QUE HACE RARA A ESTA FICHA, y la razon de que sea la segunda: en eBay no hay
// una ventana. Hay una politica por vendedor, y encima de ella una garantia de la
// casa que la pisa. La tercera clausula es la que lo dice con todas las letras —
// «even if the seller doesn't offer returns»— y es justo el dato que no se puede
// sacar mirando el anuncio, que es de lo que va todo esto.
//
// NUMEROS QUE NO SE HAN PUESTO: la primera y la tercera clausula no dicen ningun
// plazo, asi que `days` va a null y la pagina pinta una raya. Poner 30 en la
// tercera porque sale de la misma pagina de la garantia seria juntar dos hechos
// para fabricar un tercero. Lo que la cita no dice, la ficha no lo dice.
export default {
  card_id: "rc-card-ebay-seller-decides",
  merchant: "ebay",
  merchant_name: "eBay",
  country: "US",

  // Publicada el 31 ago 2026 con los literales del tablero ya pegados.
  published: true,

  verified_on: "2026-08-20",
  source_url:
    "https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210",

  question: "Can I return an eBay purchase?",
  answer: "conditional",
  depends_on: ["seller_name", "item_condition", "reason"],

  page: {
    title: "eBay returns: the seller decides — until the item arrives broken",
    meta_title: "eBay returns: who sets the policy, and when it stops mattering — ReturnCheck",
    meta_description:
      "On eBay the return window is set by each seller, not by eBay. There is one case where the seller's policy stops deciding. Verified clauses, sources and dates.",
    lede:
      "There is no eBay return window. Each seller sets their own, and two listings for the same product can differ. But if the item is not what was described, eBay's own guarantee applies — including to a seller who accepts no returns at all.",
    outcomes_heading: "Who decides, and when",
    denials_heading: "Where the seller's policy stops applying",
    example: {
      q: "Two listings, same headphones, same price. Same return rights?",
      a: "Not for a change of mind: one seller may accept returns and the other none at all, and that is a per-listing setting you have to read on the listing itself. If the headphones arrive broken, the seller's «no returns» is not what decides it — the guarantee is, and it runs 30 days from delivery.",
    },
  },

  outcomes: [
    {
      days: null,
      basis: "delivery",
      when: "changed your mind — the seller's own policy decides",
      when_long: "set by the seller, published on the listing",
      conditions: ["seller_accepts_returns"],
      conditions_text:
        "eBay does not set this window. The return period, and who pays return shipping, are chosen by the seller and shown on the listing.",
      clause: "see the seller's full return policy",
      source_url: "https://www.ebay.com/help/buying/returns-refunds/returning-item?id=4041",
      source_label: "Returning an item",
      verified_on: "2026-08-20",
      tone: "limit",
    },
    {
      days: 30,
      basis: "delivery",
      when: "item arrived damaged, faulty, or not as described",
      when_long: "days from delivery — eBay Money Back Guarantee",
      conditions: ["defective_or_not_as_described"],
      conditions_text:
        "Counted from the estimated or actual delivery date, whichever applies to your order.",
      clause: "30 calendar days after the estimated or actual delivery date",
      source_url:
        "https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210",
      source_label: "eBay Money Back Guarantee",
      verified_on: "2026-08-20",
      tone: "allow",
    },
    {
      days: null,
      basis: "delivery",
      when: "the seller accepts no returns, but the item is not as described",
      when_long: "the guarantee overrides the seller's policy",
      conditions: ["defective_or_not_as_described"],
      conditions_text:
        "This is the clause a listing will not tell you about: «no returns accepted» does not settle the question when the item is not what was described.",
      clause:
        "they are entitled to return it for a refund, even if the seller doesn't offer returns",
      source_url:
        "https://www.ebay.com/help/policies/ebay-money-back-guarantee-policy/ebay-money-back-guarantee-policy?id=4210",
      source_label: "eBay Money Back Guarantee",
      verified_on: "2026-08-20",
      tone: "allow",
    },
  ],

  denials: [],
};
