// FICHA DE EVIDENCIA — ikea.com US, 365 o 180 segun el estado del articulo.
//
// ESTE FICHERO ES DATO, NO CODIGO. Se edita a mano y se lee en el diff antes de
// publicar. La forma de la pagina y del gemelo JSON vive en src/cards.mjs.
//
// PROCEDENCIA: las dos paginas publicas de IKEA US, leidas con navegador real el
// 9 de octubre de 2026 y conservadas con su sha256. Las clausulas van LITERALES.
// La clausula de 365/180 es identica, palabra por palabra, a la capturada el 28 de
// agosto de 2026: seis semanas sin cambiar.
//
// LO QUE HACE UTIL A ESTA FICHA: la duracion esta clarisima y el comienzo del plazo
// NO SE DICE EN NINGUNA PARTE. Ni la pagina corta ni la politica completa dicen si
// los 365 o los 180 dias corren desde la compra, desde la entrega o desde otra cosa.
// Por eso `basis` va a null en los dos casos. Es exactamente lo que el motor
// responde en produccion: plazo si, ancla no.
//
// EL OTRO HALLAZGO: IKEA publica la politica en dos paginas de distinta
// completitud. La corta, que es la que suele encontrarse primero, da el 365/180 y
// nada mas. La completa anade exclusiones, una tercera ventana para colchones y
// requisitos de identificacion. Quien lea solo la corta se queda con media politica.
//
// «with your proof of purchase» NO ES UN ANCLA. Es un documento que hay que
// presentar, no el evento que empieza a contar. Confundirlos fue un defecto real del
// motor, corregido en la PR #9.
export default {
  card_id: "rc-card-ikea-365-or-180",
  merchant: "ikea",
  merchant_name: "IKEA",
  country: "US",

  published: true,

  verified_on: "2026-10-09",
  source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",

  question: "How long do I have to return something to IKEA?",
  answer: "conditional",
  depends_on: ["item_condition", "product_type"],

  page: {
    title: "IKEA returns: 365 days, or 180 once you open the box",
    meta_title: "IKEA returns: 365 or 180 days, and the date nobody states — ReturnCheck",
    meta_description:
      "IKEA US gives 365 days on unopened products and 180 once opened. Neither policy page says what the countdown starts from. Verified clauses, sources and dates.",
    lede:
      "Opening the box halves the window: 365 days unopened, 180 opened. The duration is stated plainly. What is not stated anywhere — not on the short page, not on the full policy — is the date the countdown starts from. «With your proof of purchase» is a document you must bring, not the day the clock begins.",
    outcomes_heading: "How long, and on what",
    denials_heading: "What is excluded, whatever the window says",
    example: {
      q: "I bought a shelf 200 days ago and opened the box to check the parts. Can I still return it?",
      a: "The 365-day window is for unopened products; once opened it is 180 days, so 200 days is outside it. But IKEA never states what day either window counts from, so whether you are at day 200 of anything is not something the policy lets you prove. That is the honest answer, and it is why a number alone is not a verdict.",
    },
  },

  outcomes: [
    {
      days: 365,
      basis: null,
      when: "the product is new and unopened",
      when_long: "days, unopened — start date not stated",
      conditions: ["unopened", "proof_of_purchase"],
      conditions_text:
        "The clause requires proof of purchase. It does not say whether the 365 days run from the purchase, from the delivery, or from anything else.",
      clause:
        "you can return new and unopened products within 365 days, together with your proof of purchase, for a full refund",
      source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",
      source_label: "IKEA US return policy",
      verified_on: "2026-10-09",
      tone: "allow",
    },
    {
      days: 180,
      basis: null,
      when: "the product has been opened",
      when_long: "days, opened — start date not stated",
      conditions: ["opened", "proof_of_purchase"],
      conditions_text:
        "Opening the box halves the window. The start date is not stated for this branch either.",
      clause:
        "You may also return open products within 180 days, with your proof of purchase, for a full refund.",
      source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",
      source_label: "IKEA US return policy",
      verified_on: "2026-10-09",
      tone: "limit",
    },
    {
      days: 90,
      basis: null,
      when: "a mattress, exchanged for another mattress",
      when_long: "days, mattresses — one exchange, not a refund",
      conditions: ["mattress"],
      conditions_text:
        "This is an exchange for another mattress, once, and it is a third window that the short page does not mention at all.",
      clause:
        "Mattress purchases may be exchanged for another mattress one time within 90 days.",
      source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",
      source_label: "IKEA US return policy",
      verified_on: "2026-10-09",
      tone: "limit",
    },
  ],

  denials: [
    {
      scope: "product_type",
      clause:
        "We do not accept returns on plants, cut fabric, custom countertops and as-is products.",
      source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",
      source_label: "IKEA US return policy",
      verified_on: "2026-10-09",
    },
    {
      scope: "item_condition",
      clause:
        "We are unable to refund or exchange your items if your merchandise is found to be modified from its original form when purchased, dirty, stained, or damaged.",
      source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",
      source_label: "IKEA US return policy",
      verified_on: "2026-10-09",
    },
    {
      scope: "channel",
      clause:
        "Returns are not accepted at IKEA Planning Studio or IKEA Pick Up Point locations.",
      source_url: "https://www.ikea.com/us/en/customer-service/returns-claims/",
      source_label: "IKEA US return policy",
      verified_on: "2026-10-09",
    },
  ],
};
