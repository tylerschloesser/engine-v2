# M39ag: the large-save pass gets margin under 10 ms on the iPhone

Status: not started · After: 39ae · Tyler-dependent: no (Q18 (a); ADR 0056 §3)

## Goal
After M39ae, the iPhone's driverless M39-large-save (`docs/plan/device-rounds/m39ae-iphone-large-save.jsonl`, 2026-10-09) still fails by 3 %: `tick_p95_ms` **10.32** (limit 10; it was 11.82). `sim_tick` alone is now p50 7.08 / p95 max 8.7, but the criterion times the **whole sim-worker pass** (`PassSample.wholeUs` in `games/reference/src/bench-stats.ts`: seal, the sim tick, frame build, resync and whatever else is in the pass). The pass median is 8.4 ms, about 1.3 ms above `sim_tick`. On the phone, `frame_build_p95_ms_max` is 1.68, seal 0.02, resync 0.14, and catch-up 0. When this is done the whole pass is at least **10 % cheaper** than at M39ae's `done` (`a2087c62`) on the desktop proxy, with state unchanged, so the phone has margin. The iPhone run is the orchestrator's.

## Read first
1. `docs/spec/overview.md`
2. `docs/plan/39ae-large-save-tick-under-10ms.md` (Deviations: the per-phase table after step 2; `put` is now the largest sim phase)
3. `docs/plan/39y-wasm-tick-cost.md` (Deviations: the phase counters, the cold-wake mechanism, the candidates)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
1. **Account for the whole pass first.** On the desktop proxy (headless Chromium, `dist-bench`, `?bench=large-save&scale=1`, 60 s; the path `pnpm test:slow browser -t "large-save|bench"` drives), and natively where a twin exists, paste p50/p95 of `whole`, `seal`, `tick`, `frame`, `resync` and **the remainder** (`whole` minus the parts). Three runs, load stated. If the remainder is above 0.3 ms, find what it is (sim-worker code between the timed parts) before step 2.
2. **Take the biggest measured part first:**
   - **frame build** (the server side of the pass: what it encodes per pass, and whether a pass with no subscriber-visible change still builds or copies a full frame);
   - M39ae's untaken candidates: **`chunk_versions.insert`** dedupe in `Host::tick`, and the **`put_entity` write path** (`entity_scopes`, the change log), per M39ae's Deviations;
   - the remainder, if step 1 found one.
   Each its own commit with a before/after row (interleaved, three runs each).
3. Stop rule: stop when the desktop proxy's whole-pass p50 is ≤ 90 % of the `a2087c62` baseline (measured in step 1 by checking out that commit's build, or by step 1's own baseline on the current tree, which is the same code). If nothing left reaches it without a storage change, stop and report the table. The entity store's `BTreeMap` (`store/mod.rs:94`) is a storage redesign, Q18 (c): Tyler's call, not this milestone.

## Non-scope
State, snapshot format, the wire encoding, goldens and hashes; the criterion, limits and `budgets.json`; busy-waits, thread priority or keeping the worker awake (masks: ADR 0056, M39s); the furnace count; the Pixel.

## Files touched
The engine crate (`host/`, `authority.rs`, and the frame build path the measurement names), the sim worker (`packages/engine/src/worker/sim.ts`) only if step 1 finds the remainder there, and their tests.

## Seams
**Provides:** none new. **Consumes:** M39y's `bench-phases`, M39s's ring, M39ae's dense `by_entity`.

## Tests added
Every golden, hash and determinism test passes unchanged (paste that `git status` shows no golden). If a frame-build change skips work when nothing changed, add a test that a pass with a subscriber-visible change still sends it (fails if the skip is too eager: inject and paste the red). No timing assertions.

## Exit criteria
- [ ] Step 1's whole-pass breakdown pasted (three runs, load).
- [ ] A per-change before/after table; whole-pass p50 ≤ 90 % of baseline, or the stop report.
- [ ] Goldens and hashes unchanged (`pnpm test rust`, `pnpm test wasm`, `pnpm test netcode` pass lines).
- [ ] The eager-skip test (if any) exists and was seen red.
- [ ] `pnpm test:slow browser -t "large-save|bench"` passes (pasted).
- [ ] `pnpm test` and `pnpm lint` are green (run by the orchestrator).

## Verification commands
As above, foreground and bounded. `uptime` before each timing run; interleave before/after.

## Budgets
`PRE-PLAN.md` §7 tick row (10 ms), held by the iPhone (ADR 0056 §3); measured by M39-large-save on the phone (the orchestrator, `--open ios`).

## Manual device checks
M39-large-save on the iPhone, by the orchestrator, after this lands.

## Deviations
(filled in during Phase 3)
