# ReturnCheck holdout evidence — 31 August 2026

This directory contains the raw outputs behind the quality figures published on
the ReturnCheck home page.

## What was measured

- Frozen set: 25 hand-labelled return-policy cases.
- Repetitions: 5 production-engine passes, 25 cases per pass (125 calls total).
- Input path: `agent_supplied` policy text (`page_text`).
- Model label in the dumps: `default-8b-fast`.
- Authorship disclosure: the cases and runs are from the ReturnCheck team, not an
  external evaluator.

Each pass produced the same headline result:

- 0 unsafe errors.
- 0 hallucinated clauses.
- 100% precision on determinate verdicts.
- 72% coverage.
- 80% coverage ceiling because 5 of the 25 cases correctly expect `UNKNOWN`.
- 2 safe misses.

The raw results include every case and both misses. They have not been removed
from the public record.

## Raw runs

1. [`2026-08-31-w47-holdout-pase1.json`](./2026-08-31-w47-holdout-pase1.json)
2. [`2026-08-31-w47-holdout-pase2.json`](./2026-08-31-w47-holdout-pase2.json)
3. [`2026-08-31-w47-holdout-pase3.json`](./2026-08-31-w47-holdout-pase3.json)
4. [`2026-08-31-w47-holdout-pase4.json`](./2026-08-31-w47-holdout-pase4.json)
5. [`2026-08-31-w47-holdout-pase5.json`](./2026-08-31-w47-holdout-pase5.json)

These figures measure decision quality when policy text is supplied. The
separate 17-of-50 retailer study measures server-side page acquisition and
should not be read as the same metric.
