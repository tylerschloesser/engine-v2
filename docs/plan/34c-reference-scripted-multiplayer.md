# M34c: Reference game: scripted multiplayer in the netcode suite

Status: not started · After: 34d · Tyler-dependent: no

Split from M34 during planning (see that brief). M36, M37b and M37 list M34c under After.

## Goal
The netcode suite plays the whole reference game with several headless clients against the real server entrypoint over conditioned links, and pins every multiplayer coverage item `0003` Consequences leaves to scripted tests: the three rejection races, the subscription-edge `NotPredictable`, a furnace across a chunk border under partial subscription, plus late join, reconnect, the disconnect grace and the idle pause. Every multiplayer row of the Requirement matrix names a passing test.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§7 netcode harness; §4 demotion)
3. `docs/decisions/0003-game-facing-api.md` (Consequences: the coverage list)
4. `docs/decisions/0012-prediction-and-reconciliation.md` (Mechanism; `Unknown` reads; Correction without snapping)
Also: `docs/plan/reference-coverage.md`, the `reference-game.md` table of `docs/plan/coverage.md`; the Seams of `docs/plan/27-server-entrypoint-and-netcode-harness.md`, `28-sessions-and-reconnect.md`, `28b-reconnect-and-lifecycle.md`.
Look up at the step: grace, `Bye`, `Full`, `BadKey`, idle lifecycle `0013`; arrival order and acks `0004`.
Rules that apply: `games/reference/CLAUDE.md`. Skill: `run-tests`.

## Scope
All tests live in `games/reference/tests/netcode/`, run by the netcode suite, use `createNetHarness` with the reference game's `buildGame` output, a fixed seed, the virtual clock, and M34b's `script.ts` headless driver. Default conditions: 60 ms latency, 20 ms jitter; each race also runs at 0 ms and at 250 ms.
- **Full game, two players:** A mines, crafts and places, and opens the furnace panel; B picks A's still-empty furnace up (any player may: A's frame carries `EntityGone`, A's panel closes, the furnace item is B's) and places it again; A deposits into and takes from the furnace B placed; after `settle()` `assertConverged()` holds and both `Ui`s agree with the host.
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
- **Counters:** over the full game at default conditions, bytes per client per tick and mispredictions per client stay under the ceilings in `budgets.json`; the session's downlink bytes per client, scaled from its ticks to one hour of play, stay under the ceiling `net.bytesPerHour` (source: `PRE-PLAN.md` §7 bandwidth burst row, megabytes per hour of play; owner 0010).
- **Real sockets:** the two-player full game once over loopback `ws` (`transport: 'ws'`), tagged `slow` if the suite budget needs it.

## Non-scope
Eight-client soak and the standard large save (M36). Version-mismatch reload, `Superseded`, resync after host restart or panic: engine behaviour with fixture tests in M28, M28b, M29; the coverage file lists them as fixture-only. Browser two-page smoke (M34).

## Files, packages and crates touched
`games/reference/tests/netcode/` and `tests/helpers/`. No game code is expected to change; a rule bug found here is fixed in `sim/` with a native regression test beside it.

## Seams
**Provides:** `tests/helpers/net.ts::refHarness({ clients, seed, conditions?, world? })` returning the harness plus one `headlessDriver` per client; `tornStateProbe(client)` (per-frame invariant check used by the three races).
**Consumes:** `createNetHarness`, `HeadlessClient` (with `setCamera` and `ui()`), `conditionLink`, `VirtualClock`, `settle`, `assertConverged`, `counters` (M27); `secrets`, `joinKey`, `leave`, `connectRaw` (M28); `link(i).disconnect/reconnect`, `serverInternals(server).isTicking` (M28b); `transport: 'ws'` (M29); byte ceilings and per-chunk hashes (M31, M31b); `script.ts` (M34b); pending queue statuses incl. `NotPredictable` and the taint rule (M25).
**From M34d (orchestrator):** a straddling entity no longer desyncs replica chunk versions (M34d); scripted races may place furnaces across chunk boundaries and should include one.
**From M34 (orchestrator):** the netcode harness takes a numeric seed, so `games/reference/world.json`'s seed (a string above 2^53) cannot be used: M34's netcode tests run on the harness seed (3401, 3402) with worldgen `{}` from `world.json`, dev build via `gameCrateBuildDir('reference')`; decide whether these scripted scenarios need the declared world (deferred ledger). The roster online bit is written by `Sim::step` (`Authority::put_roster`, M34 step 3b), so a late joiner's roster and `Ui.roster[].online` are real; `Ui.roster[]` is `{ id, online, colour: [r,g,b], me }` and `RefGlobal { colours }` (alias `GlobalState`) holds 1-based `PALETTE` indices. The host's detach presence reaches `Welcome.presence` (`sim_detach` returns it, `ABI_VERSION` 38, `detachKeepingPresence` in `server.ts`); the session-supersede path has no test: the reconnect scenario here owns it, and the engine half's only test is the browser `reference_returning_player_resumes`.
**From M34b (orchestrator):** `headlessDriver(client, advance)` needs the harness's `advanceTicks` (`refHarness` must pass `h.advanceTicks` to each driver; `results: Map<seq, outcome>`, ignore the dispatch-time `'NotPredictable'`). `world.json`'s string seed goes in `NetHarnessOptions.worldSeed` (`seed` stays the conditioner seed). A refused action changes the state hash (its ack is state), so hash-compared runs (vs `full-game.json`, or client A vs B) must dispatch the same actions, refused ones included. `FURNACE_A = (-4, 1)` and `FURNACE_B = (-4, 3)` are single-chunk origins; M34d fixes straddling first. `fullGame()` is 27 steps and ends quiescent; `tests/golden/full-game.{log,json}` are single-player (`players: 1`), so a two-player golden is new. Hash checks through `domDriver` use `window.__worldHash()`.

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
6. Fill the test columns: the `reference-game.md` table of `coverage.md` and the engine-feature table of `reference-coverage.md`.

## Tests added
Netcode: `reference_full_game_two_players`, `reference_race_last_unit`, `reference_race_same_spot`, `reference_race_same_ingots`, `reference_subscription_edge_not_predictable`, `reference_furnace_across_chunk_border`, `reference_late_join_sees_world`, `reference_short_drop_keeps_collect`, `reference_long_drop_cancels_collect_keeps_craft`, `reference_pending_place_applied_once_after_reconnect`, `reference_full_and_bad_key_rejected`, `reference_idle_world_pauses`, `reference_bytes_and_mispredictions_in_budget` (also asserts the projected `net.bytesPerHour` ceiling), `reference_full_game_two_players_ws`.

## Exit criteria
- [ ] All tests above pass by name, each reproducible from its printed seed.
- [ ] Every multiplayer row of the Requirement matrix (the `reference-game.md` table of `docs/plan/coverage.md`) and every "scripted" row of the engine-feature table in `docs/plan/reference-coverage.md` names a test that exists.
- [ ] The netcode suite stays inside its budget (`0020` §3); demotions follow §4 and are listed under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test netcode -t reference_` · `pnpm test netcode -t reference_race` · `pnpm test`.

## Budgets
Bandwidth per client, steady and burst, including megabytes per hour of play as a projection (`PRE-PLAN.md` §7), measured by `reference_bytes_and_mispredictions_in_budget` from `counters(i)`; netcode suite time from the `pnpm test` summary line.

## Context artifacts
`games/reference/CLAUDE.md`: how to write a netcode scenario with `refHarness`. If this is the third milestone to hand-write the same scenario boilerplate, note it for `0021` §5 in your report; do not add an agent (the only custom agent is the one of `0025` §2, and another needs a new ADR).

## Manual device checks
None.

## Deviations
(Steps 1-3 by one implementer, commits `M34c step 1..3`, base `594ebfd`; steps 4-6 not started.)

**Placement and seams.** Tests live in `games/reference/tests/netcode/{two-players,races,subscription}.test.ts`; `vitest.config.ts`'s `netcode` project gained the include `games/reference/tests/netcode/**/*.test.ts`. Helpers: `games/reference/tests/helpers/net.ts` exports `refHarness({ clients, seed, conditions?, world?, transport?, hashAll?, joinKey?, cameras? })` -> `{ h, drivers, seed, dispose }` (`world.json`'s seed and worldgen, dev build, each driver on `h.advanceTicks`, 20 ticks run so each client holds a `Ui`; `cameras` sets each client's camera from its first frame, otherwise a client holds the 4 x 4 chunks around the origin), `uiOf(h, i)`, `tornStateProbe(client, also?)` -> `{ trackPlace(seq), check(), frames, ghostFrames, verdicts }`, `advanceProbed(h, probes, n)` (one tick at a time, every probe after each: one client frame per tick in the harness), `PREDICTED` (`1 << 2`). `net.ts` imports the harness from `'engine/test'` (dist): importing `packages/engine/src` made the reference package's `tsc` fail on the WebGPU types. New engine seam: `HeadlessClient.draws(): DrawRecord[]` (`src/test/headless-client.ts`, reads `drawlist_len` and `RegionId.DrawList`); the headless client had no way to see a ghost.

**Real behaviour that differs from the brief (decisions needed).**
1. *Torn state.* `RefClient::ui` reads the raw replica (`view.world()`), not the overlay: `Ui.inventory` and `can_build` keep the furnace item until the host's ack, while the ghost (a `PREDICTED` sprite) shows from dispatch. So "holds the item or the ghost, never both or neither" cannot hold literally (item and ghost coexist through the whole wait). `tornStateProbe` checks what this game can promise, per frame: (a) once a placement is tracked, item count 0 with no furnace sprite drawn; (b) item count moved before the verdict; (c) one frame after a verdict, a ghost still drawn, or the item not spent (confirmed) / not at its old count (refused). Whether `ui()` should show the predicted inventory is the orchestrator's call.
2. *One-frame "neither" after a tainted confirm (found by the probe, left in the tree as a finding).* Placement declined at the subscription edge, then a valid placement behind it: the next frame's replay taints the second (its ghost goes), and on the frame both are acked the item is spent (`Ui`) but no sprite is drawn yet (the real sprite follows one frame later). Seen at 60 and 250 ms; `reference_subscription_edge_not_predictable` does not use the probe for this reason (it would fail). Not fixed (game/engine code is out of scope).
3. *Taint at dispatch.* Only the declined action gets the `NotPredictable` record: `ClientCore::on_action` predicts the new action without the taint, so a later action is predicted at dispatch (its ghost shows) and the taint applies when the next frame replays the queue. An idle world sends no frame, so the taint is invisible until one arrives; the test makes one arrive (another player's iron collect completes in view) and asserts the ghost goes at that replay and stays away until the verdict, against a control run without the edge action whose ghost stays until the verdict. Both runs at 60 and 250 ms.
4. *Chunk border.* "A client subscribed to exactly one of the four chunks ... renders it" is impossible: a view that shows a tile of the furnace holds that chunk's neighbours (ring 1), so all four. The test holds exactly one (view chunk (-3,-2), ring 1 = 3 x 3, `heldChunks` 9), asserts its replica changed in exactly one frame, hash-all reported no desync and chunk hashes were sent, `chunkHash(-2,-1)` equals the all-four client's, and that client D (holds 4 x 4) draws exactly one real sprite while C draws none. Rendering on C is not asserted.
5. *Collect prediction is not observable.* `Ui.collecting` is the raw replica too. "Predicted locally" in `reference_race_last_unit` = the client never reported `NotPredictable` for it (its only results are the one `Rejected NoResource`).
6. *`chunkHash` is not a subscription reader* (it is non-null for any locally generated chunk). The subscribed set is asserted through the host's `counters(i).heldChunks` (16 for a 20-tile view, 12 and 9 as in the tests; `chunkEnters - chunkLeaves` miscounts: a modified chunk enters as a snapshot, not a coordinate).
7. *`openFurnace` is client-local* (`RefClient.open`), so headlessly "A's panel closes" cannot be asserted; the two-player test asserts A's frame lost the furnace sprite and `Ui.furnace` is `null`.

**Numbers and choices.** Races run 0, 60, 250 ms (jitter `min(20, latency / 3)`) x both winners in one test each; the loser's link is 100 ms slower; at equal latency nothing decides it, so every race has a slower link. `last_unit`: the second player dispatches on host tick `done_at - 1` of the first's last collect (asserted); works at all three latencies. `same_ingots`: two ingots, the winner gets both, a third take is refused (host furnace empty). Corner origin `(-33,-1)`, edge origin `(-65,-5)`, both land found by scanning and hardcoded (a worldgen change fails the `Confirmed` assertion). Netcode suite: 103 tests, 2.2 s of 10 s (97 + 6, local); `pnpm test netcode -t reference_` 1.9 s. Six repeats of the six new tests all passed.

**Inject-fail-revert (all reverted).** `two-players`: expected A's frame after the pick-up to contain a sprite: red ("expected [] to deeply equal [ {} ]"). `same_spot` winner's link slowed instead of the loser's: red ("expected { Rejected: { Game: 'NotBuildable' } } to be 'Confirmed'"); probe's sprite filter made to match nothing: red at client frame 3 ("the item is gone and no furnace is drawn"), so the probe runs on every frame. `last_unit`: second dispatch at `done_at - 4`: red ("the loser's Ui shows {\"tile\":...,\"done_at\":597}"). `same_ingots`: winner's link slowed: red ("the loser holds 2 ingots"). `edge`: edge origin made predictable ((-4,3)): red ("... edge: [[13,\"Confirmed\"],[14,\"Confirmed\"]]: expected [] to deeply equal [ [ 13, 'NotPredictable' ] ]"). `chunk_border`: corner origin made single-chunk: red ("C's replica changed once: expected +0 to be 1").
