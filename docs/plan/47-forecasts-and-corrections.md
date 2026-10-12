# M47: Forecasts and corrections

Status: not started · After: 46 · Tyler-dependent: no (the client-side spawner replay is an **(assumed)** line in `games/reference/README.md` "Belts"; the default proceeds)

Filled in to the full template on 2026-10-12 from [0078](../decisions/0078-transport-forecast-replication.md) A1-A7 (the scheme as revised by M41's measurement), [0079](../decisions/0079-transport-core-decisions.md) §9-§16 and M45's Deviations (the tick is 0.79 ms with frames at 78 % of it; the tracker added 57 µs to a 19 µs advance in the spike).

## Goal
Items reach the client as forecasts the host corrects only when wrong, in the revised scheme of 0078 A3: a line's **run list** is sent in full only when membership changes in a way the client cannot derive; its **motion state** (`front_stop`, the spawner's schedule and `paused` flag) is corrected by a small **state message** on a halt, a release, a change of the stop ahead, a spawner pause or resume, or a structure change; an item entering a held line from a line the connection does not hold arrives as an **arrival**; sink exits are predicted by the path's terminal `Sink`, spawner inserts by the schedule, hand-offs by the ownership rule. `advance` marks dirty lines by the front-item check and due ticks of A3; the host rebuilds each dirty visible line's forecast and sends it in section `Forecasts` (13); the replica keeps one trajectory per item, answers `pos_at(line, item_index, render_t)` by the formula of 0078 §2 with stops derived as `front_stop + SPACING x k`, and runs no belt rule. The saturated-viewport scenario measures sections 12 and 13 together against the 16 KB/s row at (20 %, 100) and records the (20 %, 20) stress cell (A5); the belts tick baseline is re-recorded with the tracker on.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (whole, with its Amendment A1-A7: A3's message rules 1-6 are the specification)
3. `docs/plan/41-forecast-spike.md` (Deviations and the three Extension blocks: the instrumented events, the tracker's segments and due ticks, the classifier, the follower; the tracker's reference code is `fixtures/belts/tests/common/forecast.rs` at commit `864cb3a8`, deleted by M45, read with `git show 864cb3a8:packages/engine/fixtures/belts/tests/common/forecast.rs`, never copied)
4. `docs/architecture/sync-and-netcode.md` ("Rates, subscriptions, bandwidth"; the netcode `assertBudget` pattern in `tests/netcode/rates.test.ts`)
Rules that apply: `.claude/rules/determinism.md` (the tracker is host-only but runs inside the tick), `.claude/rules/hot-paths.md`, `.claude/rules/prediction.md`. Skills: `run-tests`, `profile-frame` (its method, for the host-side profile if the tracker's cost is over the criterion).

## Scope
- `transport/forecast.rs` (host): the tracker of M41's spike written as production code: per line the predicted stops as segments (a ring of `ceil(len / SPACING)` per line, reserved from `max_items`), the front-item check inside `advance` (one comparison per front item: if it moves as predicted every packed item behind it does), due ticks computed at landing in a due-ordered queue (the spike's end-of-tick scan over every line was half its cost), the dirty list (preallocated, cleared at `seal`), the cheap-forecast builder walking the path to the first jam, dead end or sink up to **8** lines, the classifier (a state message when every item's new stop is `front_stop + SPACING x k` for the line's `T - 1` list, else a full run list; A3 rules 1-6 as written), `forecast_version` per line, the spawner schedule (`rate256`, accumulator, cycling flag, next item) and `paused` flag read from the game's spawner through a `TransportWrite::set_spawner(line, schedule)` the game calls when it configures a spawner (the engine does not run the spawner; it forecasts it).
- `advance` marks the events through M42's `touched` and `jam` hooks (the cost is measured against M45's baseline; `belts-tick.json` is re-recorded for the reviewed delta, the criterion being 0078 A3's 1 ms).
- `wire/forecast.rs`: section 13 with three record kinds, `RunList { line, runs: [item, count, pos], spawner? }`, `State { line, front_stop: Option<i32>, flags: paused | resumed }` and `Arrival { line, item, pos }` (an item entering a held line from a line the connection does not hold: per connection, A3 rule 6), the tick being the frame's; no `path` field (the client holds the structures and follows `Next`; a path entry appears only where a `Fork` decides, as `RunList.fork_side` per run when the run's path crosses a fork within the horizon); allocation-free; the layout in `wire/CLAUDE.md`; a frame that cannot fit every dirty forecast keeps the rest dirty (0078 §7), the one-second resend rule.
- Host routing: per connection, the forecast of a dirty line goes to every connection holding the line's structure (M46's `last_sent` tells which); arrivals are per connection (the connection does not hold the source line's structure).
- Replica: `Transport::apply_forecast` keeps one trajectory per item under the ownership rule (A3), re-stops a line's `T - 1` items on a `State`, replays the spawner schedule and pauses it on the flag, places an `Arrival`; `pos_at(line, item_index, render_t) -> Option<(LineId, pos)>` following `Next` through the held structures; `items_in`/`count`/`front` on the replica answer from the trajectories at the replica's tick; counters `forecastsApplied`, `stateMessagesApplied`, `arrivalsApplied`, `forecastSeenLate` (applied for a tick the client has already rendered: the render time is past the message's tick when it arrives), `transport.correctionsPerSec`.
- Netcode: the saturated-viewport scenario on `fx-belts` (`Regime::SaturatedView` at genesis through `BeltsParams.bench`, jams toggled by scripted `Sink`/`DeadEnd` requests at (20 %, 100) and, in a second run, (20 %, 20)), one client holding the whole view (its subscription covers the 256 x 144 viewport), 20 s of virtual time, production hashing on: `assertBudget({ transportDownBytesPerSec }, 'transport.downBytesPerSec')` on the (20 %, 100) run against a new `counters.transport.downBytesPerSec` row covering sections 12 and 13 (ceiling 16,384; modelled 4,947 B/s, so a 3x regression trips it; its `formula` names the scenario and records the (20 %, 20) figure, modelled 24,736 B/s with the per-message tick, expected lower on the wire), `transport.correctionsPerVisibleRunPerSec` and `forecastSeenLate` at the median network profile recorded. If (20 %, 20) reads above 32,768 B/s, the chain-level halt of A6 (i) is built in this milestone.
- The arbiter as a production test: `belts/forecast_client_matches_host`, the replica fed the real frames over the spike's seven 1/64 worlds (`SaturatedView` (20, 20) and (50, 30), mixed, inserter-edited, `speed = 72`, a 64-tile viewport, an empty start) for 300 ticks, equal to the host's `items_in` on every held line every tick; it is what proves the message rules; the spike's five follower cases are the unit tests (a halt, a release, a halt whose stop lies downstream, a toggled sink, a spawner pause and resume).

## Non-scope
- Prediction, late join at scale, degrade levels, reconnect (M48); drawing (M49); the reference game's spawner UI (M53); the chain-level halt unless the stress cell demands it.

## Files, packages and crates touched
- `packages/engine/crates/engine/` (`transport/forecast.rs` new, `transport/{mod,advance,line}.rs`, `wire/forecast.rs` new, `wire/mod.rs`, `wire/CLAUDE.md`, `host/mod.rs`, `client/replica.rs`, `tests/no_alloc_wire.rs`, `tests/no_alloc_transport.rs`, `tests/main/`).
- `packages/engine/src/test/` (`engine/test` `forecastCounters(client)`), `packages/engine/tests/netcode/` (the saturated-view scenario, the arbiter), `packages/engine/budgets.json` (the row), `packages/engine/baselines/belts-tick.json` (re-recorded).
- `packages/engine/fixtures/belts/` (`Op::Spawner` calls `set_spawner`; `BeltsParams.bench` gains `Regime::SaturatedView` with `jam_pct`/`period`: `src/bench/world.rs` already builds it).

## Seams
**Provides:** `SectionId::Forecasts` (13), `wire::forecast::{RunList, State, Arrival}`, `Transport::{apply_forecast, pos_at, forecast_counters, set_spawner}`, host tracker, dirty list, classifier and builder, the `counters.transport.*` rows, `engine/test` `forecastCounters(client)`, the saturated-view netcode scenario (M48, M57 reuse).
**Consumes:** M41's tracker design and follower semantics (0078 A3); M46's structures, `last_sent` and routing; M45's baseline and world; M44b's `SaturatedView` world and `Regime`; M42b's request pattern.

## Planning decisions
- **The engine forecasts the spawner the game runs.** `set_spawner(line, schedule)` tells the tracker the schedule the game's tick rule follows (0078 A3: `rate256`, accumulator phase, cycling, next item); the game keeps running its own spawner through `insert_back`; a mismatch between what the game does and what it declared is a correction the tracker sees as an unpredicted insert (counted: `transport.spawnerMismatches`, expected 0 for `fx-belts` and the reference game). The client-side replay is the **(assumed)** line Tyler has not yet ruled on; if he refuses it, the fallback is a state message per insert (M41 measured 3.7 MB/s on a saturated viewport without it, so the fallback is a different spawner model, not "no forecast").
- **The due-ordered queue, not the scan.** M41's end-of-tick scan over every line was 93 of 168 µs; a binary heap keyed by due tick, reserved from `max_items`, makes the tick O(dirty).
- **Depth 8, no `path` field.** M41: depth 8 left no undecidable line; the client holds every structure it needs to follow `Next`, so the path travels only as `fork_side` where a fork decides within the horizon.
- **Arrivals are per connection** (0078 A6 (0)): the host's dirty tracking is per line; the arrival check is per connection in `build_frame` (an item crossed into a held line from a line this connection does not hold this tick: the host knows both from `last_sent`).
- **Sections 12 and 13 share the budget row** (0078 A5); the (20 %, 20) cell is recorded, not gated.

## Order of work
1. `transport/forecast.rs` tracker (segments, due queue, dirty list, builder, classifier) against `Transport` with unit tests on hand worlds (the five follower cases as host-side expectations); `set_spawner`.
2. `wire/forecast.rs` and `wire/CLAUDE.md`; `no_alloc_wire`.
3. Host routing and per-connection arrivals; the replica's `apply_forecast`, `pos_at`, counters; the arbiter test on the seven worlds.
4. The netcode saturated-view scenario, the budget row, the counters; `forecastSeenLate` at the median profile.
5. `slow_tick_belts_large` with the tracker on: measure, profile if over 1 ms added, re-record the baseline for the reviewed delta (the manager promotes).
6. Deviations (bytes per cell on the wire against M41's model, corrections per visible run, the tracker's cost), `docs/architecture/sync-and-netcode.md` one paragraph; commit.

## Tests added
Rust suite: `forecast_tracker_marks_events` (the event kinds on hand worlds), `forecast_classifier_state_vs_runlist`, `forecast_builder_depth_and_stops`, `wire_forecast_round_trip`, `replica_follows_state_message` (the five cases), `replica_arrival_gets_stop`, `no_alloc_wire`/`no_alloc_transport` extended (the tracker inside the window). Netcode: `belts/forecast_client_matches_host` (the arbiter), `belts/forecast_corrected_on_jam`, `belts/saturated_view_bytes` (the gate), `belts/saturated_view_stress` (recorded). Slow: `slow_tick_belts_large` re-recorded.

## Exit criteria
- [ ] `belts/forecast_client_matches_host` passes on the seven worlds for 300 ticks with exact equality every tick, with an inject-fail-revert (a state message applied to items that landed during `T` reddens it, as the spike's did).
- [ ] `belts/forecast_corrected_on_jam` (a jam forming sends a `State` within one frame and no `RunList`) passes with an inject-fail-revert.
- [ ] `belts/saturated_view_bytes` passes `transport.downBytesPerSec` (sections 12 and 13) at 16,384 B/s on the (20 %, 100) run; the row's formula records the measured number, the (20 %, 20) figure and corrections per visible run per second; no `RunList` is sent in either run except at join (a `RunList` during the run is a finding: M41 measured 0 at depth 8).
- [ ] `slow_tick_belts_large` with the tracker on is within 1 ms of M45's median (0.79 ms); the baseline is re-recorded for the reviewed delta, or the cost is named with a profile and an optimisation step ran.
- [ ] `no_alloc_wire` and `no_alloc_transport` cover the builder, the queue and the section.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t forecast_` · `pnpm test rust -t wire_forecast` · `pnpm test netcode -t belts` · `pnpm test:slow rust -t slow_tick_belts_large` · `pnpm test && pnpm lint`

## Budgets
- `counters.transport.downBytesPerSec` (new row, 16,384 B/s, sections 12 and 13, the (20 %, 100) scenario); `belts-tick` re-recorded (limit 5 ms); allocation per tick and per frame (`no_alloc_*`).

## Context artifacts
`wire/CLAUDE.md` (section 13); `docs/architecture/sync-and-netcode.md` (a "Transport forecasts" paragraph: what travels, when, and the client's rule); `packages/engine/tests/netcode/CLAUDE.md` (the scenario and counters); `fixtures/belts/CLAUDE.md` (`SaturatedView` at genesis).

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
