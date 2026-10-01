# 0047: An absolute floor under the 25 % benchmark rule

Status: Accepted (2026-10-01). Amends [0020](0020-testing-strategy.md) §9 (the 25 % threshold); implemented in M36 (`scripts/lib/bench-gate.mjs`).

## Context
[0020](0020-testing-strategy.md) §9 gates each wall-clock benchmark at 25 % over its checked-in baseline, on the baseline machine. For a metric in the hundreds of microseconds that is a few tens of microseconds, inside the run-to-run noise of a shared machine. `bench.frame_reference` measures a worker `frame` median of 0.12 ms; ten quiet-to-moderate runs on the baseline machine gave 0.106 to 0.155 ms, so a 25 % limit (0.150 ms) failed good code about one run in ten. The other gated metrics (`tick`, `worldgen`, `frame`) are milliseconds or tens of microseconds per chunk with tighter relative spread and are unaffected.

## Decision
**1. A per-baseline absolute floor.** A baseline file may carry `minDeltaMs` (default 0). A gated metric fails only when it is over `1.25 x` its baseline **and** more than `minDeltaMs` above it. Both conditions must hold.
**2. Derived, never chosen.** `minDeltaMs` is twice the spread (max minus min) of the metric over at least ten runs on the baseline machine, written with its derivation in the baseline's `conditions`. It is never set or raised to clear a red run. Changing it is a reviewed edit, like the baseline itself.
**3. The absolute proxies are independent.** A `limits` figure (the ADR proxies of [0010](0010-rates-and-subscriptions.md), [0018](0018-renderer.md) §9) still fails on its own; the floor only relaxes the relative rule.
**4. Only `frame-reference` sets one now:** `minDeltaMs` 0.1 (2 x (0.155 - 0.106) = 0.098).

## Alternatives rejected
- Widening the percentage for that benchmark: a relative figure is the wrong unit below a millisecond, and it would loosen the gate for larger metrics sharing the helper.
- Gating on a larger statistic or a mean of several runs: costs minutes of wall-clock per benchmark for the same noise.
- Dropping the gate for this metric: the 0018 proxy alone is 20 x above the measured figure and would catch nothing short of a catastrophe.

## Consequences
A real regression smaller than `minDeltaMs` is not caught for sub-millisecond metrics; the proxy and a larger scene catch the rest. Revisit if the measured spread changes (a new baseline machine) or the metric grows past a millisecond, where the floor should go back to 0.

## Sources
`packages/engine/baselines/frame-reference.json` (`conditions`: the ten runs), `docs/plan/36-slow-tier-and-benchmarks.md` Deviations, 2026-10-01.
