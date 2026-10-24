# ReturnCheck: reproducible return-policy checks for shopping agents

**Developer demonstration | published 24 October 2026**

ReturnCheck helps a shopping agent answer a purchase-specific question: **can this item be returned under the available policy evidence?** It exposes the `check_return` tool through MCP and an HTTP API, returning `YES`, `YES_WITH_CONDITIONS`, `NO` or `UNKNOWN`. When it makes a determinate claim, it aims to anchor it in an exact clause from the supplied or retrieved policy. A missing basis or seller-specific policy is not silently invented.

- [Repository and integration documentation](https://github.com/mangelmartinezfer-hue/returncheck)
- [OpenAPI](https://returncheck.m-angelmartinez-fer.workers.dev/openapi.json)
- HTTP: POST https://returncheck.m-angelmartinez-fer.workers.dev/v1/check
- MCP: https://returncheck.m-angelmartinez-fer.workers.dev/mcp
- [UCP return-policy extension, merged PR #634](https://github.com/Universal-Commerce-Protocol/ucp/pull/634)

## Evidence labels: important

**RECORDED SYNTHETIC** means a real engine result from a production-engine evaluation with *invented merchant names and policy text*. It does **not** prove performance on actual merchant websites.

**RECORDED REAL-MERCHANT SOURCE** means a real merchant's policy text was provided by the caller and evaluated by a production Worker. **It does not mean the Worker independently fetched that merchant's page.**

**REPRODUCTION INSTRUCTIONS** below allow a new live check using a free trial or paid call. They have **not** been run for this publication; today's output may differ from historical records. Do not confuse expected verdicts, recorded verdicts and a new observed response.

## Four recorded verdicts (synthetic test material)

The following cases are the original test fixtures [RC25-01 to RC25-04](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/src/holdout-cases.mjs). Their recorded outputs are in [pass 1](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/evaluaciones/2026-08-31-w47-holdout-pase1.json), [pass 2](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/evaluaciones/2026-08-31-w47-holdout-pase2.json), [pass 3](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/evaluaciones/2026-08-31-w47-holdout-pase3.json), [pass 4](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/evaluaciones/2026-08-31-w47-holdout-pase4.json), and [pass 5](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/evaluaciones/2026-08-31-w47-holdout-pase5.json). Build: `2026-08-30-w47-cita-manda-sobre-numero`, exam date 31 August 2026. The same four verdicts were recorded across five runs. **All four merchant names below are fictitious.**

| Fixture | Scenario | Recorded verdict | Key recorded evidence |
|---|---|---|---|
| RC25-01, Northstar Retail | Unopened item, 30 days after delivery | **YES** | 30 days, basis delivery, computed deadline 2026-09-04; cited policy sentence |
| RC25-02, BluePine Electronics | Opened headphones can be exchanged but not refunded | **YES_WITH_CONDITIONS** | 14 days, delivery basis, deadline 2026-08-24; exchange-only clause |
| RC25-03, Coastline Apparel | Final-sale clearance item | **NO** | Explicit final-sale exclusion; no window or deadline |
| RC25-04, BrightHome Partners / MarketHub | Marketplace's general terms defer to individual seller | **UNKNOWN** | `third_party_seller` guard; no verified seller policy and no cited eligibility clause |

These rows are a **summary of recorded fields**, not fabricated full HTTP responses. There are **no recorded real-merchant YES, NO or UNKNOWN outputs** in this demonstration; IKEA supplies only the real-merchant YES_WITH_CONDITIONS evidence.

### RC25-01: YES, synthetic

Policy excerpt (authored for the test): “Northstar Retail accepts returns of standard merchandise within 30 calendar days after delivery.” The scenario specified an unopened item, delivery on 5 August and a check on 20 August 2026. ReturnCheck recorded `YES` and a computed deadline of 4 September 2026.

### RC25-02: YES_WITH_CONDITIONS, synthetic

Policy excerpt (authored for the test): “Opened headphones may be exchanged, but not refunded, within 14 calendar days after delivery.” Other text required the serial-numbered box and all parts. For opened headphones delivered 10 August and checked 20 August 2026, the recorded result was `YES_WITH_CONDITIONS`. **An exchange is not a refund.**

### RC25-03: NO, synthetic

The policy written for the test excluded goods explicitly marked Final Sale, including clearance swimwear, from returns, refunds, exchanges and store credit. The recorded verdict was `NO`. This is not evidence about any real apparel merchant.

### RC25-04: UNKNOWN, synthetic

The test policy granted a 30-day window to items sold and shipped by fictional MarketHub but delegated third-party items to each seller's own terms. The scenario named BrightHome Partners as seller. ReturnCheck recorded `UNKNOWN` rather than borrowing MarketHub's 30-day window.

## One real merchant: IKEA US (recorded, not a controlled A/B test)

Two production checks on 2–3 October 2026 used **caller-supplied text** captured from the [IKEA US returns-policy page](https://www.ikea.com/us/en/customer-service/returns-claims/). The example purchase context was hypothetical. The engine did **not** fetch that page during the calls.

| Item condition | Recorded verdict | Reported duration | Window start | Calculated deadline | Check ID |
|---|---|---|---|---|---|
| Opened | YES_WITH_CONDITIONS | 180 days | not established | null | `5e69bb96-2d46-47dd-b097-b9240656f14a` |
| Unopened | YES_WITH_CONDITIONS | 365 days | not established | null | `fdb02230-512c-4658-bf7f-d19ee3d09319` |

The relevant IKEA policy text distinguished open from new/unopened items and required proof of purchase. The extracted clauses did not explicitly establish when the clock starts, so ReturnCheck left the anchor and deadline undetermined rather than treating “proof of purchase” as a temporal anchor.

**Public supporting field evidence:** [IKEA case with source clauses, recorded check IDs and limitations in the UCP PR #634 conversation](https://github.com/Universal-Commerce-Protocol/ucp/pull/634#issuecomment-5966598818). This is a field report, not a UCP endorsement.

**Limitations:** different Worker versions were used for the two calls; the opened branch uses wording-specific handling; there are exclusions in the underlying policy. This is not a same-build controlled test, proof of broad coverage, or independent verification of merchant truth. The original request and response records, not reproduced in full here, are retained in the project's field case file.

## Run your own check

A keyless free trial is available (the repository currently documents three calls per IP per day); further determinate answers cost **$0.02 USDC** via x402 on Base. `UNKNOWN` is free as a paid outcome, but **a free-tier UNKNOWN call can still use a daily trial slot**. Verify the live terms before spending. **No requests were sent to production to prepare this page.**

Save the following as `case-unknown.json`:

~~~json
{
  "product_url": "https://example.com/demo-item",
  "buyer_country": "US",
  "item_condition": "unopened",
  "reason": "changed_mind",
  "purchase_date": "2026-08-08",
  "delivery_date": "2026-08-12",
  "as_of": "2026-08-20",
  "seller_name": "BrightHome Partners",
  "purchase_channel": "marketplace",
  "page_text": "Products sold and shipped by MarketHub may be returned within 30 days of delivery. Products sold by marketplace partners are governed by the individual seller's return policy."
}
~~~

Then run (Mac/Linux shell or Git Bash):

~~~bash
curl -i -X POST "https://returncheck.m-angelmartinez-fer.workers.dev/v1/check" \
  -H "Content-Type: application/json" \
  --data-binary @case-unknown.json
~~~

The input is **synthetic**, uses a placeholder product URL and preserves the key context of fixture RC25-04. This is **not the exact original test harness request**, and newer production code may behave differently. Compare your response with the recorded result above; if they differ, report the difference instead of treating historical numbers as fresh validation.

To reproduce the other synthetic cases, use the `request` plus `page_text` for RC25-01, RC25-02 or RC25-03 in [the fixture source](https://github.com/mangelmartinezfer-hue/returncheck/blob/main/src/holdout-cases.mjs), adding the required `product_url` and using `buyer_country` as recorded. The README documents the contract.

For a **no-charge payment-discovery request only** (does not run `check_return`), use a genuinely bodyless `POST` without `PAYMENT-SIGNATURE`:

~~~bash
curl -i -X POST "https://returncheck.m-angelmartinez-fer.workers.dev/v1/check"
~~~

## Relationship to UCP

UCP's merged `dev.ucp.shopping.policy.return` extension standardises **business-declared** return terms, including eligibility, windows, channels and fees. ReturnCheck's current service attempts to evaluate **purchase-specific questions against policy text**, and explicitly declines unsupported answers. They can be complementary, particularly where merchant terms remain in prose or seller/condition context is missing.

**Not claimed:** ReturnCheck currently does **not** parse native UCP `policies[]` objects, does **not** have UCP certification or endorsement, and does **not** establish the truth of a merchant's own policy by independently auditing its business practice. When the caller supplies `page_text` or `page_html`, source verification is against that supplied content, not a fresh independent fetch. The service is an early-stage product without confirmed commercial customers.

**What we would like to learn:** can a shopping-agent integrator identify a concrete pre-checkout decision where an additional evidence-backed return-policy check helps? We're interested in a small, testable pilot, not a mandatory UCP dependency.

[ReturnCheck source, API and contact information](https://github.com/mangelmartinezfer-hue/returncheck)
