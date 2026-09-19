# M34c: Reference game: scripted multiplayer in the netcode suite

Status: not started · After: 34b · Tyler-dependent: no

Split from M34 during planning (see that brief). M36, M37b and M37 list M34c under After.

## Goal
The netcode suite plays the whole reference game with several headless clients against the real server entrypoint over conditioned links, and pins every multiplayer coverage item `0003` Consequences leaves to scripted tests: the three rejection races, the subscription-edge `NotPredictable`, a furnace across a chunk border under partial subscription, plus late join, reconnect, the disconnect grace and the idle pause. Every multiplayer row of the Requirement matrix names a passing test.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§7 netcode harness; §4 demotion)
3. `docs/decisions/0003-game-facing-api.md` (Consequences: the coverage list)
4. `docs/decisions/0012-prediction-and-reconciliation.md` (Mechanism; `Unknown` reads; Correction without snapping)
Also: `docs/plan/reference-coverage.md`; the Seams of `docs/plan/27-server-entrypoint-and-netcode-harness.md`, `28-sessions-and-reconnect.md`, `28b-reconnect-and-lifecycle.md`.
Look up at the step: grace, `Bye`, `Full`, `BadKey`, idle lifecycle `0013`; arrival order and acks `0004`.
Rules that apply: `games/reference/CLAUDE.md`. Skill: `run-tests`.

## Scope
All tests live in `games/reference/tests/netcode/`, run by the netcode suite, use `createNetHarness` with the reference game's `buildGame` output, a fixed seed, the virtual clock, and M34b's `script.ts` headless driver. Default conditions: 60 ms latency, 20 ms jitter; each race also runs at 0 ms and at 250 ms.
- **Full game, two players:** A mines, crafts and places; B deposits into and takes from A's furnace; after `settle()` `assertConverged()` holds and both `Ui`s agree with the host.
- **Races** (each asserts the loser's `onActionResult`, the final host state, and "never a torn state": on every client frame the loser holds the item or the ghost, never both or neither):
  - last unit: B's `StartCollect` on a tile A's completion just emptied is predicted locally and rejected by the host;
  - same spot: two `PlaceFurnace` with overlapping footprints in one tick; arrival order wins; the loser's furnace item is back after the ack;
  - same ingots: two `FurnaceTake`; the second is rejected as empty (and was never predicted, per M33b).
- **Subscription edge:** a `PlaceFurnace` dispatched at an origin whose footprint touches an unsubscribed chunk reports `NotPredictable` at dispatch, is still sent, and is confirmed by the host; an action dispatched right after it follows the taint rule M25 settled.
- **Chunk border:** a furnace at a chunk corner; a client subscribed to exactly one of the four chunks receives it once, renders it, and its per-chunk hashes match the host's.
- **Late join:** C joins after the full game and sees depleted tiles, furnace contents, the roster and both colours.
- **Reconnect:** a drop shorter than the grace leaves the collect running and logs nothing; a drop longer than the grace logs `Disconnected` and cancels the collect, not the craft; a `PlaceFurnace` pending across the drop is applied exactly once; the returning client's presence seed equals its last sample.
- **Admission:** `max_players = 2` rejects a third client with `Full`; a wrong join key gets `BadKey`; neither appears in the log.
- **Idle pause:** both players leave; ticking stops after the last `Disconnected`; a fuelled furnace makes no progress until someone returns.
- **Counters:** over the full game at default conditions, bytes per client per tick and mispredictions per client stay under the ceilings in `budgets.json`.
- **Real sockets:** the two-player full game once over loopback `ws` (`transport: 'ws'`), tagged `slow` if the suite budget needs it.

## Non-scope
Eight-client soak and the standard large save (M36). Version-mismatch reload, `Superseded`, resync after host restart or panic: engine behaviour with fixture tests in M28, M28b, M29; the coverage file lists them as fixture-only. Browser two-page smoke (M34).

## Files, packages and crates touched
`games/reference/tests/netcode/` and `tests/helpers/`. No game code is expected to change; a rule bug found here is fixed in `sim/` with a native regression test beside it.

## Seams
**Provides:** `tests/helpers/net.ts::refHarness({ clients, seed, conditions?, world? })` returning the harness plus one `headlessDriver` per client; `tornStateProbe(client)` (per-frame invariant check used by the three races).
**Consumes:** `createNetHarness`, `HeadlessClient` (with `setCamera` and `ui()`), `conditionLink`, `VirtualClock`, `settle`, `assertConverged`, `counters` (M27); `secrets`, `joinKey`, `leave`, `connectRaw` (M28); `link(i).disconnect/reconnect`, `serverInternals(server).isTicking` (M28b); `transport: 'ws'` (M29); byte ceilings and per-chunk hashes (M31, M31b); `script.ts` (M34b); pending queue statuses incl. `NotPredictable` and the taint rule (M25).

## Planning decisions
- **Races are made deterministic by the virtual clock, not by sleeping.** Both actions are dispatched, then `advanceTo` releases them in the harness's total order; swapping link latencies swaps the winner, and each race asserts both orders.
- **The subscription edge is reached by a scripted dispatch**, because the UI cannot aim outside ring 1 (`0010`). That is exactly why `0003` lists it under "reached only by luck".
- **Partial subscription at a chunk corner** is set up with `setCamera` so the view's ring 1 ends on the chunk boundary; the test asserts the subscribed set first, so a change to `0010`'s rings fails loudly instead of silently weakening the test.
- **No new golden.** These tests assert convergence and invariants; the single-player golden of M34b already pins rule output. Failures print seed and scenario and dump the action log (`0020` §2).

## Order of work
1. `refHarness`, two-player full game, convergence.
2. `tornStateProbe`; the three races at three latencies.
3. Subscription edge; chunk border.
4. Late join; reconnect cases; admission; idle pause.
5. Counters against `budgets.json`; `ws` repeat.
6. Fill the matrix column in `reference-coverage.md`.

## Tests added
Netcode: `reference_full_game_two_players`, `reference_race_last_unit`, `reference_race_same_spot`, `reference_race_same_ingots`, `reference_subscription_edge_not_predictable`, `reference_furnace_across_chunk_border`, `reference_late_join_sees_world`, `reference_short_drop_keeps_collect`, `reference_long_drop_cancels_collect_keeps_craft`, `reference_pending_place_applied_once_after_reconnect`, `reference_full_and_bad_key_rejected`, `reference_idle_world_pauses`, `reference_bytes_and_mispredictions_in_budget`, `reference_full_game_two_players_ws`.

## Exit criteria
- [ ] All tests above pass by name, each reproducible from its printed seed.
- [ ] Every multiplayer row of the Requirement matrix and every "scripted" row of the engine-feature table in `docs/plan/reference-coverage.md` names a test that exists.
- [ ] The netcode suite stays inside its budget (`0020` §3); demotions follow §4 and are listed under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t reference_` · `pnpm test netcode -t reference_race` · `pnpm test`.

## Budgets
Bandwidth per client, steady and burst (`PRE-PLAN.md` §7), measured by `reference_bytes_and_mispredictions_in_budget` from `counters(i)`; netcode suite time from the `pnpm test` summary line.

## Context artifacts
`games/reference/CLAUDE.md`: how to write a netcode scenario with `refHarness`. If this is the third milestone to hand-write the same scenario boilerplate, note it for `0021` §5; do not add an agent.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
