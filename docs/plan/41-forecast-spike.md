# M41: Forecast spike

Status: not started · After: 40 · Tyler-dependent: no

## Goal
A native, throwaway measurement of [0078](../decisions/0078-transport-forecast-replication.md)'s cheap forecast on M40's winning store: how often a line's forecast is invalidated, how many bytes the resulting forecasts would cost per second for one client seeing a saturated dense viewport, and what the dirty-tracking costs the tick. 0078 is confirmed with numbers, or revised (for example, forecasting a spawner's periodic inserts) before anything is built on it.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (§2 what a forecast is, §3 when it is dirty, §5 the budget)
3. `docs/architecture/sync-and-netcode.md` ("Rates, subscriptions, bandwidth": the 16 KB/s soft cap, degrade)
4. `docs/plan/40-item-representation-spike.md` (Deviations: the winner, the bench world, the spike's module layout)
Rules that apply: `.claude/rules/determinism.md`. Skills: `.claude/skills/run-tests/SKILL.md`.

## Scope
- `fixtures/belts/tests/spike_forecast.rs`, on M40's winning candidate module: a `Forecaster` that, after each `advance`, (a) detects dirty lines by the 0078 §3 events, instrumented inside the spike's advance (blocked at a position other than `stop`, moved while `stop` said halted, a hand-off onto a line other than the forecast's path, an insert or remove), and (b) rebuilds the cheap forecast for each dirty line (runs with `pos`, `stop`, `path` up to depth 4, following plain `Next` links and stopping at the first jam, dead end or sink).
- A byte model, not a wire format: `bytes(forecast) = 4 (line id) + 4 (tick) + 1 (n) + per run (2 item + 1 count + 3 pos + 3 stop + 1 + 3 x path_len)`; the real encoding is M47's. Reported per second at 20 Hz.
- Regimes: M40's `Mixed` as the baseline, plus a new `SaturatedView` regime in `bench_world`: a dense grid of lines standing in for a viewport of 256 x 144 tiles (all of it belts, every lane fed to saturation by spawners at the line heads, sinks at the tails), with jams forming and clearing at a controlled rate (`jam_toggle_period` ticks: a fraction `jam_fraction` of the sinks closes and reopens on a schedule). Measured at `(jam_fraction, period)` = (0, -), (0.05, 100), (0.2, 100), (0.2, 20), and with `path` depth 1, 2 and 4.
- The visible set: in `SaturatedView` every line is visible (the whole regime is one viewport); in `Mixed`, a fixed subset of lines whose chunk set meets a 256 x 144 rect at the world centre (the spike has no chunks: use the world builder's tile coordinates).
- Metrics per cell: forecasts rebuilt per tick (mean, p99), bytes per second for the visible set, corrections per visible run per second, and the tick cost with the tracker on versus off (median µs, same world, interleaved runs).
- A second byte line for the "periodic spawner" variant (0078 Consequences): a spawner's inserts at a fixed period are not corrections if the forecast carries `period`; report both so the amendment can choose.

## Non-scope
- The wire format, the client follower, scope by subscription, degrade (M46-M48). Any change to the advance itself.

## Files, packages and crates touched
- `packages/engine/fixtures/belts/tests/` (the spike and `common/world.rs`'s new regime). `docs/decisions/0078-transport-forecast-replication.md` (Amendment), `docs/decisions/README.md`.

## Seams
**Provides:** the measured table (0078 Amendment); `Regime::SaturatedView { jam_fraction, period }` in `bench_world` (M47 reuses it for the real scenario); the list of dirty events as instrumented (M47's `advance` marks the same events).
**Consumes:** M40's winner module, `bench_world`, the release-run helper.

## Planning decisions
- **Spike on the spike.** The tracker is written against M40's candidate code rather than waiting for M42's production module, because its answer may change M42 (what `advance` must expose to mark dirty lines cheaply) and M47.
- **Bytes are modelled, not encoded.** A fixed per-field model errs on the large side (varints would shrink ids and positions); if the modelled number is under budget the real one is too.
- **The viewport is a regime, not a camera.** The spike has no subscriptions; a regime whose every line is visible is the worst case for the budget and needs no scope code.
- **Pre-registered expectation.** With `jam_fraction = 0` corrections come only from spawner inserts and sink removals at the edges (two per lane per 2.67 ticks per line head and tail), so bytes scale with the number of line heads in view, not with items; the 0.2/20 cell is expected to be the one that threatens 16 KB/s. If the 0/- cell alone is over budget, the periodic-spawner forecast is adopted in the amendment.

## Order of work
1. `Regime::SaturatedView` in `bench_world`; its determinism and count tests.
2. The dirty-event instrumentation in the winner's advance (behind a `cfg(test)` flag inside the spike module), and `forecast_events_match_rule`: a 1/64 world where each event kind is provoked once and asserted (a jam forming, a jam clearing, a hand-off onto an unexpected line, an insert, a remove).
3. The forecast builder and `forecast_is_followable`: for 50 ticks after a rebuild with no further dirty event, every item's actual position equals the forecast's `pos(t)` evaluated by a client-side follower written in the test (the follower has no belt rule, only §2's formula).
4. The byte model and the measurement cells; the tracker-on/off tick cost.
5. The amendment to 0078 (table, decision on the periodic-spawner variant and on `path` depth), Deviations, commit.

## Tests added
Rust suite (`fx-belts`): `saturated_view_world_is_deterministic`, `forecast_events_match_rule`, `forecast_is_followable` (fast tier, 1/64 worlds). Slow tier: `slow_spike_forecast_cells` (the measurement, release).

## Exit criteria
- [ ] `forecast_events_match_rule` and `forecast_is_followable` pass, each with an inject-fail-revert (a suppressed dirty event reddens the first; a wrong `stop` reddens the second).
- [ ] `slow_spike_forecast_cells` prints every cell; the table is in Deviations and in 0078's Amendment with: bytes per second per cell, corrections per visible run per second, the tracker's tick cost, the chosen `path` depth and whether the periodic-spawner forecast is adopted.
- [ ] 0078's Amendment states whether the (0.2, 20) cell is under 16,384 B/s with the chosen options; if no option gets it under, the milestone reports the gap and the manager revises M47's brief before continuing.
- [ ] The tracker adds at most 1 ms to the mixed regime's median tick (else the amendment names the cost and M47's brief carries an optimisation step).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t forecast_` · `pnpm test:slow rust -t slow_spike_forecast_cells` · `pnpm test && pnpm lint`

## Budgets
- The 16 KB/s soft cap (0078 §5) is the decision threshold; the gated row `counters.transport.downBytesPerSec` is M47's.

## Context artifacts
`fixtures/belts/CLAUDE.md`: the new regime and how to read the spike. No skill, no rule.

## Manual device checks
none

## Deviations
(filled in during execution)
