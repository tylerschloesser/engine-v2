# M41: Forecast spike

Status: done (2026-10-11) · After: 40 · Tyler-dependent: no (one assumption recorded: the client-side spawner replay, `games/reference/README.md` "Belts")

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
- [x] `forecast_events_match_rule` and `forecast_is_followable` pass, each with an inject-fail-revert (a suppressed dirty event reddens the first; a wrong `stop` reddens the second).
- [x] `slow_spike_forecast_cells` prints every cell; the table is in Deviations and in 0078's Amendment with: bytes per second per cell, corrections per visible run per second, the tracker's tick cost, the chosen `path` depth and whether the periodic-spawner forecast is adopted.
- [x] 0078's Amendment states whether the (0.2, 20) cell is under 16,384 B/s with the chosen options; if no option gets it under, the milestone reports the gap and the manager revises M47's brief before continuing.
- [x] The tracker adds at most 1 ms to the mixed regime's median tick (else the amendment names the cost and M47's brief carries an optimisation step).
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t forecast_` · `pnpm test:slow rust -t slow_spike_forecast_cells` · `pnpm test && pnpm lint`

## Budgets
- The 16 KB/s soft cap (0078 §5) is the decision threshold; the gated row `counters.transport.downBytesPerSec` is M47's.

## Context artifacts
`fixtures/belts/CLAUDE.md`: the new regime and how to read the spike. No skill, no rule.

## Manual device checks
none

## Deviations

Steps 1-4 (implementer, 2026-10-11; step 5 is the manager's). Native release, Tyler's MacBook Pro, `pnpm test:slow rust -t slow_spike_forecast_cells` twice (load 1.4, then 15 right after a full `pnpm test`); every count below is deterministic and came out identical in both runs; the tick cost is the first run's (the second read 8 % higher). 200 warm-up ticks, 1,200 measured, seed 7. One `BENCH_SAMPLE` per world x depth carries all four variants (16 lines with the cost), recorded in `test-results/rust/bench/spike-forecast.json`.

**The cells.** "sink" = sink exits predicted by the path's terminal `Sink`; "periodic" = the periodic-spawner forecast; "both" = both. Rebuilt and bytes count the visible set only (all of `SaturatedView`; 1,010 of `Mixed`'s 3,810 lines). A correction is a rebuilt visible forecast; corrections per visible run per second = rebuilt per tick x 20 / mean visible runs.

| Cell | Depth | Rebuilt/tick mean (p99): baseline · sink · periodic · both | B/s: baseline · sink · periodic · both | Corrections/visible run/s: baseline · both |
|---|---|---|---|---|
| mixed | 1 | 121.27 (289) · 67.27 (151) · 55.24 (154) · 1.24 (10) | 1,490,338 · 888,868 · 613,465 · 11,995 | 0.0554 · 0.0006 |
| mixed | 2 | 120.81 (285) · 66.81 (148) · 54.78 (151) · 0.79 (8) | 1,620,947 · 1,019,477 · 609,366 · 7,896 | 0.0552 · 0.0004 |
| mixed | 4 | 120.23 (283) · 66.23 (144) · 54.13 (146) · 0.13 (2) | 1,778,412 · 1,176,942 · 602,663 · 1,193 | 0.0550 · 0.0001 |
| saturated (0, 0) | 1 | 736.50 (982) · 368.25 (982) · 368.25 (982) · 0.00 (0) | 7,782,855 · 4,111,320 · 3,671,535 · 0 | 0.0977 · 0.0000 |
| saturated (0, 0) | 2 | 736.50 (982) · 368.25 (982) · 368.25 (982) · 0.00 (0) | 8,354,130 · 4,682,595 · 3,671,535 · 0 | 0.0977 · 0.0000 |
| saturated (0, 0) | 4 | 736.50 (982) · 368.25 (982) · 368.25 (982) · 0.00 (0) | 9,001,050 · 5,329,515 · 3,671,535 · 0 | 0.0977 · 0.0000 |
| saturated (5, 100) | 1 | 720.98 (961) · 362.29 (954) · 362.29 (953) · 3.59 (10) | 7,628,176 · 4,056,563 · 3,614,124 · 42,511 | 0.0956 · 0.0005 |
| saturated (5, 100) | 2 | 720.76 (961) · 362.06 (954) · 362.06 (953) · 3.37 (10) | 8,190,869 · 4,619,256 · 3,614,776 · 43,163 | 0.0956 · 0.0004 |
| saturated (5, 100) | 4 | 720.55 (961) · 361.86 (954) · 361.86 (953) · 3.16 (10) | 8,821,894 · 5,250,281 · 3,612,523 · 40,910 | 0.0956 · 0.0004 |
| saturated (20, 100) | 1 | 675.80 (897) · 345.77 (852) · 345.77 (857) · 15.74 (39) | 7,164,844 · 3,894,986 · 3,461,656 · 191,797 | 0.0896 · 0.0021 |
| saturated (20, 100) | 2 | 674.75 (897) · 344.72 (850) · 344.72 (855) · 14.69 (39) | 7,678,214 · 4,408,356 · 3,459,595 · 189,737 | 0.0895 · 0.0019 |
| saturated (20, 100) | 4 | 673.66 (897) · 343.63 (850) · 343.63 (853) · 13.60 (39) | 8,246,431 · 4,976,573 · 3,448,291 · 178,433 | 0.0893 · 0.0018 |
| saturated (20, 20) | 1 | 727.00 (945) · 402.85 (923) · 402.85 (913) · 78.70 (105) | 7,823,164 · 4,615,102 · 4,167,048 · 958,986 | 0.0964 · 0.0104 |
| saturated (20, 20) | 2 | 721.75 (939) · 397.60 (914) · 397.60 (909) · 73.45 (96) | 8,331,311 · 5,123,249 · 4,156,745 · 948,683 | 0.0957 · 0.0097 |
| saturated (20, 20) | 4 | 716.30 (935) · 392.15 (906) · 392.15 (905) · 68.00 (92) | 8,857,957 · 5,649,895 · 4,100,227 · 892,165 | 0.0950 · 0.0090 |

**Events per tick on visible lines** (baseline variant, one per line per kind per tick; `a` depends on depth, the rest do not):

| Cell | Visible lines / runs (mean) | a (depth 1 · 2 · 4) | b | c | d | d' | e | f |
|---|---|---|---|---|---|---|---|---|
| mixed | 1,010 / 43,749 | 1.11 · 0.65 · 0.08 | 0.00 | 0.00 | 66.16 | 0.03 | 54.00 | 0.00 |
| saturated (0, 0) | 2,974 / 150,790 | 0.00 · 0.00 · 0.00 | 0.00 | 0.00 | 368.25 | 0.00 | 368.25 | 0.00 |
| saturated (5, 100) | 2,974 / 150,795 | 1.79 · 1.57 · 1.36 | 1.31 | 0.00 | 359.19 | 0.49 | 359.19 | 0.98 |
| saturated (20, 100) | 2,974 / 150,808 | 8.06 · 7.01 · 5.92 | 5.72 | 0.00 | 331.99 | 1.96 | 331.99 | 3.92 |
| saturated (20, 20) | 2,974 / 150,807 | 40.30 · 35.05 · 29.60 | 28.60 | 0.00 | 333.95 | 9.80 | 333.95 | 19.60 |

**Reading it.** The pre-registered expectation holds for `jam = 0` (corrections are exactly one insert and one sink exit per lane per 2.67 ticks: 368.25/tick = 982 lanes x 3/8), and the `(0, -)` cell alone is far over budget under 0078 §3 as written (7.8-9.0 MB/s), so by the plan's rule the periodic-spawner forecast is adopted; only with **both** variants does `(0, -)` reach 0 B/s. **The `(0.2, 20)` cell is not under 16,384 B/s with any option: 892,165 B/s at depth 4 with both variants (54x the cap)**, 948,683 at depth 2, 958,986 at depth 1. `(0.05, 100)` is also over (40,910 B/s, depth 4, both); `Mixed` is under with both (1,193 B/s at depth 4, 11,995 at depth 1). Depth 4 is cheapest under "both" in every cell (fewer `a` events beat the extra 3 B per path line); under the baseline deeper paths cost more bytes. What dominates the jam cells under "both": each toggle (`f`) stops or starts a whole packed lane chain at once, so every line of the chain deviates in the same tick (`a` on closing, `b` on opening) and is resent whole; a cycling-kind lane is one run per item (~100 runs a line), so its forecast is ~1.3 KB. `p99` of 982 in the jam-free cell: every lane starts packed at the same phase, so all inserts and exits fall on the same ticks (3 in 8); an artifact of the world, not of the forecast.

**Tracker cost** (`Mixed`, depth 4, baseline: the most rebuilds; off/on interleaved, five pairs, the median tick of each run): off 19.0, 18.8, 18.9, 18.8, 18.9 us; on 187.6, 185.5, 187.4, 186.7, 186.9 us. **Median off 18.9 us, on 186.9 us: +168.0 us, under the 1 ms criterion**; 93.3 us of it is the end of tick (the due scan over every line plus rebuilding and byte-modelling every dirty line, visible or not), the rest the hooks inside the advance (front check, segment ring with `%` arithmetic, landing). Allocation: none per tick (`forecast_no_alloc_small`).

**Definitions fixed.**
- `stop` is a cumulative position along the path in the forecast line's coordinates (positions grow backward: a stop on path line `i` is `pos_on_Pi - len(P1) - ... - len(Pi)`, negative), not `(path index, position)`: one `i32` per run, and the follower's formula is literally 0078 §2's. It assumes one speed along a path (true in both worlds); M47 needs `(index, position)` or per-line times if speeds differ along a path.
- The cheap forecast: walk the line's output then up to `depth` path lines; a `DeadEnd` puts the first item ahead at that line's front, a `Sink` gives `None`, and at the depth limit a line whose front item held this tick is a stop at its position ("a jam beyond sight stays a jam"; without it a long jam re-marks itself dirty every tick). Every item then stops `SPACING` behind the item ahead, so a run's stop is `origin + SPACING x items ahead` and the runs of one line form one chain. `path` = the plain `Next` lines walked (to the sink line, the dead end, or `depth`); a run's `path_len` in the byte model counts the path lines its stop lets it enter (`None`: all).
- **Ownership, a gap in 0078 §2:** a forecast of `L` at `T` describes `L`'s items at `T` and keeps describing an item after it crosses into a path line until that line's own forecast is rebuilt; a newer forecast of `L` replaces only the items still on `L` (the client keeps the superseded one for the items already handed off). Without this, rebuilding `L` would orphan the items it had handed off since the target's last forecast. The tracker mirrors it as per-line segments of items with one chained stop each.
- Detection: within a segment, if the front item moves as predicted every item behind does (`max(x - v, leader' + SP)` reduces to `max(x - v, stop)`), so the advance's front-item steps are the only per-tick checks; a landed item whose stop is not the chain of the segment ahead starts a segment, and the tick its prediction leaves the chain is computed at landing (both are free motion until then) and fires then unless the line was rebuilt. A deviation marks the line the item is physically on. `forecast_tracker_matches_oracle` checks this shortcut against a per-item check of every prediction every tick (1/64 `SaturatedView` at (20, 20) and (50, 30), and `Mixed`; depths 1 and 4; baseline and both; 300 ticks; A and B1 also agree under the sink toggles).
- Events as instrumented (`common/forecast.rs` `Ev`): (a) the front item, or a segment's first item at its due tick, moved less than predicted; (b) moved more; (c) a hand-off to a line other than the rebuilt forecast's first path line (only a structure change makes one; measured 0 everywhere); (d) `insert_back` succeeded; (d') the spawner was refused twice in a row with an unmoved tail, once per jam (cleared by the next success); (e) an item left through a `Sink`; (f) `set_out`; plus `Edit` for `insert_at`/`remove_at` (no measured cell has them). Corrections: baseline every kind but d'; sink-predicted drops e; periodic drops d and adds d'; both drops d and e and adds d'.
- The periodic-spawner variant: the forecast carries the spawner's `rate256` and accumulator, the client replays it against the forecast tail and gives an inserted item the chain's next stop; an exact replay would also predict refusals, so counting d' is the brief's conservative reading. Not in the byte model (exact as the brief): the variant's `period` field.
- `SaturatedView { jam_pct: u8, period: u16 }` (integers, not the brief's `jam_fraction`): 144 rows of 256 tiles, each row filled from `x = 0` with belt chains of 1-6 lines of 4-48 tiles (the standard world's distribution, the last chain cut at the row's end): 491 belt chains, 982 lane chains, 2,974 lines, 36,864 tiles, 294,912 items, every lane packed from tick 0, each front line a `Sink`, a `rate256 = 256` spawner on each rear line, alternate chains one kind or cycling. Jams: `jam_pct` % of the 982 sinks (seeded shuffle, rounded down: 49 at 5 %, 196 at 20 %), each with a seeded phase, closed while `(tick + phase) % period < period / 2`, so toggles are staggered; each toggle is `set_out` (event f); `period = 0` toggles nothing.
- Tile coordinates: `BenchWorld.spans` (`Span { x0, y, w }` per line), `width`, `height`, `toggles` (empty in M40's regimes). Standard world: belt chain `b` on row `b`, its front line at `x = 0` and the lines behind it to the right; extent 220 x 545. `visible_at_centre`: lines whose span meets the 256 x 144 rect at the extent's centre (tile-level: the spike has no chunks): 1,010 of `Mixed`'s 3,810 lines.

**Changed from the brief, and why.** The hooks are an `Observer` type parameter of `ReprB` (default `NoObs`, empty inlined hooks) rather than a `cfg(test)` flag; M40's `ReprB1`/`ReprB2` are unchanged in behaviour (`repr_rule_cases`, `repr_candidates_agree`, `repr_no_alloc_small` green). Added to the spike module: `ReprB::set_out` (drops the line's `jam` cache) and `ReprA::set_out` for the agreement check. Two tests beyond the brief's three: `forecast_tracker_matches_oracle` and `forecast_no_alloc_small` (the no-alloc test with the tracker on, in the new binary rather than in M40's). The follower test runs the sink-predicted variant (under the baseline a sink exit is itself a correction, so "no further dirty event" would exclude the sink-exit case) and asserts that no correction occurs. Fast tier: the five new tests take 0.18 s; `pnpm test` rust suite 1.5 s / 10 s.

**Inject-fail-revert** (each reverted, then green):
- (b) suppressed (the front check reports only `p > pred`): `forecast_events_match_rule` red, `(b): the jam clears`, left `[(Sink, 0), (Structure, 0)]`, right `[(Moved, 0), (Moved, 1), (Sink, 0), (Structure, 0)]`; `forecast_tracker_matches_oracle` also red, `saturated-view depth 1 baseline: tick 3: tracker vs oracle`, left `[]`, right `[38]`.
- A dead end's stop off by `SPACING` (`off + SP * ahead + SP`): `forecast_is_followable` red, `depth 2, rebuilt at tick 0: tick 1: follower vs advance`: the follower holds line 1's stopped run at 64, 128, 192, the advance at 0, 64, 128 (`(1, 64, 4)` against `(1, 0, 4)`); `forecast_events_match_rule` also red, `(a) depth 1: tick 1`, left `[(Moved, 0)]`, right `[]`.
- `36_864` -> `36_865` in `saturated_view_world_is_deterministic`: red, `tiles`, left `36864`, right `36865`.
- Two more on the measurement's machinery: landings always merged into the back segment (no due ever created): `forecast_events_match_rule` red, `(a) depth 1: tick 42`, left `[]`, right `[(Blocked, 0)]` (the oracle test stays green here: it checks detection against the tracker's own per-item predictions, not the ownership model, which the events and follower tests pin); due events suppressed: the oracle test red, `mixed depth 1 baseline: tick 86: tracker vs oracle`, left `[]`, right `[41]`.

**Open, for the manager.** No variant gets `(0.2, 20)` (or `(0.05, 100)`) under the cap, so per the exit criterion M47's brief needs revising. Levers not measured here: a forecast that resends only the runs that changed (a whole-line resend of a ~100-run cycling lane dominates), a jam toggle that forecasts the whole chain's halt from the one structure change (one correction per chain instead of one per line), and the tracker's end-of-tick scan over every line (a due-ordered queue would make it O(dirty)).

**Extension: the `LineState` variant** (the coordinator's request after step 4; one more `pnpm test:slow rust -t slow_spike_forecast_cells` at load 1.5: the four variants above came out identical, row for row, rebuilt counts, bytes and events). `LineState` has `Both`'s corrections (the same rebuilt lines per tick in every cell), each sent as a **state message** (11 B: line, tick, `front_stop`) or a **full forecast** (the model above). Visible lines only:

| Cell | Depth | LineState B/s | State messages/tick (B/s, share) | Full/tick (B/s, share) | Full by reason/tick: structural · blocked off stop |
|---|---|---|---|---|---|
| mixed | 1 | 477 | 1.21 (267, 56 %) | 0.03 (210, 44 %) | 0.03 · 0.00 |
| mixed | 2 | 377 | 0.76 (166, 44 %) | 0.03 (210, 56 %) | 0.03 · 0.00 |
| mixed | 4 | 233 | 0.10 (23, 10 %) | 0.03 (210, 90 %) | 0.03 · 0.00 |
| saturated (0, -) | 1, 2, 4 | 0 | 0 | 0 | 0 · 0 |
| saturated (5, 100) | 1 | 21,277 | 1.64 (361, 2 %) | 1.95 (20,916, 98 %) | 1.47 · 0.48 |
| saturated (5, 100) | 2 | 20,435 | 1.64 (361, 2 %) | 1.73 (20,074, 98 %) | 1.47 · 0.26 |
| saturated (5, 100) | 4 | 16,494 | 1.64 (361, 2 %) | 1.52 (16,133, 98 %) | 1.47 · 0.05 |
| saturated (20, 100) | 1 | 94,788 | 7.52 (1,654, 2 %) | 8.22 (93,134, 98 %) | 5.88 · 2.34 |
| saturated (20, 100) | 2 | 84,818 | 7.52 (1,654, 2 %) | 7.17 (83,164, 98 %) | 5.88 · 1.29 |
| saturated (20, 100) | 4 | 66,601 | 7.52 (1,654, 2 %) | 6.08 (64,946, 98 %) | 5.88 · 0.20 |
| saturated (20, 20) | 1 | 473,940 | 37.60 (8,272, 2 %) | 41.10 (465,668, 98 %) | 29.40 · 11.70 |
| saturated (20, 20) | 2 | 424,091 | 37.60 (8,272, 2 %) | 35.85 (415,819, 98 %) | 29.40 · 6.45 |
| saturated (20, 20) | 4 | 333,004 | 37.60 (8,272, 2 %) | 30.40 (324,732, 98 %) | 29.40 · 1.00 |

- **Against 16,384 B/s, best depth (4) under `LineState`:** `(0.2, 20)` 333,004 B/s, **over** (20x; `Both` was 892,165); `(0.05, 100)` 16,494 B/s, **over by 110 B/s** (`Both` 40,910); `(0, -)` 0 B/s, under; `Mixed` 233 B/s, under (`Both` 1,193). `(0.2, 100)` 66,601 B/s, over.
- What is left is full forecasts (98 % of the bytes in every jam cell), and they are almost all **structural**: the toggled sink line itself (`f`, 19.6/tick at (20, 20)) and the spawner line a jam reached (`d'`, 9.8/tick): exactly 29.40 = 19.60 + 9.80. A full forecast averages 534 B there (324,732 B/s / 20 / 30.4).
- **Not exactly derivable, sent full and counted:** one case only, "an item was blocked this tick but the line's front item is not at its new stop". It is the depth limit: a line beyond `depth` from the dead end whose front moved part of a step this tick (so it is not "held") gets `front_stop = None` while its items were blocked. 11.70/tick at depth 1, 6.45 at depth 2, 1.00 at depth 4 for (20, 20); 0.48 / 0.26 / 0.05 at (5, 100); 0 in `Mixed`. The other gates never fired in any cell: a line with no front step (0), crossers whose stop would change on a line not rebuilt this tick (0), a new stop behind its run (0).
- The state message's meaning, fixed: `front_stop` is the new stop of the line's front item **at `T - 1`** (items that cross the front during `T` are in that list; items that land during `T` follow it in order), so `front_stop = s0 - SPACING x c` with `s0` the front item's stop at `T` and `c` the items that crossed during `T` ("halt downstream": -128, while the front item at `T` stops at -64). A full forecast of a line at `T` wins over a same-tick state message for the items on it at `T`. The gates (`Tracker::classify`): only `a`/`b` on the line this tick; if any item reaching the front, or landing on the line, was blocked this tick, the front item must sit exactly at `s0` (blocked items are packed behind a blocked leader, so this covers all of them); crossers keep their stop unless their new line is rebuilt this tick; no new stop behind its run (checked in the build). `forecast_tracker_matches_oracle` now also runs `LineState` and checks every state message item by item (the line's `t - 1` items from their `t - 1` positions with the new stops land exactly where the advance put them).
- `forecast_line_state_is_followable`: a client that keeps one trajectory per item, replaces a line's items on a full forecast and re-stops a line's `t - 1` items on a state message. It follows the advance exactly for 50 ticks after a halt (`front_stop = 0`, tick 42), a resume (`None`, beside the sink line's full forecast) and a halt on the line downstream (`-128`, beside the edited line's full forecast); no other message or correction comes. Its trajectories hold at a dead end's front (0078 §2's "stops at the front of anything else") instead of panicking, so a wrong stop shows as a position.
- Inject-fail-revert: the follower deriving `stop_k = front_stop + SPACING x (k - 1)`: red, `halt: tick 42: client vs advance`, left `[(0, 0, 1), (0, 40, 1), (0, 116, 2)]`, right `[(0, 0, 1), (0, 64, 1), (0, 128, 2)]`. The classifier without its "blocked off stop" gate: `forecast_tracker_matches_oracle` red, `saturated-view depth 1 lineState: tick 27 line 10: state message, item 0`, left `-8`, right `0`.
- Tracker cost, re-measured (the `LineState` bookkeeping in the front hook runs in every variant): off 18.9, 18.9, 19.7, 19.1, 18.9 us; on 199.8, 201.8, 209.5, 199.1, 198.7 us; **median off 18.9, on 199.8: +180.9 us** (was +168.0), end of tick 91.2 us; still under 1 ms.
- Not in the byte model: the client's motion state per line is implied by the forecast it holds; a `LineState` client keeps every visible line's last run list (memory, not bytes).

**Extension 2: `LineState2` and depth 8** (the coordinator's second request; `pnpm test:slow rust -t slow_spike_forecast_cells` twice at load 2.9-3.0, 21 samples each, every count identical between the runs; every earlier number came out identical too: the four variants' table row for row and `LineState`'s bytes in all 15 cells). `LineState2` = `LineState` with: a structure change (`set_out`) sent as a state message, the structure itself as a `LineStructs` Put modelled at 19 B (`4 + 4 + 2 + 5 + 4`) in its own column; a refused spawner (`d'`) sent as a state message with a paused flag (12 B), and the spawner's next successful insert after a pause (a new event, `dResumed`, a correction only here) as the same message with the flag cleared; `MAX_DEPTH = 8`. Measured at depths 4 and 8 only (the earlier variants keep 1, 2, 4). Visible lines; "state" counts plain state messages, paused and resumed the flagged ones:

| Cell | Depth | Forecast B/s | `structBytesPerSec` | Sum vs 16,384 | Per tick: state · paused · resumed | Full/tick (not exactly derivable) | Bytes share: state-type · full · struct |
|---|---|---|---|---|---|---|---|
| mixed | 4 | 30 | 0 | 30 (under) | 0.11 · 0.03 · 0.00 | 0.00 (0.00) | 100 % · 0 % · 0 % |
| mixed | 8 | 7 | 0 | 7 (under) | 0.00 · 0.03 · 0.00 | 0.00 (0.00) | 100 % · 0 % · 0 % |
| saturated (0, 0) | 4 | 0 | 0 | 0 (under) | 0.00 · 0.00 · 0.00 | 0.00 (0.00) | - · - · - |
| saturated (0, 0) | 8 | 0 | 0 | 0 (under) | 0.00 · 0.00 · 0.00 | 0.00 (0.00) | - · - · - |
| saturated (5, 100) | 4 | 2,620 | 372 | 2,993 (under) | 2.62 · 0.49 · 0.49 | 0.05 (0.05) | 27 % · 60 % · 12 % |
| saturated (5, 100) | 8 | 812 | 372 | 1,184 (under) | 2.62 · 0.49 · 0.49 | 0.00 (0.00) | 69 % · 0 % · 31 % |
| saturated (20, 100) | 4 | 10,116 | 1,490 | 11,605 (under) | 11.44 · 1.96 · 1.96 | 0.20 (0.20) | 30 % · 57 % · 13 % |
| saturated (20, 100) | 8 | 3,458 | 1,490 | 4,947 (under) | 11.44 · 1.96 · 1.96 | 0.00 (0.00) | 70 % · 0 % · 30 % |
| saturated (20, 20) | 4 | 50,578 | 7,448 | 58,026 (**over**) | 57.20 · 9.80 · 9.80 | 1.00 (1.00) | 30 % · 57 % · 13 % |
| saturated (20, 20) | 8 | 17,288 | 7,448 | 24,736 (**over**) | 57.20 · 9.80 · 9.80 | 0.00 (0.00) | 70 % · 0 % · 30 % |

- **Against 16,384 B/s (forecast + struct Puts):** at depth 8, `(0.2, 20)` is **24,736 B/s, still over (1.5x)**; `(0.2, 100)` 4,947, `(0.05, 100)` 1,184, `(0, -)` 0 and `Mixed` 7: under. At depth 4, `(0.2, 20)` is 58,026, over; the others under (`(0.2, 100)` 11,605, `(0.05, 100)` 2,993, `Mixed` 30).
- **The not-exactly-derivable full forecasts reach 0 at depth 8** in every cell (the one case, a front item blocked short of its stop beyond the path depth: 1.00/tick at (20, 20) depth 4, 0.20 at (20, 100), 0.05 at (5, 100)). No other full forecast is left in any `LineState2` cell: off-path hand-offs and edits never occur in these worlds.
- What remains at (0.2, 20), depth 8: 76.8 state-type messages per tick (57.2 plain, 9.8 paused, 9.8 resumed), 17,288 B/s, already over the cap by itself; the struct Puts add 7,448 B/s (19.6 `set_out` per tick). The plain state messages are one per line of every lane chain a toggle stops or starts (each of the chain's lines deviates in the same tick).
- Rebuilt lines per tick under `LineState2` exceed `LineState`'s by the resumes (77.8 against 68.0 at (20, 20), depth 4: the extra 9.8 are `dResumed`).
- Classifier: the structural gate keeps only off-path hand-offs and edits; the derivability gates are unchanged and now also cover the toggled and spawner lines. `forecast_tracker_matches_oracle` runs `LineState2` and depths 1, 4 and 8, and checks paused and resumed messages item by item like state messages.
- `forecast_line_state_is_followable`, two new cases under `LineState2` (the earlier three unchanged):
  - **toggled sink:** a sink line closes at tick 2 (one state message, `front_stop = 0`) and the items halt at 0 and 64; it reopens at tick 60 (`front_stop = None`) and the items leave through the sink; 50 ticks with no message after each.
  - **spawner pause:** one insert per 4 ticks onto a dead end, full after tick 4; the second refusal in a row (tick 9) sends `Paused(0)`; the sink opens at tick 20 (`State(None)`); the next insert (tick 21) sends `Resumed(None)`. The client replays the spawner's schedule against its own tail, stops on the paused message, and on the resumed one adds that tick's insert and restarts the schedule. Positions and item counts equal the advance's for 50 ticks.
- Inject-fail-revert: the client dropping the toggled sink's state messages: red, `toggled sink: tick 10: client vs advance`, left `[(0, 0, 1), (0, 60, 2)]`, right `[(0, 0, 1), (0, 64, 2)]`. The client ignoring the paused flag (its replay keeps running): red, `spawner pause: resume` (the replay has already used the room at tick 21, so the resumed message's insert finds none: the client's invariant "a resumed message carries that tick's insert" fails).
- Tracker cost, re-measured (baseline, depth 4; the `dResumed` check runs in every variant; the second run's, since the first run's record was cleared by the fast-test runner, which agreed within 2 %): off 19.4, 19.0, 19.4, 19.2, 19.3 us; on 210.1, 208.1, 208.0, 210.9, 211.5 us; **median off 19.3, on 210.1: +190.8 us**, end of tick 94.9 us; under 1 ms.
- Fast tests through the runner: `pnpm test rust -t forecast_` prints `rust pass 5 tests` (`forecast_events_match_rule`, `forecast_line_state_is_followable`, `forecast_is_followable`, `forecast_no_alloc_small`, `forecast_tracker_matches_oracle`; the filter also matches `slow_spike_forecast_cells`, which is slow tier and not run there); `pnpm test rust -t saturated_view` prints `rust pass 1 tests` (`saturated_view_world_is_deterministic`). Running them clears `test-results/`, including the spike's record.

**Extension 3: the adversarial review's findings 1-6, 8, 9 and 11** (`scratchpad/m41-review.md`; one `pnpm test:slow rust -t slow_spike_forecast_cells` at load 2.7, 24 samples).

*The arbiter.* `forecast_client_matches_advance` drives a client fed `LineState2`'s real message stream through 300 ticks at depths 4 and 8, on seven 1/64 worlds: `SaturatedView` (20, 20) and (50, 30), `Mixed`, `InserterLike` (edits, so full forecasts), `SaturatedView` (50, 30) at `speed = 72`, `Mixed` through a 64-tile-wide view, and `Mixed` empty at the start (inserts onto empty lines). The messages are state, paused/resumed, full forecasts, structure Puts and arrivals. Every tick it asserts that the client's items on every visible line, and their count, equal the advance's, with exact equality. The client knows only:
- §2's formula, with stops `front_stop + SPACING x k`;
- path following through `Next` (and 0078 §2's hold at a dead end's front, which never fires: replacing it with a panic leaves every test green);
- the trajectory-per-item ownership rule;
- the message rules below;
- the spawner replay (the game's schedule, cycling kinds included).

The oracle test now runs on the same seven worlds (all lines visible) at depths 1, 4 and 8.

*The rules M47 must implement* (the fixes; host-side in `Tracker::message`/`resegment`, client-side in the test's `Client`):
1. **What a message of line `L` at tick `T` covers** (state, paused, resumed or full): the items `L` held at `T - 1`, including those that crossed its front during `T`, plus the items inserted on `L` during `T`. It never covers the items that landed on `L` during `T`.
2. **An item in two lists** (it crossed from `S` to `L` during `T`) belongs to `S`'s list. If `S` sends a message, the item takes `S`'s new chain, `msg_base(S) + SPACING x j`, translated onto `L`. Otherwise it keeps its trajectory. `L`'s message, state or full, never touches it. The host keeps such landers as their own segments behind `L`'s new chain. A lander that disagrees with the chain gets its due tick and is corrected when it deviates; it is then in `L`'s `T - 1` list.
3. **A state message's `front_stop`** is the stop of the first item of that list: `s0 - SPACING x crossers`. The `FULL_CROSSED` gate is gone: crossers are always re-stopped by their own line's message.
4. **A full forecast** replaces exactly the client's items in that list. Its runs are the list's items at `T`: crossers at their position on the next line (negative, in `L`'s coordinates), none past a sink; inserts; no landers. It does not replace by the client's own positions at `T` (finding 5).
5. **An insert onto an empty line** gets no stop (`None`), on host and client alike (finding 3). The client has no item to chain from. When the item is blocked, that is an ordinary correction. An insert onto a non-empty line gets `SPACING` behind the last item's stop.
6. **An arrival from an invisible line** (finding 8) is `Arrival { line, item, pos }`. Its stop is `SPACING` behind the stop of the line's last item at `T - 1` (or of the previous arrival this tick), or `None` if the line had none. On the host, a line emptied by crossings this tick keeps the chain its last item left.

No case needed a belt rule on the client, so none was counted as a full forecast for that reason.

*What each finding was, measured.*
- **Finding 1** (landers taking `L`'s chain), restored: the arbiter fails at `inserter-like, depth 4: tick 281: client vs advance`. `forecast_line_state_is_followable` also fails (`halt downstream: tick 4: no message`), and so does the oracle (`mixed depth 1 baseline: tick 107: tracker vs oracle`).
- **Finding 2** (crossers keeping their old stops), restored: the arbiter stays green. The client draws correctly, because the host's drifted model only sends extra corrections later. Other tests fail: `resume: tick 3: no message`, `(b): rebuilt, free flow`.
- **Finding 3:** 0 occurrences in the first six worlds over 300 ticks. With the old stop (`front_stop` for an empty line), the arbiter fails only on the empty-start world: `mixed, empty at the start, depth 4: tick 285: client vs advance`.
- **Finding 5** (full forecasts replacing by position at `T`), restored: fails at `resume: tick 2: item count` and at `saturated-view (50, 30), depth 4: tick 6: items on visible lines`.
- **Finding 6:** the speed-72 world has 560 rebuilt-line ticks with two crossers, all with `s0 = None`, so the arithmetic is not exercised there. A hand case was added: "two crossers at speed 72", `State(-128)`. Forcing one crosser fails at `two crossers at speed 72: tick 2: messages`, left `State(Some(-64))`, right `State(Some(-128))`.
- **Coordinator's inject** (the client's state message also re-stops the items that landed during `T`): fails at `saturated-view (20, 20), depth 4: tick 9: client vs advance`. The first difference is `(9, 1536, 6)` against `(10, 0, 6)`.

*Spawner fields and Puts in the byte model.*
- **Spawner fields:** +7 B per full forecast of a spawner's line in the periodic variants.
- **Struct Puts:** now reported for every variant (`structBytesPerSec`, finding 11).
- **Effect at depth 4:**

| Cell (depth 4) | B/s: baseline · sink · periodic · both · LineState | Struct Puts B/s (any variant) |
|---|---|---|
| mixed | 1,773,789 · 1,176,969 · 599,303 · 1,223 · 238 | 0 |
| saturated (0, 0) | 8,973,750 · 5,329,515 · 3,657,885 · 0 · 0 | 0 |
| saturated (5, 100) | 8,795,476 · 5,250,422 · 3,599,559 · 41,264 · 16,574 | 372 |
| saturated (20, 100) | 8,222,845 · 4,977,206 · 3,437,732 · 179,917 · 66,896 | 1,490 |
| saturated (20, 20) | 8,837,377 · 5,653,060 · 4,095,852 · 899,586 · 334,482 | 7,448 |

*Which numbers moved* (against the earlier tables):
- **Counts:** only `Mixed`'s, from the empty-insert rule:
  - baseline rebuilt/tick 121.27 to 121.34 (depth 1);
  - `Both` 1.24 to 1.31 (depth 1), 0.79 to 0.83 (depth 2), 0.13 to 0.14 (depth 4);
  - `LineState2` state messages 0.133 to 0.135 (depth 4).
  Every `SaturatedView` count is identical.
- **Bytes:**
  - baseline −0.2 to −0.35 % (full forecasts now leave out landers and include crossers);
  - periodic −0.1 to −0.6 %;
  - `Both` +0.75 to +4.8 % (spawner fields);
  - `LineState`: +2 to +4 % on `Mixed` (477 to 495 at depth 1, 233 to 238 at depth 4), up to +0.5 % on the saturated cells;
  - `LineState2` at depth 4 by 7-140 B/s;
  - `LineState2` at depth 8 unchanged in every cell: 0 full forecasts there.

*LineState2, re-measured:*

| Cell | Depth | `LineState2` B/s: forecast + struct = total | Per tick: state · paused · resumed · full |
|---|---|---|---|
| mixed | 4 | 30 + 0 = 30 | 0.11 · 0.03 · 0.00 · 0.00 |
| mixed | 8 | 7 + 0 = 7 | 0.00 · 0.03 · 0.00 · 0.00 |
| mixed (64-tile view) | 8 | 0 + 0 = 0 | 0.00 · 0.00 · 0.00 · 0.00 |
| saturated (0, 0) | 4 | 0 + 0 = 0 | 0.00 · 0.00 · 0.00 · 0.00 |
| saturated (0, 0) | 8 | 0 + 0 = 0 | 0.00 · 0.00 · 0.00 · 0.00 |
| saturated (5, 100) | 4 | 2,627 + 372 = 3,000 | 2.62 · 0.49 · 0.49 · 0.05 |
| saturated (5, 100) | 8 | 812 + 372 = 1,184 | 2.62 · 0.49 · 0.49 · 0.00 |
| saturated (20, 100) | 4 | 10,144 + 1,490 = 11,633 | 11.44 · 1.96 · 1.96 · 0.20 |
| saturated (20, 100) | 8 | 3,458 + 1,490 = 4,947 | 11.44 · 1.96 · 1.96 · 0.00 |
| saturated (20, 20) | 4 | 50,718 + 7,448 = 58,166 | 57.20 · 9.80 · 9.80 · 1.00 |
| saturated (20, 20) | 8 | 17,288 + 7,448 = 24,736 | 57.20 · 9.80 · 9.80 · 0.00 |

**Against 16,384 B/s** (unchanged conclusion):
- `(0.2, 20)` at depth 8 is 24,736 B/s: over.
- `(0.2, 100)` 4,947, `(0.05, 100)` 1,184, `(0, -)` 0, `Mixed` 7: under.

*Off-screen arrivals* (`Mixed`, 64-tile-wide view, depth 8): 4.69 arrivals per tick.
- As arrival messages: **843 B/s**.
- As full forecasts of their lines instead: **112,022 B/s**.
- The view's own `LineState2` forecast traffic is 0 B/s over the 1,200 ticks. The 64-tile slice holds neither the sinks nor the spawners, and at depth 8 every jam is in sight.

*Cost on the chosen setup* (5 interleaved pairs each):
- mixed, depth 4, baseline: off 19.6, 19.2, 19.2, 19.2, 19.9; on 268.7, 268.3, 269.8, 268.4, 263.8 us; **median off 19.2, on 268.4: +249.2 us** (end of tick 198.2 us)
- mixed, depth 8, lineState2: off 19.0, 19.2, 19.0, 19.0, 19.0; on 81.8, 76.0, 74.7, 76.6, 75.1 us; **median off 19.0, on 76.0: +57.0 us** (end of tick 2.9 us)
- saturated-view (20, 20), depth 8, lineState2: off 20.3, 20.3, 20.2, 20.2, 20.5; on 69.3, 69.1, 69.0, 70.2, 70.0 us; **median off 20.3, on 69.3: +49.0 us** (end of tick 22.5 us)

All are under 1 ms. The baseline's end of tick doubled (95 to 198 us): every rebuild now runs a second phase (re-stopping crossers and landers) and the full-forecast build.

*Allocation:* `forecast_no_alloc_small` also runs `LineState2` at depth 8 on the seven worlds with their views: 0 live, 0 high-water.

*Fast tests through the runner:*
- `pnpm test rust -t forecast_`: 6 tests (`forecast_client_matches_advance` added).
- `pnpm test rust -t saturated_view`: 1 test.

**Manager's gate and review (2026-10-11).** Three extensions were asked of the implementer after step 4, each from a finding: the `LineState` variant (a per-line motion-state correction instead of a whole run list) when the §3-as-written scheme measured 54x over the cap; `LineState2` (structure changes and spawner pauses as state messages, depth 8) when 98 % of the remaining bytes were full lists of lines whose runs had not changed; and the end-to-end client test when the adversarial review (an Opus reviewer, read-only, briefed with this file, 0078, 0069 §A-D and the code) showed the oracle proved the tracker only against its own stops and named three cases where a client's reconstruction would differ (an item landing on a line that sends a state message the same tick; crossers onto a line that only sends a state message; an insert onto an empty line with a stop in sight). The review's eleven findings: 1-6 and 8-11 are closed by Extension 3 (six message rules, the arbiter test on seven worlds, the arrival message, the spawner fields and struct puts in the byte model, cost and allocation on the chosen configuration); 7 (the client-side spawner replay as belt logic) is Tyler's and is recorded as an **(assumed)** line in `games/reference/README.md` "Belts" with the default proceeding. The manager reran every verification command: `forecast_` 6 tests, `saturated_view` 1, `repr_` 3, `bench_world` 2 green; `pnpm lint` green; `slow_spike_forecast_cells` 24 samples at load 3.2 with the Extension 3 numbers; full `pnpm test` green (rust 3.3 s of 10 s). One `browser` red earlier in the gate, the reference game's `reference_furnace_pick_up` at load 4.8-10, the same load-sensitive test M40's gate saw (6 of 6 green alone), not charged. The exit criterion on the (0.2, 20) cell is met by its second clause: no option gets it under 16,384 B/s under the brief's byte model (24,736 B/s at depth 8, of which 7,448 are structure puts from toggling by edits and 4 B per message is the frame's tick), the gap is reported in 0078 A4-A5, and M47's brief is revised (the line-state scheme, the `Arrival` record, the six rules, the gated cell (20 %, 100) and the recorded stress cell). Decisions moved to 0078's Amendment A1-A7 (Status: Accepted as revised); the plan-level decision on the gated cell is in `PLAN.md`.
