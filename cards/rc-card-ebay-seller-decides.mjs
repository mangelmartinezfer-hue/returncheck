// FICHA DE EVIDENCIA — ebay.com. BORRADOR. NO PUBLICADA.
//
// Esta es la ficha numero dos del orden acordado. Existe ya, a medias y a la
// vista, porque un borrador en el repositorio se revisa; uno en la cabeza de
// alguien, no. Y porque hace de sujeto de la prueba que importa: una ficha sin
// publicar tiene que dar 404, no un borrador.
//
// LO QUE FALTA, y es exactamente una cosa: las CLAUSULAS LITERALES del tablero
// maestro. La forma de la politica de eBay la sabemos —el vendedor fija su propia
// politica, salvo que el articulo llegue roto o no sea el descrito, donde entra la
// garantia de la casa— pero saber la forma no es tener la cita. Los campos
// `clause` van vacios a proposito: escribirlos de memoria seria inventar una cita,
// que es la unica cosa que esta ficha no puede permitirse.
//
// Mientras un `clause` este vacio, esPublicable() la rechaza aunque alguien ponga
// published: true. La puerta no se abre por descuido.
export default {
  card_id: "rc-card-ebay-seller-decides",
  merchant: "ebay",
  merchant_name: "eBay",
  country: "US",

  published: false,

  verified_on: "2026-08-20",
  source_url: "https://www.ebay.com/help/policies/member-behaviour-policies/returns",

  question: "Can I return an eBay purchase?",
  answer: "conditional",
  depends_on: ["seller_name", "item_condition", "reason"],

  page: {
    title: "eBay returns: the seller decides — unless the item arrives broken",
    meta_title: "eBay returns: who sets the policy, and when it stops mattering — ReturnCheck",
    meta_description:
      "On eBay the return window is set by each seller, not by eBay. There is one case where that does not apply. Verified clauses, sources and dates.",
    lede:
      "There is no eBay return window. Each seller sets their own, and two listings for the same product can differ. The exception is the item that arrives damaged or is not what was described.",
    outcomes_heading: "What decides the answer",
    denials_heading: "Where the seller's policy stops applying",
    example: {
      q: "Two listings, same headphones, same price. Same return rights?",
      a: "Not necessarily. One seller may accept 30-day returns and the other none at all — that is a per-listing setting, shown on the listing itself. If the headphones arrive broken, neither policy is what governs.",
    },
  },

  outcomes: [
    {
      days: null,
      basis: "delivery",
      when: "seller accepts returns (window set per listing)",
      when_long: "set by the seller, shown on the listing",
      conditions: [],
      conditions_text:
        "The return window and who pays return shipping are chosen by the seller and published on the listing.",
      clause: "",                 // PENDIENTE — literal del tablero maestro
      source_url: "https://www.ebay.com/help/policies/member-behaviour-policies/returns",
      source_label: "eBay returns policy",
      verified_on: "2026-08-20",
      tone: "limit",
    },
    {
      days: null,
      basis: "delivery",
      when: "item arrived damaged or not as described",
      when_long: "regardless of the seller's own policy",
      conditions: ["defective_or_not_as_described"],
      conditions_text:
        "eBay's own guarantee covers this case even when the seller states they accept no returns.",
      clause: "",                 // PENDIENTE — literal del tablero maestro
      source_url: "https://www.ebay.com/help/policies/member-behaviour-policies/returns",
      source_label: "eBay Money Back Guarantee",
      verified_on: "2026-08-20",
      tone: "allow",
    },
  ],

  denials: [],
};
