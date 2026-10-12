# M47: Forecasts and corrections (engine)

Status: not started · After: 46 · Tyler-dependent: no · Split 2026-10-12: the `fx-belts` genesis regime, `set_spawner` from `Op::Spawner`, the netcode scenarios (the seven-world arbiter, the saturated-view budget and stress cells), the budget row and the baseline re-record moved to `47b-forecast-scenarios-and-budget.md` (sizing rule, as M42-M44)

Filled in to the full template on 2026-10-12 from [0078](../decisions/0078-transport-forecast-replication.md) A1-A7 (the scheme as revised by M41's measurement), [0079](../decisions/0079-transport-core-decisions.md) §9-§17 and M45/M46's Deviations (the tick is 0.86 ms with frames at 79 % of it; the tracker added 57 µs to a 19 µs advance in the spike; M46's `LineRoute` says which connections hold a line).

## Goal
Items reach the client as forecasts the host corrects only when wrong, in the revised scheme of 0078 A3: a line's **run list** is sent in full only when membership changes in a way the client cannot derive; its **motion state** (`front_stop`, the spawner's schedule and `paused` flag) is corrected by a small **state message** on a halt, a release, a change of the stop ahead, a spawner pause or resume, or a structure change; an item entering a held line from a line the connection does not hold arrives as an **arrival**; sink exits are predicted by the path's terminal `Sink`, spawner inserts by the schedule, hand-offs by the ownership rule. `advance` marks dirty lines by the front-item check and due ticks of A3; the host rebuilds each dirty held line's forecast and sends it in section `Forecasts` (13); the replica keeps one trajectory per item, answers `pos_at(line, item_index, render_t)` by the formula of 0078 §2 with stops derived as `front_stop + SPACING x k`, and runs no belt rule. An engine-level arbiter on hand worlds proves the message rules; M47b proves them on the spike's seven worlds through real frames.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (whole, with its Amendment A1-A7: A3's message rules 1-6 are the specification)
3. `docs/plan/41-forecast-spike.md` (Deviations and the three Extension blocks: the instrumented events, the tracker's segments and due ticks, the classifier, the follower; the tracker's reference code is `fixtures/belts/tests/common/forecast.rs` at commit `864cb3a8`, deleted by M45, read with `git show 864cb3a8:packages/engine/fixtures/belts/tests/common/forecast.rs`, never copied)
4. `docs/decisions/0079-transport-core-decisions.md` §17 (structures: `LineRoute`, the put budget, the forced snapshot, `lines_at` during deferral) and M46's Deviations
5. `docs/architecture/sync-and-netcode.md` ("Rates, subscriptions, bandwidth", "Scopes")
Rules that apply: `.claude/rules/determinism.md` (the tracker is host-only but runs inside the tick), `.claude/rules/hot-paths.md`, `.claude/rules/prediction.md`. Skills: `run-tests`, `profile-frame` (its method, for the host-side profile if the tracker's cost is over the criterion).

## Scope
- `transport/forecast.rs` (host): the tracker of M41's spike written as production code: per line the predicted stops as segments (a ring of `ceil(len / SPACING)` per line, reserved from `max_items`), the front-item check inside `advance` (one comparison per front item: if it moves as predicted every packed item behind it does), due ticks computed at landing in a due-ordered queue (the spike's end-of-tick scan over every line was half its cost), the dirty list (preallocated, cleared at `seal`), the cheap-forecast builder walking the path to the first jam, dead end or sink up to **8** lines, the classifier (a state message when every item's new stop is `front_stop + SPACING x k` for the line's `T - 1` list, else a full run list; A3 rules 1-6 as written), `forecast_version` per line, the spawner schedule (`rate256`, accumulator, cycling flag, next item) and `paused` flag through a `TransportWrite::set_spawner(line, Option<Schedule>)` the game calls when it configures a spawner (the engine does not run the spawner; it forecasts it; an insert the schedule did not predict is counted, `spawner_mismatches`).
- `advance` marks the events through M42's `touched` and `jam` hooks; the tracker's cost per tick is measured on `slow_tick_belts_large` (the criterion is 0078 A3's 1 ms added over M45's 0.88 ms; a profile if over; the baseline re-record is M47b's).
- `wire/forecast.rs`: section 13 with three record kinds, `RunList { line, runs: [item, count, pos, fork_side?], spawner? }`, `State { line, front_stop: Option<i32>, flags: paused | resumed }` and `Arrival { line, item, pos }` (an item entering a held line from a line the connection does not hold: per connection, A3 rule 6), the tick being the frame's; no `path` field (the client holds the structures and follows `Next`; `fork_side` per run only where the run's path crosses a fork within the horizon); allocation-free; the layout in `wire/CLAUDE.md`; a frame that cannot fit every dirty forecast keeps the rest dirty (0078 §7), the one-second resend rule; section 13 follows 12 in a frame.
- Host routing: per connection, the forecast of a dirty line goes to every connection holding the line's structure (M46's `LineRoute::sent`); arrivals are per connection (the connection does not hold the source line's structure); the first forecast of a newly held line rides the frame that puts its structure.
- Replica: `Transport::apply_forecast` keeps one trajectory per item under the ownership rule (A3), re-stops a line's `T - 1` items on a `State`, replays the spawner schedule and pauses it on the flag, places an `Arrival`; `pos_at(line, item_index, render_t) -> Option<(LineId, pos)>` following `Next` through the held structures; `items_in`/`count`/`front` on the replica answer from the trajectories at the replica's tick; counters `forecastsApplied`, `stateMessagesApplied`, `arrivalsApplied`, `forecastSeenLate` (applied for a tick the client has already rendered), `corrections` (the client-side count M47b turns into `transport.correctionsPerSec`).
- The engine-level arbiter: `forecast_client_matches_host` in `tests/main/` on a `Loopback` pair (`testing/testkit.rs`) over hand worlds (a packed chain into a toggled sink, a spawner-fed lane, a fork within the horizon, a merge from an unheld line, an inserter-like insert and remove, a surgery mid-flow), 300 ticks each, the replica's `items_in` equal to the host's on every held line every tick. The five follower cases of the spike are unit tests on the replica.

## Non-scope
- The `fx-belts` fixture, the netcode scenarios, the budget row, the baseline re-record (M47b); prediction, late join at scale, degrade levels, reconnect (M48); drawing (M49); the reference game's spawner UI (M53); the chain-level halt (M47b decides from the stress cell).

## Files, packages and crates touched
- `packages/engine/crates/engine/` (`transport/forecast.rs` new, `transport/{mod,advance,line,replicate}.rs`, `wire/forecast.rs` new, `wire/mod.rs`, `wire/CLAUDE.md`, `host/mod.rs`, `host/lines.rs`, `client/replica.rs`, `tests/no_alloc_wire.rs`, `tests/no_alloc_transport.rs`, `tests/no_alloc_connection.rs`, `tests/main/`).
- `packages/engine/src/test/` (`engine/test` `forecastCounters(client)`: the replica counters read back, for M47b's scenarios).
- Nothing under `fixtures/`, `tests/netcode/`, `budgets.json`, `baselines/` (M47b).

## Seams
**Provides:** `SectionId::Forecasts` (13), `wire::forecast::{RunList, State, Arrival}`, `Transport::{apply_forecast, pos_at, forecast_counters, set_spawner, Schedule}`, host tracker, dirty list, classifier and builder, `engine/test` `forecastCounters(client)`.
**Consumes:** M41's tracker design and follower semantics (0078 A3); M46's structures, `LineRoute` and routing (0079 §17); M45's baseline.

## Planning decisions
- **The engine forecasts the spawner the game runs.** `set_spawner(line, schedule)` tells the tracker the schedule the game's tick rule follows (0078 A3: `rate256`, accumulator phase, cycling, next item); the game keeps running its own spawner through `insert_back`; a mismatch between what the game does and what it declared is a correction the tracker sees as an unpredicted insert (counted: `spawner_mismatches`, expected 0 for `fx-belts` and the reference game). The client-side replay is the **(assumed)** line Tyler has not yet ruled on; if he refuses it, the fallback is a state message per insert (M41 measured 3.7 MB/s on a saturated viewport without it, so the fallback is a different spawner model, not "no forecast").
- **The due-ordered queue, not the scan.** M41's end-of-tick scan over every line was 93 of 168 µs; a binary heap keyed by due tick, reserved from `max_items`, makes the tick O(dirty).
- **Depth 8, no `path` field.** M41: depth 8 left no undecidable line; the client holds every structure it needs to follow `Next`, so the path travels only as `fork_side` where a fork decides within the horizon.
- **Arrivals are per connection** (0078 A6 (0)): the host's dirty tracking is per line; the arrival check is per connection in `build_frame` (an item crossed into a held line from a line this connection does not hold this tick: the host knows both from `LineRoute`).
- **A forecast rides with its structure.** The frame that puts a line's structure (enter, snapshot, resync) carries the line's current forecast too, so a client never holds a structure without a motion state; a deferred put defers its forecast with it (0079 §17 (c)).
- **The engine arbiter is on hand worlds** (the fixture's seven worlds are M47b's): the engine crate cannot depend on `fx-belts`, and one writer per crate.

## Order of work
1. `transport/forecast.rs` tracker (segments, due queue, dirty list, builder, classifier) against `Transport` with unit tests on hand worlds (the five follower cases as host-side expectations); `set_spawner`.
2. `wire/forecast.rs` and `wire/CLAUDE.md`; `no_alloc_wire`.
3. Host routing and per-connection arrivals; the replica's `apply_forecast`, `pos_at`, counters; `forecast_client_matches_host` on the hand worlds; `no_alloc_transport` and `no_alloc_connection` with the tracker inside the window.
4. The tracker's cost: `pnpm test:slow rust -t slow_tick_belts_large` three times at quiet load against the baseline (not re-recorded here), a profile if over 1 ms added.
5. Deviations (the tracker's cost, bytes per record kind, what moved), `docs/architecture/sync-and-netcode.md` one paragraph; commit.

## Tests added
Rust suite: `forecast_tracker_marks_events` (the event kinds on hand worlds), `forecast_classifier_state_vs_runlist`, `forecast_builder_depth_and_stops`, `forecast_spawner_schedule_predicts_inserts`, `wire_forecast_round_trip`, `wire_forecast_rejects_malformed`, `replica_follows_state_message` (the five cases), `replica_arrival_gets_stop`, `forecast_client_matches_host` (the hand-world arbiter), `no_alloc_wire`/`no_alloc_transport`/`no_alloc_connection` extended.

## Exit criteria
- [ ] `forecast_client_matches_host` passes on the hand worlds for 300 ticks with exact equality every tick, with an inject-fail-revert (a state message applied to items that landed during `T` reddens it, as the spike's did).
- [ ] The five follower cases pass on the replica; `forecast_classifier_state_vs_runlist` shows a jam forming yields a `State` and never a `RunList` for a packed line (inject-fail-revert).
- [ ] `slow_tick_belts_large` with the tracker on is within 1 ms of M45's baseline (0.88 ms), three runs recorded with load; or the cost is named with a profile and an optimisation step ran. The baseline stays M45's until M47b.
- [ ] `no_alloc_wire`, `no_alloc_transport` and `no_alloc_connection` cover the builder, the queue, the section and the routing.
- [ ] `pnpm test` and `pnpm lint` are green; no golden moved.

## Verification commands
`pnpm test rust -t forecast_` · `pnpm test rust -t wire_forecast` · `pnpm test rust -t replica_` · `pnpm test rust -t no_alloc` · `pnpm test:slow rust -t slow_tick_belts_large` · `pnpm test && pnpm lint`

## Budgets
- `belts-tick` (M45's baseline, limit 5 ms, 25 % rule: a tracker over 0.22 ms added trips it, which is the signal to profile); allocation per tick and per frame (`no_alloc_*`).

## Context artifacts
`wire/CLAUDE.md` (section 13); `docs/architecture/sync-and-netcode.md` (a "Transport forecasts" paragraph: what travels, when, and the client's rule); the crate `CLAUDE.md` layout line (`transport/forecast.rs`, `wire/forecast.rs`).

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
