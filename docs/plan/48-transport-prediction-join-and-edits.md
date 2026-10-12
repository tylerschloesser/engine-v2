# M48: Prediction, late join and edits under replication

Status: not started · After: 47b · Tyler-dependent: no (a changed default view would be his: asked only if the join measurement needs it)

Filled in to the full template on 2026-10-12 from [0078](../decisions/0078-transport-forecast-replication.md) §6-§7 and Consequences, [0076](../decisions/0076-transport-lines-engine-game-split.md) §6, [0079](../decisions/0079-transport-core-decisions.md) §4, and M45's Deviations (3,810 lines, 1.39 MB of transport state at the stated scale).

## Goal
The replication of lines is complete and robust: a predicted placement never touches a line (`Unknown` under `Predicting`, pinned end to end through a fixture page), edits during flow (cut, join, extend, destroy, speed change) replicate consistently with forecasts (a structure put and the line's forecast arrive together), late join at the stated scale is measured through the chunk bucket, degrade levels and frame overflow follow 0078 §7, and a reconnect with a resume hint keeps held structures. Phase end: tag `belts-replicated`.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (§6, §7, A5, Consequences: the late-join cost)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§6) and `docs/decisions/0079-transport-core-decisions.md` (§4: the phase flag; `lines_at` is `Unknown` on an unreserved store)
4. `docs/architecture/sync-and-netcode.md` ("Prediction and reconciliation", "Sessions": the resume hint; "Rates": degrade and the chunk bucket)
Rules that apply: `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests`, `gc-test` (if a page is added).

## Scope
- Prediction: `fx-belts` through the loopback harness (`fixtures/predict`'s pattern): an action whose `apply` reads `lines_at` or writes `transport_mut()` is `NotPredictable` and still sent; the host applies it (as a request) and the line appears with its forecast; a `Request` entity spawned by a predicted action renders `PREDICTED` and disappears at the ack. `belts/predicted_request_is_not_predictable` (netcode) and `transport_predicting_reads_are_unknown` (rust: every `TransportRead` method on a `Predicting` over a replica that holds the line still taints: the replica's structure is authoritative but the overlay must not read it as a predicted fact? Decision below).
- Edit consistency: `belts/edit_during_flow_converges`: cut, join, extend, destroy, speed change while saturated, hash-all on structures, and after each edit the replica's `pos_at` equals the host's positions within one frame (the forecast of the edited lines arrives in the same frame as their structure puts: `build_frame` orders section 12 before 13 and the dirty list includes every line a surgery touched).
- Late join: `belts/join_at_scale` on M45's world (`BeltsParams.bench`, the recommended caps): a client joins with a 144-chunk view at the world's densest spot; measure bytes and virtual seconds until every structure and forecast of the view is held, through the 48 KB/s chunk bucket; record in Deviations and 0078's Consequences. If over 10 s: a compact structure encoding (varint fields, segment deltas) is built here; a smaller default view is Tyler's (`docs/architecture/README.md` quotes the default; ask with the measured number).
- Degrade: a client degraded to every 2nd and 4th tick receives the latest forecast of each dirty line and misses nothing (`belts/degraded_client_follows`: `pos_at` equal to the host's at every frame it receives); frame overflow keeps forecasts dirty (`belts/overflow_keeps_dirty`: a `SliceSink` too small for one tick's forecasts delivers them over the next frames, none lost); the one-second resend fires (`belts/stale_forecast_resent`). Sections 12 and 13 under production chunk pacing: M47b's bytes row lifts the caps because the fixture's spawner entities write a chunk delta per insert (0079 §19 (e)); measure the `SaturatedView` (20 %, 100) cell with the default caps (`belts/saturated_view_paced_bytes`, recorded in the row's source: what degrade and chunk collapses add to sections 12 and 13, and whether a collapse re-puts lists).
- Pre-existing version drift (found in M46's review, 2026-10-12): an entity spawned and despawned in the same tick bumps the host's chunk version (`host/mod.rs`, the chunk-scoped change stamp) but not the replica's (which bumps only on an applied delta), so `assertConverged`'s region hash differs while the chunk hashes agree and a resume hint's `ChunkKeeps` over-sends such a chunk. Fix it here (the host stamps only chunks whose frame carried a delta, or the replica mirrors the stamp), add `region_hash_agrees_after_same_tick_spawn_despawn`, and remove the `O = 200` workaround in `tests/netcode/belts.test.ts`.
- Reconnect: `belts/reconnect_keeps_structures`: a resume hint with equal versions gives `ChunkKeeps` and the structures are not resent; the forecasts are resent in full on reconnect (the client's trajectories are stale by the gap); `forecastSeenLate` stays 0 after the resync.
- A fixture page `tests/browser/pages/belts-predict.html` only if the loopback harness cannot show the `PREDICTED` entity; else the netcode scenario reads the overlay through `engine/test`.
- Spawner declarations after a restore (found in M47's review, 2026-10-12): a `set_spawner` schedule lives in the host's tracker only (derived, never encoded), so a restored or restarted host has none until the game declares again, and every spawner insert is an `Arrival` meanwhile. Decide and build the hook (a `Game` callback after restore that re-declares with the right `acc` phase, or a tracker rebuild from a game-provided iterator); `belts/restore_keeps_spawner_schedules`: after a save and restore of M45's world, `spawner_mismatches` 0 and no arrival for a declared spawner within 20 ticks.
- Lost frames and the chunk store (found in M47's `no_alloc_connection` attribution, 2026-10-12; both pre-existing, both reproduce on a world with no line): (a) every lossy window (a frame lost every 32 ticks into a 64 B buffer on the wide band) raises client chunk-hash desyncs (2-16 per window; lossless windows none): likely the overflow give-back returns the entering chunks but never re-sends a held chunk's `ChunkDeltas` from the lost frame; trace it, fix it, pin it (`lost_frame_never_desyncs_a_held_chunk`); (b) `Pacing::take_bundle` (`host/pacing.rs`) panics when `out` is smaller than the first held frame ("range end index 1744 out of range for slice of length 64"): production passes one buffer size, so make it an error or a documented precondition with a test. The client's chunk store moves 48-528 B over a lossy window (`BTreeMap` nodes in `ChunkReplica::held`, overlay `Vec` capacities) and settles to 0 B after two lossless round trips: a state shift, not a leak; the host allocates 0 B throughout.

## Non-scope
- Drawing items (M49); the reference game's actions (M51); phone measurements (M57); position-window culling (0078 A6 (ii): not needed by M41's numbers; if the join measurement contradicts that, a planning decision here names it for M57).

## Files, packages and crates touched
- `packages/engine/crates/engine/` (`host/mod.rs` for degrade and overflow with forecasts, `host/pacing.rs` if the bucket needs a forecast class, `session/resume.rs` if the hint carries line versions (decision below), `tests/main/`).
- `packages/engine/tests/netcode/` (the scenarios), `packages/engine/src/test/` (helpers).
- `packages/engine/fixtures/belts/` (an action that reads `lines_at` in `apply`, for the prediction test).

## Seams
**Provides:** the netcode scenarios above (M56 reuses `edit_during_flow`), the join measurement, tag `belts-replicated`.
**Consumes:** M46 structures and `last_sent`, M47 forecasts and counters, `fixtures/predict`'s loopback patterns, the resume hint (0013), M45's world.

## Planning decisions
- **A predicted read of a held structure is `Unknown` too.** `Predicting` returns `Unknown` for every `TransportRead` method, not only on an unreserved store: a predicted placement that depends on which line is under a tile would otherwise predict against a structure the host may have changed in the same tick (0076 §6: topology is the host's). A game validates belt placement by tile traits, which the overlay does hold.
- **The resume hint carries no line versions.** Structures are keyed by chunk (anchor) and the hint's chunk versions already decide `ChunkKeeps`; a kept chunk keeps its anchored structures. Forecasts are resent whole on reconnect: cheap (one `State` or `RunList` per visible line, once) and simpler than a second hint.
- **Degrade sends the latest state** (0078 §7): a forecast is an idempotent whole value; a degraded client's `pos_at` evaluates the same formula from the latest message, so missing frames lose nothing the next message does not restate.
- **The join cost is measured before any encoding work.** M45 put the transport state at 5.3 B per item for the full store; structures and forecasts for a 144-chunk view are a few hundred kilobytes at most at the 48 KB/s bucket: expected under 10 s; the compact encoding is built only on a measured miss.

## Order of work
1. Prediction: the `Unknown` rule for `Predicting`, the fixture action, the netcode scenario.
2. Edit consistency (sections 12 before 13; surgery lines in the dirty list); `belts/edit_during_flow_converges`.
3. Degrade, overflow, the one-second resend; their scenarios.
4. Reconnect; `belts/reconnect_keeps_structures`.
5. The join measurement on M45's world; the decision if over 10 s.
6. Deviations, `docs/architecture/sync-and-netcode.md` (prediction and reconnect sentences), `pnpm test:slow netcode`, tag `belts-replicated`, commit.

## Tests added
Rust suite: `transport_predicting_reads_are_unknown`, `build_frame_orders_structures_before_forecasts`, `surgery_marks_forecast_dirty`. Netcode: `belts/predicted_request_is_not_predictable`, `belts/edit_during_flow_converges`, `belts/degraded_client_follows`, `belts/overflow_keeps_dirty`, `belts/stale_forecast_resent`, `belts/reconnect_keeps_structures`, `belts/join_at_scale @slow`.

## Exit criteria
- [ ] Every scenario above passes with an inject-fail-revert recorded (a `Predicting` read answering `Ok` reddens the prediction test; section 13 written before 12 reddens edit consistency; a forecast dropped on overflow reddens `overflow_keeps_dirty`).
- [ ] `belts/join_at_scale` numbers (bytes, virtual seconds to a held view) are in Deviations and 0078's Consequences; a decision is recorded if over 10 s.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow netcode` are green; tag `belts-replicated` on the pushed commit.

## Verification commands
`pnpm test netcode -t belts` · `pnpm test:slow netcode -t join_at_scale` · `pnpm test rust -t transport_predicting` · `pnpm test && pnpm lint && pnpm test:slow netcode`

## Budgets
- The 48 KB/s chunk bucket and the 10 s join criterion (0078 Consequences); `transport.downBytesPerSec` unchanged (M47's row holds).

## Context artifacts
`docs/architecture/sync-and-netcode.md` ("Prediction and reconciliation": a sentence on transport reads; "Sessions": forecasts on reconnect); `packages/engine/tests/netcode/CLAUDE.md`.

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
