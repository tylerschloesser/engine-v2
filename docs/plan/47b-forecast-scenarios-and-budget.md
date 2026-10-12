# M47b: Forecast scenarios and the bandwidth budget

Status: not started · After: 47 · Tyler-dependent: no (the client-side spawner replay is an **(assumed)** line in `games/reference/README.md` "Belts"; the default proceeds)

Split from `47-forecasts-and-corrections.md` on 2026-10-12 (sizing rule, as M42-M44): the `fx-belts` side and the measurements of [0078](../decisions/0078-transport-forecast-replication.md) A5.

## Goal
The forecast scheme is proved on the spike's worlds through real frames and measured against its budget: `fx-belts` declares its spawners to the tracker and builds the `SaturatedView` world at genesis; the netcode arbiter feeds a replica the host's frames over the spike's seven 1/64 worlds for 300 ticks with exact equality every tick; the saturated-viewport scenario measures sections 12 and 13 together against a new `counters.transport.downBytesPerSec` row (ceiling 16,384 B/s) at (20 %, 100) and records the (20 %, 20) stress cell; `belts-tick.json` is re-recorded with the tracker on for the reviewed delta.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (A1, A4, A5, A6: the cells, the modelled numbers, the levers)
3. `docs/plan/47-forecasts-and-corrections.md` (Deviations: what the engine built and what it costs) and `docs/plan/41-forecast-spike.md` (Deviations: the seven worlds and the arbiter's definition)
4. `docs/architecture/sync-and-netcode.md` ("Rates, subscriptions, bandwidth"; the netcode `assertBudget` pattern in `tests/netcode/rates.test.ts`) and `packages/engine/tests/netcode/CLAUDE.md`
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests` (the slow tier, baselines, load hygiene).

## Scope
- `fx-belts`: `Op::Spawner` (and the bench genesis for `Thing::Spawner`/`Thing::Cycling`) calls `set_spawner(line, schedule)` with the schedule the fixture's tick rule follows (`rate256`, phase, cycling, next item), and clears it when the spawner is destroyed; `BeltsParams.bench` gains the regime (`Mixed` stays the default; `SaturatedView { jam_pct, period }`), carried in the worldgen marker without moving `golden-bench-64.json` (an added tile or a spare `aux` field: say which); the scripted `Sink`/`DeadEnd` toggles for the jam schedule exist as requests already (`Op::Out` or its equivalent: check).
- Netcode: `belts/forecast_client_matches_host` (the arbiter: the spike's seven 1/64 worlds, `SaturatedView` (20, 20) and (50, 30), mixed, inserter-edited, `speed = 72`, a 64-tile viewport, an empty start, 300 ticks each, the replica's `items_in` equal to the host's on every held line every tick); `belts/forecast_corrected_on_jam` (a jam forming sends a `State` within one frame and no `RunList`); `belts/saturated_view_bytes` (one client holding the whole 256 x 144 viewport, 20 s of virtual time, production hashing on, (20 %, 100): `assertBudget({ transportDownBytesPerSec }, 'transport.downBytesPerSec')`); `belts/saturated_view_stress` ((20 %, 20), recorded in the row's formula, not gated; if above 32,768 B/s the chain-level halt of 0078 A6 (i) is built here, as its own planning decision).
- `budgets.json`: `counters.transport.downBytesPerSec` (ceiling 16,384; sections 12 and 13; the formula names the scenario, the measured (20 %, 100) and (20 %, 20) figures, corrections per visible run per second and `forecastSeenLate` at the median network profile).
- `engine/test`: `transportCounters(client)` if M47's `forecastCounters` lacks what the scenarios read.
- The collapse pricing's structure bytes are cached per chunk by `structure_version` (M47's gate found M46's `anchored_bytes` priced every chunk with deltas every tick: `Host::build_frame`'s collapse decision, `host/mod.rs`; +0.29 ms on the bench's frames, 0.70 to 0.98 ms, with no structure change; the bench's cycling spawners put a delta in every chunk every tick): a per-chunk `(version, bytes)` entry reserved with the chunk table, recomputed only when `structure_version` moved since; `no_alloc_connection` unchanged at 0 B. Then `slow_tick_belts_large` with the tracker on: three runs at quiet load; the manager promotes the baseline (`pnpm bench:baseline belts-tick`) for the reviewed delta (M47's three runs: 1.310-1.357 ms against 0.8815; M46 alone measured 1.190-1.224).

## Non-scope
- Engine code beyond what the scenarios reveal as a defect (fixed as a finding, recorded); prediction, join at scale, degrade, reconnect (M48); drawing (M49).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (`src/lib.rs`, `src/bench.rs`, `src/bench/world.rs` if the regime needs it, `golden/` only if a new scenario is added, `CLAUDE.md`).
- `packages/engine/tests/netcode/belts.test.ts` (or a second `belts-forecast.test.ts`), `support.ts`, `packages/engine/src/test/` (helpers), `packages/engine/budgets.json`, `packages/engine/baselines/belts-tick.json` (re-recorded by the manager).

## Seams
**Provides:** the `counters.transport.*` row, the saturated-view scenario (M48, M57 reuse), the seven-world arbiter, the re-recorded baseline.
**Consumes:** M47's tracker, section 13, replica and counters; M46's structures; M45's world and baseline; M44b's `SaturatedView` world and `Regime`; M42b's request pattern.

## Planning decisions
- **Sections 12 and 13 share the budget row** (0078 A5); the (20 %, 20) cell is recorded, not gated.
- **Two bounded holes M47 left for this milestone's measurements** (manager, 2026-10-12): `State`s and `Arrival`s are unbudgeted (a tick with more of them than a frame holds is a lost frame, a bounded re-put, never a stall: the saturated view at (20 %, 20) says whether it happens), and a list sized between the halved and the full put budget waits while frames alternate between overflowing and being sent (recovery needs one sent frame at full budget). Measure both here; if either shows, the fix is a per-frame record budget with carry-over, decided in this brief's Deviations.
- **The fixture declares, the engine forecasts** (M47's decision): `fx-belts`' spawner keeps inserting through `insert_back`; `spawner_mismatches` must read 0 in every scenario.
- **The regime rides in the marker, not in a new scenario field**: `BeltsParams.bench` stays the one knob; the `bench-64` golden must not move.
- **The slow gate is red on `main` between M46 and this milestone** (manager, 2026-10-12): `slow_tick_belts_large` trips the 25 % rule against M45's baseline since M46 (+35-39 %, unmeasured at M46's gate: its Verification commands named no slow run) and since M47 (+49-54 %); the brief's 1 ms criterion holds (+0.48 ms) and the 5 ms limit is far. Nothing re-records a baseline before the cost is reviewed (0069 §7), so the gate stays red until step 4 here; CI's slow tier records timings without gating (`bench-gate.mjs`: no fingerprint match).

## Order of work
1. `set_spawner` from the fixture; the regime in `BeltsParams.bench`; `pnpm golden belts` idempotent.
2. The arbiter on the seven worlds; `forecast_corrected_on_jam`.
3. `saturated_view_bytes` and `saturated_view_stress`; the budget row; the counters at the median profile.
4. The collapse-pricing cache; `slow_tick_belts_large` three runs; the manager promotes.
5. Deviations (bytes per cell on the wire against M41's model, corrections per visible run, `forecastSeenLate`, the tracker's cost), `tests/netcode/CLAUDE.md`, `fixtures/belts/CLAUDE.md`; commit.

## Tests added
Netcode: `belts/forecast_client_matches_host`, `belts/forecast_corrected_on_jam`, `belts/saturated_view_bytes` (the gate), `belts/saturated_view_stress` (recorded). Rust (fixture): `belts_spawner_declares_schedule` (`spawner_mismatches` 0 over 600 ticks on the bench world at 1/64). Slow: `slow_tick_belts_large` re-recorded.

## Exit criteria
- [ ] `belts/forecast_client_matches_host` passes on the seven worlds for 300 ticks with exact equality every tick, with an inject-fail-revert.
- [ ] `belts/forecast_corrected_on_jam` passes with an inject-fail-revert.
- [ ] `belts/saturated_view_bytes` passes `transport.downBytesPerSec` at 16,384 B/s on the (20 %, 100) run; the row's formula records the measured number, the (20 %, 20) figure and corrections per visible run per second; no `RunList` is sent in either run except at join (a `RunList` during the run is a finding: M41 measured 0 at depth 8).
- [ ] `slow_tick_belts_large` with the tracker on is within 1 ms of M45's median; the baseline is re-recorded for the reviewed delta.
- [ ] `pnpm test` and `pnpm lint` are green; `pnpm golden belts` idempotent.

## Verification commands
`pnpm test rust -t belts_` · `pnpm test netcode -t belts` · `pnpm test:slow rust -t slow_tick_belts_large` · `pnpm test && pnpm lint`

## Budgets
- `counters.transport.downBytesPerSec` (new row, 16,384 B/s, sections 12 and 13, the (20 %, 100) scenario); `belts-tick` re-recorded (limit 5 ms); the `netcode` suite's 10 s budget (the scenarios are long: measure the suite alone before and after; an `@slow` tag for the stress cell if needed).

## Context artifacts
`packages/engine/tests/netcode/CLAUDE.md` (the scenarios and counters); `fixtures/belts/CLAUDE.md` (`SaturatedView` at genesis, `set_spawner`); `docs/architecture/sync-and-netcode.md` only if M47's paragraph needs the measured numbers.

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
