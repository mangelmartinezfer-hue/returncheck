import test from "node:test";
import assert from "node:assert/strict";

const TX = "0xdc577f237a8502d25771baceda86738a9b2eb5f516e11f51a314f8dbfe751291";
const CHAIN_ID = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const PAYER = "0xE50c5212e8211639C49276dA190E248B83935763".toLowerCase();
const PAY_TO = "0xbF428071027402E9b0cE85e22146EDdc028cEB3b".toLowerCase();
const AMOUNT = 20000n;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPC = "https://mainnet.base.org";

const padAddress = a => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const fromTopic = t => "0x" + t.slice(-40).toLowerCase();

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(r.ok, true, `Base RPC HTTP ${r.status}`);
  const j = await r.json();
  assert.equal(j.error, undefined, `Base RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "ReturnCheck-onchain-closeout/1.0" } });
  assert.equal(r.ok, true, `Routescan HTTP ${r.status}: ${url}`);
  return r.json();
}

test("Mitaka paid call is independently reconciled on Base and has no replay double-charge", async () => {
  const chain = await rpc("eth_chainId", []);
  assert.equal(Number.parseInt(chain, 16), CHAIN_ID);

  const receipt = await rpc("eth_getTransactionReceipt", [TX]);
  assert.ok(receipt, "transaction receipt not found");
  assert.equal(receipt.status, "0x1", "transaction did not succeed");

  const tx = await rpc("eth_getTransactionByHash", [TX]);
  assert.ok(tx, "transaction not found");

  const transferLogs = receipt.logs.filter(l =>
    l.address?.toLowerCase() === USDC &&
    l.topics?.[0]?.toLowerCase() === TRANSFER &&
    l.topics?.[1] && fromTopic(l.topics[1]) === PAYER &&
    l.topics?.[2] && fromTopic(l.topics[2]) === PAY_TO &&
    BigInt(l.data) === AMOUNT
  );
  assert.equal(transferLogs.length, 1, "expected exactly one 0.02 USDC Transfer in settlement receipt");

  const block = BigInt(receipt.blockNumber);
  const endBlock = block + 3000n;
  const matchingLogs = await rpc("eth_getLogs", [{
    address: USDC,
    fromBlock: "0x" + block.toString(16),
    toBlock: "0x" + endBlock.toString(16),
    topics: [TRANSFER, padAddress(PAYER), padAddress(PAY_TO)],
  }]);
  const exactRpcTransfers = matchingLogs.filter(l => BigInt(l.data) === AMOUNT);
  assert.equal(exactRpcTransfers.length, 1, "more than one matching 0.02 USDC transfer found around paid call/replay window");
  assert.equal(exactRpcTransfers[0].transactionHash.toLowerCase(), TX.toLowerCase());

  const statusUrl = `https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api?module=transaction&action=gettxreceiptstatus&txhash=${TX}`;
  const routeStatus = await getJson(statusUrl);
  assert.equal(routeStatus.status, "1");
  assert.equal(routeStatus.result?.status, "1", "Routescan does not report successful receipt");

  const tokenUrl =
    `https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api?module=account&action=tokentx` +
    `&address=${PAY_TO}&contractaddress=${USDC}&page=1&offset=100&startblock=${block}&endblock=${endBlock}&sort=asc`;
  const tokenTx = await getJson(tokenUrl);
  assert.equal(tokenTx.status, "1", `Routescan tokentx error: ${JSON.stringify(tokenTx)}`);
  const exactRouteTransfers = (tokenTx.result || []).filter(x =>
    String(x.from).toLowerCase() === PAYER &&
    String(x.to).toLowerCase() === PAY_TO &&
    BigInt(x.value) === AMOUNT
  );
  assert.equal(exactRouteTransfers.length, 1, "Routescan found a duplicate matching 0.02 USDC transfer");
  assert.equal(exactRouteTransfers[0].hash.toLowerCase(), TX.toLowerCase());

  const evidence = {
    chain_id: CHAIN_ID,
    transaction: TX,
    receipt_status: receipt.status,
    settlement_block: Number(block),
    transaction_sender: tx.from,
    token: USDC,
    transfer_from: PAYER,
    transfer_to: PAY_TO,
    amount_atomic: AMOUNT.toString(),
    amount_usdc: "0.02",
    receipt_matching_transfers: transferLogs.length,
    rpc_matching_transfers_through_block_plus_3000: exactRpcTransfers.length,
    routescan_matching_transfers_through_block_plus_3000: exactRouteTransfers.length,
    duplicate_matching_transfer: false,
    sources: ["Base public RPC https://mainnet.base.org", "Routescan keyless API"],
  };
  console.log("ONCHAIN_EVIDENCE_JSON=" + JSON.stringify(evidence));
});
