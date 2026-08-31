// FICHA DE EVIDENCIA — costco.com, garantia de satisfaccion.
//
// ESTE FICHERO ES DATO, NO CODIGO. Se edita a mano y se lee en el diff antes de
// publicar. La forma de la pagina y del gemelo JSON vive en src/cards.mjs.
//
// PROCEDENCIA: tablero maestro, bloque de reglas normalizadas. Las tres clausulas
// salen de la misma pagina de atencion al cliente de Costco y se verificaron el
// 20 ago 2026. Van LITERALES.
//
// LO QUE HACE RARA A ESTA FICHA: es la contraria de las otras dos. En Target y en
// eBay la pregunta es cuantos dias hay; aqui la regla general NO TIENE PLAZO, y lo
// interesante son las dos excepciones. Por eso el primer bloque lleva days: null y
// pinta una raya en vez de una cifra: la clausula no dice ningun numero, y la ficha
// no dice mas de lo que dice la clausula.
export default {
  card_id: "rc-card-costco-satisfaction-guaranteed",
  merchant: "costco",
  merchant_name: "Costco",
  country: "US",

  published: true,

  verified_on: "2026-08-20",
  source_url:
    "https://customerservice.costco.com/app/answers/detail/a_id/1191/~/what-is-costcos-return-policy%3F",

  question: "How long do I have to return a Costco purchase?",
  answer: "conditional",
  depends_on: ["product_category"],

  page: {
    title: "Costco returns: is there really no time limit?",
    meta_title: "Costco returns: no deadline — except in two places — ReturnCheck",
    meta_description:
      "Costco's satisfaction guarantee states no return deadline. Electronics have one, and precious metals cannot be returned at all. Verified clauses, sources and dates.",
    lede:
      "For most of what Costco sells, the guarantee names no deadline at all. That is genuinely unusual, and it is also not the whole answer: two categories are carved out of it, and one of them cannot be returned at any point.",
    outcomes_heading: "The general rule, and where it stops",
    denials_heading: "And where there is no return at all",
    example: {
      q: "A set of pans bought three years ago, and a television bought six months ago. Which can you return?",
      a: "The pans. The satisfaction guarantee names no deadline, so age alone does not close it. The television is electronics, and that carve-out ran out at 90 days from delivery — the guarantee that covers the pans does not reopen it.",
    },
  },

  outcomes: [
    {
      days: null,
      basis: "delivery",
      when: "most products — satisfaction guarantee",
      when_long: "no deadline stated — satisfaction guarantee",
      conditions: [],
      conditions_text:
        "The clause names no time limit. It is a guarantee of satisfaction with the product, not a counted window.",
      clause:
        "We guarantee your satisfaction on every product we sell, and will refund your purchase price",
      source_url:
        "https://customerservice.costco.com/app/answers/detail/a_id/1191/~/what-is-costcos-return-policy%3F",
      source_label: "What is Costco's return policy?",
      verified_on: "2026-08-20",
      tone: "allow",
    },
    {
      days: 90,
      basis: "delivery",
      when: "electronics",
      when_long: "days from delivery — electronics",
      conditions: [],
      conditions_text:
        "Electronics are carved out of the open-ended guarantee and given a counted window instead.",
      clause: "Electronics: Costco will accept returns within 90 days",
      source_url:
        "https://customerservice.costco.com/app/answers/detail/a_id/1191/~/what-is-costcos-return-policy%3F",
      source_label: "What is Costco's return policy?",
      verified_on: "2026-08-20",
      tone: "limit",
    },
  ],

  denials: [
    {
      scope: "precious metals",
      label: "Precious metals — no return at all",
      clause: "Precious metals are non-refundable.",
      source_label: "costco.com",
      verified_on: "2026-08-20",
    },
  ],
};
