# M39t: M16-coexist waits for the first memory reading

Status: not started · After: 39r · Tyler-dependent: no

## Goal
The slow-tier `walk-life: coexist` fails about 1 run in 8 with `crit(co, 'engine_mem_grows')` `{value: null, ok: false}` (ledger row of 2026-10-06). A read-only diagnosis on 2026-10-06 (code reading only, `test-results/coexist-mem-null-diagnosis.md`, not committed) found a race that existed before M39p and M39q:
- The slice page publishes `engine_mem_grows` only after its first `refreshMemGrows`, on a 3000 ms `setInterval` (`packages/engine/tests/browser/pages/src/slice.ts`, about lines 486-495 and 602). Until then `check.readings().engine_mem_grows` is null.
- `SLICE.coexist` (`scripts/lib/device-walk/agent/collect-life.js`, about line 119) waits only for `check().ready`, then goes straight to `measureWindow` (`driver.js`), which samples about once a second.
- `walk-life.spec.ts` runs coexist with `windowMs: 3000, warmupMs: 0`, so about 3 samples. If all of them fall before the first reading, every steady row has `engine_mem_grows` null. `max-known` (`checks.mjs`, M16-coexist's criterion) then returns null, which fails.

The diagnosis refuted the ledger's guess: M39q's `sum` change does not touch this criterion, which uses `max-known`, and that has returned null on empty since M39k. M39p's `raf_n >= 10` filter is only a weak second path. When this milestone is done, the collector waits for the first reading, a deterministic test fails on the old collector, and an empty window still fails.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39q-net-heap-boot-race.md` (Scope and Deviations: the same fix shape in `MP.netheap`, the `notReadyWhy` shape, the vm unit harness and the race-test precedent)
3. `docs/plan/39p-quiet-measuring-windows.md` Deviations (`measureWindow`, steady rows, `MIN_STEADY_FRAMES`)

## Scope
1. **Measure the cause first.** Before changing the collector, make the race deterministic and see it red. On the page side, add a test-only `?memEveryMs=` override for the slice page's memory-reading interval (default unchanged at 3000). Then add a slow-tier case beside `walk-life: coexist` that runs with `memEveryMs=6000` against `windowMs: 3000`. It must be red on the current collector with the ledger's exact failure (`engine_mem_grows` null). If it is not red, stop and report: the diagnosis is wrong.
2. **Fix.** `SLICE.coexist` waits for `readings().engine_mem_grows !== null` (bounded by `item.opts.timeoutMs`, like `MP.netheap`'s link wait) before `measureWindow`. On a timeout it returns `{ ready: false, why, errors }` with no `reloads` key (M39q's shape). The criterion and its reducer are unchanged.
3. **Audit the siblings.** Grep the other collectors whose criteria read a page reading that appears late (an interval or an async first value) for the same missing wait. List each one checked in Deviations and fix any you find, with the same shape.
4. **Unit test** (the M39q vm harness, `fake-agent-page.mjs` already takes injected `readings` and `frames`): (a) `engine_mem_grows` null for the first 4 s and a 3 s window gives 0 with the fix and null without it; (b) a reading that never arrives gives `ready: false` and a failing verdict, never a pass.

## Non-scope
The 3000 ms default interval, the criterion and `max-known`, M39p's `raf_n` filter, window lengths. Brief 39s (the `sim_tick` tail).

## Files touched
`scripts/lib/device-walk/agent/collect-life.js` (and other `agent/*.js` only if the audit finds the same defect), their tests under `scripts/lib/`, `packages/engine/tests/browser/pages/src/slice.ts` (the query override only), `packages/engine/tests/browser/walk-life.spec.ts`.

## Exit criteria
- [ ] The deterministic race test was seen red on the old collector with `engine_mem_grows` null (red line pasted), and is green with the fix.
- [ ] The unit tests exist, pass, and were seen red (red lines pasted).
- [ ] The sibling audit is listed in Deviations.
- [ ] `pnpm test:slow browser -t walk-life` green (pasted line); no golden, budget or baseline changed.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t device-walk` · `pnpm test:slow browser -t walk-life` (targeted, foreground). Loops run in the foreground, bounded, with a per-run kill timeout, and no background load generators.

## Manual device checks
None new. M16-coexist is in the owed iPhone round and passed on the Pixel (`m39p-pixel`).

## Deviations
(filled in during Phase 3)
