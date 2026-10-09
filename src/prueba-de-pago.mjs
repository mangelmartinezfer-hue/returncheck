// PRUEBA DE PAGO EXTERNA — la liquidacion del 6 de octubre de 2026.
//
// Por que vive aparte de /cards: una ficha de evidencia cita la politica de un
// comercio. Esto no es una politica, es un cobro. Mezclarlas ensuciaria un sistema
// que ya funciona, asi que esta pagina tiene su propia ruta y su propio objeto.
//
// LA MISMA REGLA DE LA CASA QUE EN /cards: la pagina para personas y el gemelo JSON
// para agentes SE DERIVAN DEL MISMO OBJETO. Si pudieran discrepar, la prueba no
// valdria nada.
//
// PROCEDENCIA DE CADA NUMERO: la ejecucion del 6-oct-2026 contra POST /v1/check y
// la conciliacion contra el RPC publico de Base mainnet del 7-oct-2026. Todo lo que
// hay aqui se puede comprobar en un explorador de bloques sin pedirnos permiso: es
// justo el punto de la pagina.
//
// EL PAGADOR VA ANONIMO. Su direccion es publica en la cadena y por eso figura,
// pero su nombre no se publica sin su consentimiento expreso. Si algun dia lo da,
// se anade aqui y en ningun otro sitio.
//
// LO QUE ESTA PAGINA NO ES: ni una auditoria, ni una certificacion de un tercero,
// ni un cliente comercial. Dice exactamente lo que ocurrio y nada mas.

import { envuelve } from "./cards.mjs";

export const PRUEBA = {
  proof_id: "rc-proof-x402-2026-10-06",
  what: "An external integrator paid for one ReturnCheck verdict over x402, then replayed the identical request and was not charged again.",
  executed_on: "2026-10-06",
  reconciled_on: "2026-10-07",
  endpoint: "/v1/check",
  protocol: "x402 v2",
  network: "eip155:8453",
  network_name: "Base mainnet",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  asset_name: "USDC",
  amount_atomic: "20000",
  amount_usdc: "0.02",
  payer: "0xE50c5212e8211639C49276dA190E248B83935763",
  pay_to: "0xbF428071027402E9b0cE85e22146EDdc028cEB3b",
  transaction: "0xdc577f237a8502d25771baceda86738a9b2eb5f516e11f51a314f8dbfe751291",
  receipt_status: "0x1",
  block: 52260342,
  verdict: "YES_WITH_CONDITIONS",
  check_id: "fdec5138-863e-42a2-be90-f58036bbd6d9",
  replay: {
    result: "HTTP 200",
    cost: "0.0000",
    settlement: "replay",
    same_transaction: true,
    same_check_id: true,
    second_charge: false,
  },
  reconciliation: {
    method: "Base mainnet public RPC, read directly from an independent machine",
    blocks_reviewed: 1500,
    filter: "USDC contract, Transfer event, this payer and this recipient",
    matching_transfers: 1,
    second_matching_transfer: false,
  },
  not_claimed: [
    "a commercial customer",
    "recurring revenue",
    "an audit or third-party certification",
  ],
  verify_yourself: "https://basescan.org/tx/0xdc577f237a8502d25771baceda86738a9b2eb5f516e11f51a314f8dbfe751291",
};

export function pruebaPagoJson(base) {
  return {
    ...PRUEBA,
    warning: `Executed ${PRUEBA.executed_on}, reconciled on-chain ${PRUEBA.reconciled_on}. One payment, one replay, no second charge.`,
    check_endpoint: base ? base + "/v1/check" : "/v1/check",
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function fila(etiqueta, valor, mono) {
  return `<div class="row"><span class="k">${esc(etiqueta)}</span><span class="v${mono ? " mono" : ""}">${esc(valor)}</span></div>`;
}

const EXTRA = `
.row{display:flex;gap:16px;padding:9px 0;border-bottom:1px solid var(--rule);font-size:15px}
.row:last-child{border-bottom:0}
.k{flex:0 0 190px;color:var(--ink-faint)}
.v{flex:1;word-break:break-all}
.box{background:var(--card);border:1px solid var(--rule);padding:20px 22px;margin-bottom:18px}
.box h2{font-family:"Newsreader",Georgia,serif;font-weight:600;font-size:22px;margin-bottom:10px}
.no{color:var(--deny)} .yes{color:var(--allow)}
`;

export function paginaPruebaPago(base) {
  const p = PRUEBA;
  const url = base + "/proof-of-payment";
  const cuerpo = `
<div class="brand"><a href="${esc(base)}/">ReturnCheck</a> · Proof of payment</div>
<h1>Someone outside this company paid for a verdict, replayed the request, and was not charged twice.</h1>
<p class="answer">On ${esc(p.executed_on)} an external integrator called <span class="mono">${esc(p.endpoint)}</span>, paid ${esc(p.amount_usdc)} USDC over x402 on ${esc(p.network_name)}, and received a verdict. They then sent the identical request again. The second call returned the same answer at a cost of ${esc(p.replay.cost)} and produced no second payment. The settlement was reconciled against the chain the next day from an independent machine.</p>

<div class="box">
<h2>The payment</h2>
${fila("Executed", p.executed_on)}
${fila("Protocol", p.protocol + " · " + p.network_name)}
${fila("Amount", p.amount_usdc + " USDC (" + p.amount_atomic + " atomic units)")}
${fila("Asset", p.asset_name + " " + p.asset, true)}
${fila("Payer", p.payer, true)}
${fila("Paid to", p.pay_to, true)}
${fila("Transaction", p.transaction, true)}
${fila("Receipt status", p.receipt_status + " (success)")}
${fila("Block", String(p.block))}
${fila("Verdict returned", p.verdict)}
${fila("check_id", p.check_id, true)}
</div>

<div class="box">
<h2>The replay</h2>
<p class="answer">This is the part that matters. Charging once is easy; not charging twice for a repeated request is where payment systems break.</p>
${fila("Result", p.replay.result)}
${fila("Cost of the replay", p.replay.cost)}
${fila("Settlement header", p.replay.settlement)}
${fila("Same transaction", "yes")}
${fila("Same check_id", "yes")}
${fila("Second charge", "none")}
</div>

<div class="box">
<h2>Reconciled on the chain, not on our word</h2>
<p class="answer">${esc(p.reconciliation.method)}, on ${esc(p.reconciled_on)}. ${esc(String(p.reconciliation.blocks_reviewed))} blocks from the settlement block were scanned, filtering by ${esc(p.reconciliation.filter)}. The scan returned ${esc(String(p.reconciliation.matching_transfers))} matching transfer — the one above — and no second one in the window that covers the replay.</p>
<p class="answer">You do not have to take any of this from us: <a href="${esc(p.verify_yourself)}">open the transaction in a block explorer</a>.</p>
</div>

<div class="box">
<h2>What this does not prove</h2>
<p class="answer">It is one paid call from one integrator. It is not ${esc(p.not_claimed.join(", not "))}. We say what happened and stop there.</p>
</div>

<div class="twin"><div class="lab">The same proof, for machines: <a href="${esc(url)}.json">${esc(url)}.json</a></div></div>

<div class="stamp"><strong>Executed</strong> ${esc(p.executed_on)} · <strong>Reconciled on-chain</strong> ${esc(p.reconciled_on)} · The payer is identified by their on-chain address only; their name is not published without their consent.</div>
`;
  const html = envuelve({
    title: "Proof of payment: one x402 settlement, one replay, no second charge — ReturnCheck",
    description:
      "An external integrator paid 0.02 USDC for a ReturnCheck verdict over x402 on Base mainnet, replayed the identical request, and was not charged twice. Transaction, block and reconciliation, verifiable by anyone.",
    canonical: url,
    alternateJson: url + ".json",
    jsonld: null,
    cuerpo,
  });
  return html.replace("</style>", EXTRA + "</style>");
}
