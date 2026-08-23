# ReturnCheck — Verified return-policy API for AI shopping agents

**Can this specific product actually be returned?** ReturnCheck answers that one
question for AI shopping agents, with a **verified** verdict — not a guess.

Give it a `product_url` and a `buyer_country` and it returns a verdict
(`YES` / `YES_WITH_CONDITIONS` / `NO` / `UNKNOWN`) with the **exact policy clause
quoted from the page**, the **source URL**, the return window, and a confidence
score. If it cannot verify a clause on the page, it returns `UNKNOWN` — it
**never invents**.

Built for **agent-to-agent commerce**: an MCP tool plus x402-friendly
micro-pricing at **$0.02 per verified answer** (UNKNOWN is free; a keyless free
trial is available).

---

## Why it exists

AI agents are starting to buy things. Before they buy, they need to know if a
purchase is reversible — and today no one answers "is this returnable?" in a way
a machine can trust and act on. ReturnCheck is the neutral verification primitive
for that: it sells to **every** shopping agent and competes with none of them.

## Quick start

**MCP (Streamable HTTP)** — tool: `check_return`
```
https://returncheck.m-angelmartinez-fer.workers.dev/mcp
```

**HTTP**
```bash
curl -X POST https://returncheck.m-angelmartinez-fer.workers.dev/v1/check \
  -H "content-type: application/json" \
  -d '{"product_url":"https://store.example/p/shoe","buyer_country":"US","item_condition":"unopened"}'
```

If you already have the product/policy page rendered, pass it as `page_html` or
`page_text` — ReturnCheck verifies against it and skips fetching (best coverage,
bypasses sites that block server-side reads). It still never invents.

## What you get back

```json
{
  "verdict": "YES_WITH_CONDITIONS",
  "returnable": true,
  "confidence": 0.9,
  "policy": { "merchant_return_days": 30, "return_category": "FiniteReturnWindow" },
  "evidence": {
    "source_url": "https://store.example/policies/refund-policy",
    "exact_clause": "Items may be returned within 30 days of delivery for a full refund.",
    "verified_on": "2026-08-23"
  }
}
```

## Pricing

| | |
|---|---|
| Verified answer (YES / NO / conditions) | **$0.02** |
| UNKNOWN | **Free** |
| Keyless free trial | a few calls/day, no signup |

## Discovery for agents

- OpenAPI: `/openapi.json`
- Plugin manifest: `/.well-known/ai-plugin.json`
- Agents manifest: `/agents.json`
- LLM manifest: `/llms.txt`
- MCP tool list: `/mcp`

## Design principles

- **Never invent.** Every determinate verdict carries a clause verified literally
  against the page. If it can't be verified, the answer is `UNKNOWN`.
- **Frozen contract (v1.0).** Fields are only ever added, never broken.
- **US data first, global architecture.** Runs 100% serverless on the edge
  (Cloudflare Workers + D1 + Workers AI).

## Keywords

return policy API · returns verification · AI shopping agents · agentic commerce ·
MCP server · check_return · x402 · agent-to-agent payments · e-commerce returns ·
is this returnable · refund policy checker
