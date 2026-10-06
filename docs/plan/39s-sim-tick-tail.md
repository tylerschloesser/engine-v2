# M39s: The large-save tick has no tail

Status: not started · After: 39r · Tyler-dependent: Q18 (default: the iPhone 12 is the baseline phone; the Pixel 5 is informational)

## Goal
M39o split the large-save pass and ran it on the Pixel 5 (`docs/plan/39o-large-save-tick-breakdown.md` Deviations). The pass median is 9.29 ms, already under the 10 ms ceiling of ADR 0010. The failure is a **tail inside `sim_tick`**: p50 7.89 ms against p95 23.2 ms (2.9x). On desktop Chromium the same build gives 4.57 against 5.56 (1.2x). The frame build (p95 3.8 ms), seal and resync are small, and there are no catch-up ticks. Desktop time per furnace is flat across `&scale=` 1, 4 and 16, so steady compute scales linearly; the tail is something else. Candidates (guesses, in no order): (a) periodic heavy ticks from the timer structure (a hierarchical wheel cascading a level every N ticks), or furnace completions bunched by a common start time; (b) the sim worker scheduled onto a little core of the Pixel's big.LITTLE CPU for some ticks; (c) wasm memory growth or a `BTreeMap` rebalance burst. The iPhone 12 (12.2 ms p95, M39j) has not been measured per part yet: its passcode blocks the driver.

When this is done the tail's cause is measured and named, the engine fix (if the cause is the engine) removes the measured spike, shown by a before/after per-tick series, and the orchestrator re-measures the phones. (Desktop p95/p50 is already 1.2x, so a p95 ratio on desktop can't show the fix: the criterion is on the spike ticks themselves.)

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0010-rates-and-subscriptions.md` (the tick ceiling)
3. `docs/plan/39o-large-save-tick-breakdown.md` (seams: `CB_SIM_ONETICK_US`, `SimHost.profile`, `BenchProbe`, readings; desktop table)
Rules: `.claude/rules/determinism.md` (any change in sim or timer code must keep bits identical natively and in `.wasm`), `.claude/rules/hot-paths.md`.

## Order of work
1. **Per-tick series.** The bench build keeps a preallocated ring of the last 4,096 `sim_tick` durations, each with its tick number. `__check.readings()` exposes a compact summary (histogram buckets, the top 20 ticks by duration with their tick numbers, and the autocorrelation peak period if any). The M39-large-save collector stores the full ring once at the end of the window in the evidence. Unit-test the summary on a synthetic series with a spike every 64 ticks: the period is found.
2. **Desktop measurement, one run**, scale 1, 60 s, headless Chromium. Paste the summary and characterise the tail: periodic or not, the period, and what the timer wheel (or other structure) does on those ticks. If the desktop tail is too small to read, also run natively (`cargo` bench or test harness at full scale) with the same per-tick series.
3. **Stop and report** with the measured cause and a proposed fix if any of these holds: the cause is not periodic engine work (scheduling or core placement: say so; the orchestrator measures it on the phone); the fix changes sim results (any golden or determinism hash); or it needs an ADR change (timer semantics, tick budget). Otherwise:
4. **Fix** the engine cause: for example, spread a cascade across ticks, or amortise a rebalance. Prove it on the per-tick series at scale 1, before and after, on the same machine and day: the spike ticks found in step 2 (for example the period's ticks, or the top 1 %) are no longer above 1.5x the median, or the improvement is stated against the before value with the series pasted and on the existing `rust`/`wasm` tick benchmarks and determinism tests (goldens unchanged).

## Non-scope
`wasm-opt`/`simd128` (ADR 0048); the 10 ms ceiling or the save's size (Q18); frame build; phone runs (the orchestrator's).

## Files touched
`packages/engine/src/worker/sim.ts` and `server.ts` (the ring), `games/reference/src/{bench.ts,bench-stats.ts,check.ts}` and tests, `scripts/lib/device-walk/{checks.mjs,agent/collect-ref.js}` and tests; for the fix, the engine crate's timer or store module, or the reference sim's furnace system (name it in Deviations).

## Exit criteria
- [ ] The per-tick series and summary exist (bench build only); the periodicity unit test was seen red.
- [ ] The desktop characterisation and the cause are in Deviations.
- [ ] Either the fix lands with the before/after scale-1 per-tick evidence on the spike ticks and unchanged goldens, or the report stops at step 3 with the measured cause.
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
`pnpm test unit -t bench` · `pnpm test rust -t tick` · `pnpm test wasm` · `pnpm test:slow browser -t "large-save|bench"` (targeted, foreground).

## Manual device checks
The orchestrator re-runs M39-large-save driven on the Pixel (and on the iPhone once its passcode is off) and reads the per-tick evidence.

## Deviations
(filled in during Phase 3)
