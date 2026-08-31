// FICHA DE EVIDENCIA — target.com, ventana de devolucion.
//
// ESTE FICHERO ES DATO, NO CODIGO. No hay logica aqui y no debe haberla: se edita
// a mano, se lee en el diff antes de publicar y quien lo revisa no tiene por que
// saber JavaScript. La forma de la pagina y del gemelo JSON vive en src/cards.mjs.
//
// POR QUE .mjs Y NO .json, que seria lo natural: importar un .json necesita hoy
// `with { type: "json" }` en Node 24, y el esbuild que trae wrangler 3.114 (0.17.19)
// no sabe leer esa sintaxis — comprobado, no supuesto: «Expected ";" but found
// "with"». Un modulo de datos puros funciona en los dos sin paso de compilacion.
//
// PROCEDENCIA: tablero maestro, bloque de reglas normalizadas. Verificado el
// 20 ago 2026 contra las paginas de ayuda de target.com. Las clausulas van
// LITERALES: no se parafrasean, no se completan, no se redondean.
export default {
  card_id: "rc-card-target-who-sold-it",
  merchant: "target",
  merchant_name: "Target",
  country: "US",

  // LA PUERTA. Nada se sirve sin que Miguel ponga esto a true a mano.
  published: true,

  verified_on: "2026-08-20",
  source_url: "https://www.target.com/help/articles/returns-exchanges/returns",

  question: "How long do I have to return a Target item?",
  answer: "conditional",
  depends_on: ["seller_name", "purchase_channel", "brand", "item_condition"],

  page: {
    title: "Target returns: 90 days, 30 days, or a full year?",
    meta_title: "Target returns: 90, 30 or 365 days? It depends who sold it — ReturnCheck",
    meta_description:
      "Target's return window is not one number. It changes with who sold the item and whose brand it is. Verified clauses, sources and dates.",
    lede:
      "All three are correct. Which one applies to your item depends on who sold it and whose brand is on it — and that is not something a single return-policy number can express.",
    outcomes_heading: "The three windows",
    denials_heading: "And two ways the window disappears",
    example: {
      q: "You buy a blender on target.com. Can you return it in 60 days?",
      a: "If Target sold it and it is unopened — yes, you are inside the 90-day window. If the same product page was fulfilled through Target Plus, you are 30 days past the deadline. The product page looks the same either way. The answer does not.",
    },
  },

  outcomes: [
    {
      days: 90,
      basis: "delivery",
      when: "sold by Target",
      when_long: "days from delivery — sold by Target",
      conditions: ["unopened", "new_condition"],
      conditions_text: "Item must be unopened and in new condition.",
      clause: "returned within 90 days will receive a refund or exchange",
      source_url: "https://www.target.com/help/articles/returns-exchanges/returns",
      source_label: "Returns & Exchanges",
      verified_on: "2026-08-20",
      tone: "allow",
    },
    {
      days: 30,
      basis: "delivery",
      when: "sold via Target Plus (marketplace)",
      when_long: "days from delivery — sold through Target Plus",
      conditions: ["unopened", "new_condition", "proof_of_purchase"],
      conditions_text:
        "Unopened, new condition, and proof of purchase required. Target Plus is the third-party marketplace: the item ships from another seller.",
      clause: "returned within 30 days will receive a refund",
      source_url: "https://www.target.com/help/articles/returns-exchanges/returns",
      source_label: "Returns & Exchanges",
      verified_on: "2026-08-20",
      tone: "limit",
    },
    {
      days: 365,
      basis: "delivery",
      when: "Target Owned Brand",
      when_long: "days — Target Owned Brand items",
      conditions: ["receipt"],
      conditions_text:
        "Receipt required. Applies to Target's own brands, such as Good & Gather or Threshold.",
      clause: "can be returned for up to one year with a receipt",
      source_url: "https://www.target.com/help/article/000184831",
      source_label: "Owned Brand returns",
      verified_on: "2026-08-20",
      tone: "allow",
    },
  ],

  denials: [
    {
      scope: "final sale",
      label: "Final sale — no return at all",
      clause: "final sale items and cannot be returned",
      source_label: "target.com",
      verified_on: "2026-08-20",
    },
    {
      scope: "opened, damaged, or no receipt",
      label: "Opened, damaged, or no receipt — may be refused",
      // Sin clausula literal en el tablero para este bloque: se describe lo que la
      // politica dice, marcado como nota y NO entrecomillado. Una parafrasis entre
      // comillas seria una cita inventada.
      note: "Target states these may be denied a refund or exchange, and that an item found ineligible on inspection may be charged back after a refund was already issued.",
      source_label: "target.com",
      verified_on: "2026-08-20",
    },
  ],
};
