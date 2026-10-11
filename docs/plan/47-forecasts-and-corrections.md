# M47: Forecasts and corrections

Status: not started · After: 46 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions, revised 2026-10-11 from M41's measurement (0078 Amendment A1-A6). Filled in to the full template at the start of its phase, from M46's Deviations.

## Goal
Items reach the client as forecasts the host corrects only when wrong, in the revised scheme of 0078 Amendment A3: a line's **run list** is sent in full only when membership changes in a way the client cannot derive; its **motion state** (`front_stop`, the spawner's schedule and `paused` flag) is corrected by a small **state message** on a halt, a release, a change of the stop ahead, a spawner pause or resume, or a structure change; sink exits are predicted by the path's terminal `Sink`, spawner inserts by the schedule, hand-offs by the ownership rule. `advance` marks dirty lines by the front-item check and due ticks of A3, the host rebuilds each dirty visible line's forecast and sends it in section `Forecasts` (13); the replica keeps one trajectory per item, answers `pos_at(line, item_index, render_t)` by the formula of 0078 §2 with stops derived as `front_stop + SPACING x k`, and runs no belt rule. The saturated-viewport scenario measures sections 12 and 13 together against the 16 KB/s row at (20 %, 100) and records the (20 %, 20) stress cell (A5); the belts tick baseline is re-recorded with the tracker on.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (whole, with its Amendment)
3. `docs/plan/41-forecast-spike.md` (Deviations: the instrumented events, the chosen `path` depth, the periodic-spawner decision)
4. `docs/architecture/sync-and-netcode.md` ("Rates, subscriptions, bandwidth"; the netcode `assertBudget` pattern in `tests/netcode/rates.test.ts`)
Rules that apply: `.claude/rules/determinism.md` (the tracker is host-only but runs inside the tick), `.claude/rules/hot-paths.md`.

## Scope (sketch)
- `transport/forecast.rs`: the tracker of M41's spike written as production code (not copied): per line the predicted stops as segments (a ring of `ceil(len / SPACING)`), the front-item check inside `advance`, due ticks computed at landing in a due-ordered queue (the spike's end-of-tick scan over every line was half its cost), the dirty list (preallocated, cleared at `seal`), the cheap-forecast builder walking the path to the first jam, dead end or sink up to **8** lines, the classifier (state message when every item's new stop is `front_stop + SPACING x k`, else a full run list), `forecast_version` per line.
- `advance` marks the events through M42's `touched` and `jam` hooks; the cost is measured against M45's baseline (the spike read +57 µs on a 19 µs mixed tick and +49 µs on the saturated viewport for the chosen configuration; the amendment's criterion is 1 ms) and `belts-tick.json` is re-recorded for the reviewed delta.
- `wire/forecast.rs`: section 13 with three record kinds, `RunList { line, runs: [item, count, pos], spawner? }`, `State { line, front_stop: Option<i32>, flags: paused | resumed }` and `Arrival { line, item, pos }` (an item entering a held line from a line the connection does not hold: per connection, 0078 A3 rule 6), the tick being the frame's; the six message rules of 0078 A3 as written (what a message covers, two lists belong to the source, `front_stop` of the `T - 1` list, a full list replaces exactly that list, an empty-line insert has no stop, the arrival's stop); no `path` field (the client holds the structures and follows `Next`; a path entry appears only where a `Fork` decides, M44/M48); allocation-free; the layout in `wire/CLAUDE.md`; a frame that cannot fit every dirty forecast keeps the rest dirty (0078 §7), the one-second resend rule.
- Replica: `Transport::apply_forecast` keeps one trajectory per item under the ownership rule (A3), re-stops a line's `T - 1` items on a `State`, replays the spawner schedule and pauses it on the flag; `pos_at(line, item_index, render_t) -> Option<(LineId, pos)>`; counters `forecastsApplied`, `stateMessagesApplied`, `forecastSeenLate` (applied for a tick already rendered).
- Netcode: the saturated-viewport scenario on `fx-belts` (`Regime::SaturatedView` at genesis through `BeltsParams.bench`, jams toggled by scripted `Sink`/`DeadEnd` requests at (20 %, 100) and, in a second run, (20 %, 20)), one client holding the whole view, 20 s of virtual time, production hashing on: `assertBudget({ transportDownBytesPerSec }, 'transport.downBytesPerSec')` on the (20 %, 100) run against a new `counters.transport.downBytesPerSec` row covering sections 12 and 13 (ceiling 16,384; modelled 4,947 B/s, so a 3x regression trips it; its `formula` names the scenario and records the (20 %, 20) figure, modelled 24,736 B/s with the per-message tick, expected lower on the wire), `transport.correctionsPerVisibleRunPerSec` and `forecastSeenLate` at the median network profile recorded. If (20 %, 20) reads above 32,768 B/s, the chain-level halt of A6 (i) is built in this milestone.
- The arbiter as a production test: `belts/forecast_client_matches_host`, the replica fed the real frames over the spike's seven 1/64 worlds (`SaturatedView` (20, 20) and (50, 30), mixed, inserter-edited, `speed = 72`, a 64-tile viewport, an empty start) for 300 ticks, equal to the host's `items_in` on every held line every tick; it is what proves the message rules, the spike's follower cases are the unit tests.
- Followability tests on the replica, the spike's five cases as production tests: a halt, a release, a halt whose stop lies downstream, a toggled sink, a spawner pause and resume; for 50 ticks after each message `pos_at` equals the host's positions (`items_in` as the oracle) with no further message.

## Seams
**Provides:** `SectionId::Forecasts`, `wire::forecast` (`RunList`, `State`), `Transport::{apply_forecast, pos_at, forecast_counters}`, host tracker, dirty list, classifier and builder, the `counters.transport.*` rows, `engine/test` `forecastCounters(client)`, the saturated-view netcode scenario (M48, M57 reuse).
**Consumes:** M41's tracker design and follower semantics (0078 A3; `fixtures/belts/tests/common/forecast.rs` as the reference, not the code), M46 structures and `last_sent`, M45 baseline and world, M42b's `Regime::SaturatedView` requests.

## Exit criteria
- [ ] `belts/forecast_followable` (the five cases: replica positions equal host positions for 50 message-free ticks after a halt, a release, a downstream halt, a toggled sink, a spawner pause and resume) and `belts/forecast_corrected_on_jam` (a jam forming sends a `State` within one frame and no `RunList`) pass with inject-fail-reverts.
- [ ] `belts/saturated_view_bytes` passes `transport.downBytesPerSec` (sections 12 and 13) at 16,384 B/s on the (20 %, 100) run with every visible belt saturated; the row's formula records the measured number, the (20 %, 20) figure and corrections per visible run per second; no `RunList` is sent in either run except at join (the spike's "not exactly derivable" count was 0 at depth 8: a `RunList` during the run is a finding).
- [ ] `slow_tick_belts_large` with the tracker on is within 1 ms of M45's median, or the amendment names the cost and an optimisation step ran; the baseline is re-recorded for the reviewed delta.
- [ ] `no_alloc_wire` and `no_alloc_transport` cover the builder and the section; the netcode scenario's `MajorGC` count is zero on the host side is not asserted (server is outside 0016).
- [ ] `pnpm test` and `pnpm lint` are green.

## Open questions (answered by earlier phases)
- M41 (answered, 0078 A1-A6): the dirty events as instrumented (a blocked, b moved, c off-path, d insert, d' refused, d'' resumed, e sink exit, f structure, edit), depth 8, the spawner schedule and sink prediction adopted, the state message, the ownership rule, the expected bytes per cell.
- M46: the per-connection `last_sent` shape (reused for forecast versions).
- Left to M48: late join cost, degrade behaviour, position-window culling if the budget needs it.

## Deviations
(filled in during execution)
