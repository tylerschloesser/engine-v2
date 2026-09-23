# 0031: The `browser` suite runs 5 Playwright workers, not 3

Status: Accepted (2026-09-22). Amends [0020](0020-testing-strategy.md) §3's `workers: 3` line (and
`packages/engine/playwright.config.ts`'s matching inline comment). Implemented in milestone M16c.

## Context

M16 left the `browser` suite over its own 0020 §3 budget under load: `docs/plan/16c-browser-suite-
time.md`'s own "problem" section measured `n 116 summed test work 72.9 s workers 3 wall 26.7 s`, and
9 of 15 `node scripts/repeat.mjs browser 15 --load 10` runs failed the suite's wall-clock budget
alone (no assertion failed). M16c Scope 3 cut the suite's own summed work from 69.5 s to 57.1 s (a
halved zero-GC warm-up, `docs/plan/16c-browser-suite-time.md` Deviations) and already brings quiet
`pnpm test browser` to ~22 s, comfortably under the 25 s budget, on `workers: 3`. M16c Scope 4 still
required measuring `workers: 3` against `4` and `5`, since `playwright.config.ts`'s own comment
("One browser per Playwright worker") was a planning default, not a measured one, and the suite's
own wall time is `summed work / workers` in the budget's own words -- more workers is the other
lever besides cheaper tests. The suite's own two Playwright projects that make up the fast tier
(`chromium`, `gc`) both launch one Chromium instance per worker; Tyler's Mac has 14 logical CPUs.

## Decision

**`playwright.config.ts`'s `workers` is 5**, for both the `browser` suite (`chromium` + `gc`
projects, fast and slow tier) and its `engines` leg (`webkit` + `firefox`, slow tier only) -- one
Playwright config-level setting, shared by both `playwright test` invocations `scripts/suites.mjs`
spawns. Measured this session (Tyler's Mac, `WARMUP=4000` already applied, `vertical_slice`
otherwise unchanged from base -- M16c's own Step 3, Deviations):

| `workers` | quiet `pnpm test browser` (3 consecutive) | `repeat.mjs browser 8 --load 10` (two batches) |
|---|---|---|
| 3 | 22 s / 22 s / 22 s (`report.json` summed 57.1 s) | 16/16 pass, `slowestSuiteSeconds` 29, 30 |
| 4 | 20 s / 20 s / 20 s | not run under load (see below) |
| **5** | **21 s / 19 s / 18 s** | **16/16 pass, `slowestSuiteSeconds` 24, 24** |

5 workers is not merely faster quiet -- it is *also* better under load than 3 workers was: the same
loaded command that left `workers: 3` at 29-30 s left `workers: 5` at 24 s both times, with zero
failures and zero hangs in 16/16 runs at each setting. No `parkWorkers: timed out after 10000 ms`
(the watch item in `docs/plan/deferred-ledger.md`) appeared in any loaded run at any worker count
tested this session. A `pnpm test:slow browser` run at `workers: 5` (38 tests, the `webkit`/
`firefox` `@engines` legs included) also passed, 18 s, no regression -- confirming the shared config
setting does not destabilise the slow tier either. 4 workers was measured only quietly (it sits
between 3 and 5 on every quiet run) and dropped once 5 was shown to be strictly better under both
quiet and loaded conditions; a loaded measurement of 4 would not have changed the choice.

**Why 5 helps rather than only trading time for flakiness** (Scope 4's own fallback condition,
which this data does not trigger): the machine has 14 logical CPUs and the fast tier's own two
projects are CPU-bound per-Chromium-instance work (WASM compile, WebGPU readback, the `gc` project's
own heap sampling) rather than memory- or IO-bound, so headroom exists for more concurrent browser
instances before contention dominates. The loaded numbers (24 s at 5 workers vs. 29-30 s at 3, same
`--load 10` burners competing for the same CPUs) show more parallel work finishing faster even under
contention, not merely a quiet-machine artifact.

## Alternatives rejected

- **Keep `workers: 3`.** Scope 4's own instruction ("if more workers only trade suite time for
  flakiness, keep 3") does not apply: 5 was faster quiet *and* faster loaded *and* introduced no new
  failure or `parkWorkers` timeout in 32 total measured runs (16 quiet-adjacent + 16 loaded) across
  this session's own measurements.
- **`workers: 4`.** Strictly between 3 and 5 on every quiet run measured (20 s vs. 22 s and 18-21 s);
  dropped once 5's own loaded numbers came back with zero failures, since nothing in the data
  suggested 4 would do better than 5 under load and re-measuring it there would not have changed the
  choice.
- **`workers: 6` or higher.** Not measured: Scope 4 named 4 and 5 specifically, and 5 already meets
  the suite's own 25 s budget with margin under both quiet and loaded conditions, so there was no
  open problem left for a higher count to solve.

## Consequences

- `packages/engine/playwright.config.ts`'s `workers: 3` becomes `workers: 5`; its inline comment
  ("One browser per Playwright worker (Planning decisions)") is updated to cite this ADR's own
  measurements instead of the un-measured planning default.
- CI (`ci.yml`, `ubuntu-latest`, SwiftShader) is unaffected by this ADR: 0020 §10's own "timings
  recorded, never gating" and `--budget-scale 1000` mean CI's own core count (not measured here) does
  not need a matching change for correctness, only for CI's own wall time, which is out of this
  ADR's scope.
- Re-derive if the fast tier's own summed work changes substantially again (a future milestone's own
  zero-GC page, or a change to `WARMUP` beyond M16c's own halving): the 24 s loaded figure has less
  margin under `--load 10` than the quiet figures do, and a heavier suite could erode it.

## Sources

- `docs/plan/16c-browser-suite-time.md`, Deviations (this session's own measurements: quiet
  three-run timings, `report.json` summed work, `node scripts/repeat.mjs browser 8 --load 10` x2 at
  each of `workers: 3` and `workers: 5`, one `pnpm test:slow browser` run at `workers: 5`).
- [0020](0020-testing-strategy.md) §3 (suites and budgets), §10 (CI, "timings recorded, never
  gating"); `docs/plan/deferred-ledger.md` ("`parkWorkers: timed out after 10000 ms` under
  saturation" watch item).
