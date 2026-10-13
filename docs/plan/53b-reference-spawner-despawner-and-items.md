# M53b: Reference game: spawner, despawner and items on screen (**Playable**)

Status: done (2026-10-12) · After: 52, 53 · Tyler-dependent: no (his Spawner line built as written; question 9 (0078 A12's lead) judged here on a device)

Split from the M53 sketch on 2026-10-12 (the manager's survey `m53-research.md`): M53 made the schedule engine state, so the reference spawner is one `set_spawner` per configuration and nothing per insert.

## Goal
Items flow on the reference page: a spawner belt's lanes carry the engine schedule for their configured item and rate (set by `SetSpawner`, re-applied by M52's topology whenever a spawner's line is re-created), a despawner's lines end in `Sink`, the belt popover gains the spawner panel, items draw through `transport::draw_items` with the game's item style on the item clock, the full-game golden gains a spawner/despawner passage, two clients converge on items, and the tag `belts-playable` marks the commit; Tyler judges 0078 A12's lead on a device (`M53-item-lead`).

## Read first
1. `games/reference/README.md` ("Belts": Spawner and despawner, Art, Motion on the client, Spawner forecast on the client), `games/reference/CLAUDE.md`
2. `docs/decisions/0079-transport-core-decisions.md` §21 (the schedule as state), `docs/decisions/0078-transport-forecast-replication.md` A3, A12
3. `docs/plan/53-engine-scheduled-inserts.md` and `52-reference-belt-topology.md` Deviations (what exists: `set_spawner` semantics, `Err::Scheduled`, surgery carrying the schedule; the topology's lines per lane, `Sink` for despawners, `Belt.spawn`)
4. `games/reference/sim/src/{lib.rs, client.rs, rules/belts/topology.rs}`, `games/reference/src/ui/belt.ts`, `tests/helpers/script.ts`, `packages/engine/crates/engine/src/transport/draw.rs` (`ItemStyle`), `games/reference/tests/browser/draws.spec.ts` (pixel readback), `.claude/skills/device-check/SKILL.md`.
Rules: `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md` (`client.rs`), `.claude/rules/determinism.md`. Skills: `add-action-type`, `device-check`, `run-tests`.

## Scope
- **`SetSpawner { at, lane, item: u8, rate: u8 }`** (appended last; a predicted single put of `Belt.spawn[lane] = Some(SpawnCfg { item, rate })`; `rate` indexes `content::SPAWN_RATES` = periods `[5120, 2560, 1280, 683]` (1, 2, 4, 7.5 items/s per lane; the last is saturation); rejects `NoBeltHere`, `NotASpawner`, `BadItem`, `BadLane`; `Growth::NONE`); `SCHEMA_VERSION` 9 (10 under `test-hooks`). The topology (`on_wake`) applies `set_spawner(lane line, Schedule { period, acc: 0, kinds: 0, next: item + 1, paused: false })` for a spawner tile's configured lanes whenever the tile's lines are (re)created or its config changes, and `None` when a lane is unconfigured or the tile stops being a spawner; a spawner tile accepts no input from behind (its back is the line's back; recorded as the game's rule); a despawner's lines end in `Sink` (M52). No `declare_spawners` (0079 §21).
- **Panel.** `UiBelt` gains `spawn: [Option<UiSpawn { item, rate }>; 2]`; `src/ui/belt.ts` shows, for a spawner, per lane an item picker (the six items as buttons) and a rate picker (four buttons), dispatching `SetSpawner`; buttons only (no text input: M51b's `R` note); the furnace panel's conventions.
- **Items drawn.** `RefClient::extract` calls `draw_items(view, &ITEM_STYLE, out)` after the belts: `content::ITEM_STYLE` with sprite `SPRITE_ITEM_FIRST + item - 1`, a layer above the belts and below the player (say which: renumber if needed), colour white, `min_px_per_tile` 20 (M50's finding); the gc reference page primes a spawner, a 6-tile run and a despawner so items move in its window (`tilesAcross` 20 gives 64 px a tile on 1280: above the cutoff); its rows re-measured (JS bytes should not move).
- **Tests.** Rust: `spawner_sets_the_engine_schedule` (configure → the lane line's schedule; unconfigure → none; a re-created line gets it again; the other lane untouched), `despawner_sinks_and_counts` (`sunk` grows), `set_spawner_rules` (rejects), `spawner_writes_nothing_per_insert` (600 ticks: no entity put from the spawner tile: the §19 (e) pin). Browser: `reference_belt_panel` (configure item and rate through the popover; `Ui.belt.spawn` reflects it), `reference_belt_items_flow` (items appear on the run and vanish at the despawner: `__draws` counts of item sprites and a pixel readback of one item square against a belt-only pixel). Netcode: `reference_belt_items_converge` (two clients, a spawner feeding a despawner over 200 ticks; items equal on both replicas at matching ticks via `lineItems`; `forecastCounters` corrections pinned). Golden: `fullGame()` gains the deterministic passage (a spawner fills a dead-ended run; pick the spawner up; a despawner drains it: `sunk` equals the count), `golden:record` once with the diff stated; moved budget rows re-pinned with derivations.
- **Device check row** `M53-item-lead` (`device-check` skill format) and the manual check run by the manager with Tyler's devices under the memory rules (not during his round; the Pixel never slept): a spawner and a despawner watched from the phone; pass = Tyler accepts items appearing and vanishing about 200 ms before the entity motion; fail = write M49b.
- Docs: `games/reference/README.md` "Not implemented" (belts playable; splitters and undergrounds remain), `CLAUDE.md`, `docs/architecture/README.md` if it lists the reference game's features; the tag `belts-playable` on the pushed commit.

## Non-scope
Splitters (M54), undergrounds (M55), M49b (conditional), a sunk counter in the UI (a replica cannot read `sunk`).

## Files touched
`games/reference/sim/src/{lib.rs, content.rs, client.rs, rules/belts/topology.rs, rules/belt.rs}`, `sim/tests/{spawner.rs (new), topology*.rs}`, `src/ui/belt.ts`, `src/gc-entry.ts`, `src/test-entry.ts`, `tests/helpers/{game,script}.ts`, `tests/browser/belt-items.spec.ts` (new), `tests/netcode/belt-items.test.ts` (new), `tests/golden/full-game.{log,json}`, `src/bindings/*.ts`, `README.md`, `CLAUDE.md`, `packages/engine/budgets.json` (re-pins with derivations), `.claude/skills/device-check/SKILL.md` (the row).

## Exit criteria
- [x] The Rust, browser and netcode tests above pass with an inject-fail-revert each; `spawner_writes_nothing_per_insert` holds.
- [x] The golden has the passage (reviewed diff); `gc-reference*` rows green with items moving (re-measured; main 234 → 236 by the formula).
- [x] `pnpm test`, `pnpm lint`, `pnpm test:slow browser -t reference_` green; `belts-tick` within noise of its M53 baseline.
- [x] `M53-item-lead` written; no phone was on USB at the gate, so the row is left for Tyler's next round with the default "accept" (M49b if he rejects).
- [x] Tag `belts-playable` on the pushed commit.

## Verification commands
`cargo nextest run -E 'package(reference-sim)'` · `pnpm test rust -t spawner` · `pnpm test browser -t reference_belt` · `pnpm test netcode -t reference_belt` · `pnpm test browser -t gc-reference` · `pnpm test wasm -t reference` · `pnpm test && pnpm lint`

## Budgets
`SCHEMA_VERSION` 8 → 9; the action-log and downlink rows if the passage moves them; `gc.pages.reference*` unchanged in JS bytes.

## Deviations
(filled in during execution)

**Implementer, 2026-10-12.**
- **Built.** `RefAction::SetSpawner` (after `PickUpBelt`, before the `test-hooks` action, which stays last), `rules::belt::set_spawner`, `RefReject::{NotASpawner, BadLane, BadRate}`, `UiSpawn` and `UiBelt.spawn`, `content::{SPAWN_RATES, SPAWN_OFF, LAYER_ITEM, ITEM_MIN_PX_PER_TILE, ITEM_STYLE}`, `SCHEMA_VERSION` 9 (10 under `test-hooks`); in `topology.rs` kind-aware `inputs_of`/`shape_of_kind`, `Link::Sink`, the join flags, `schedule_for` and a sixth phase `schedule`; `RefClient::extract` calls `draw_items` after the ghost, before the players; the spawner panel in `src/ui/belt.ts`; `__dispatchSetSpawner`, `setSpawner`/`itemDraws`/`SPAWN_RATE`, the script step `setSpawner` on both drivers; `gc-entry.ts` primes a spawner, a six-tile run and a despawner at row -3.
- **Game rules (recorded in `topology.rs`'s module doc and `games/reference/CLAUDE.md`; README untouched but for "Not implemented").** A spawner accepts no input at all, not only from behind: it stays straight (its sprite is straight; a curved spawner would have a curve line pair with inserts competing with a feeder) and a belt pointing into it, from behind or a side, dead-ends. It joins no run either way (its own pair, linked by its output: M52 fix round 2's note). A despawner feeds nothing (it is no input of the tile in front), its lines end in `Sink`, and it never joins the run in front; it takes inputs, curves and side-loads like a plain belt.
- **`Belt.spawn_set`** (the lane bit of the last `SetSpawner`). `TransportRead` has no schedule reader, so the tick cannot tell which lane a configuration changed; re-setting both would reset the other lane's credit. The tick sets both lanes when the tile's lines were (re)created (their ids differ from before the phases), else the lanes in `spawn_set`. A rotation re-creates the lines, so its schedules restart at `acc` 0.
- **`SetSpawner` details.** `item == SPAWN_OFF` (255) clears a lane (the plan's `item: u8` had no "off"); `BadRate` added (a rate past `SPAWN_RATES`; the plan named four rejects); an unchanged configuration is `Ok` with no write. `SpawnCfg.rate` is now `u8` (a rate index). The panel's item tap on an unset lane gives the saturation rate, so one tap runs a lane.
- **Items layer 1** (the player's), drawn before the player circles (the layer sort is stable): no renumbering, and the extract goldens did not move.
- **Viewports.** The stepped test pages' canvas is the default 300 x 150 px, so `tilesAcross` 20 is 15 px a tile and `draw_items` draws nothing. `gc-entry.ts` sets a 1280 x 720 stepped viewport (`setViewport`), and refuses to get ready unless items are drawn after priming; `belt-items.spec.ts` zooms to 10 tiles across.
- **Files outside the list (forced).** `sim/tests/common/mod.rs` (the oracle learns the spawner and despawner rules and checks every lane's schedule; `transport_store`, `set_spawner`), `sim/tests/belt.rs` and `sim/tests/furnace_predict.rs` (struct literals; the re-pin below), `tests/browser/belt-construction.spec.ts` (`Ui.belt` gains `spawn`).
- **Moved pins.** `idle_belts_cost_nothing` (curves, side-loading lanes, belts inside a run, lines): (108, 778, 376, 1,248) -> (119, 260, 67, 1,866). A third of its belts are spawners and a third despawners, and both now end runs. `BELT_SCRIPT_HASH` `213fa422f7abe35a` -> `901c859b884e03af`: the `Belt` bytes changed (`spawn_set`, `rate: u8`). It was re-pinned from the headless run and met by the DOM run.
- **Tests and injects.** Each inject made its test fail and was then reverted.
  - `spawner_sets_the_engine_schedule`. Inject: both lanes re-set on every wake. Fails with "lane 0 as if lane 1 were never configured": acc 256 against 340.
  - `despawner_sinks_and_counts` pins (300, 261, 39) after 400 ticks. Inject: `Sink` -> `DeadEnd`. Outputs `[DeadEnd, DeadEnd]` against `[Sink, Sink]`.
  - `set_spawner_rules`. Inject: no `BadRate` check. Gets `Ok(())` against `Err(BadRate)`.
  - `spawner_writes_nothing_per_insert` pins 450 inserts over 600 ticks, 0 puts, 0 writes and 0 visits. Inject: the spawner re-woken every tick. Gets 225 against 450 inserts.
  - `spawner_passage_drains`. Inject: a despawner never joins the run behind it. Fails with "the despawner fronts the run".
  - `reference_belt_panel`. Inject: an item tap on an unset lane gives rate 0. The `pumpUntil` times out.
  - `reference_belt_items_flow`. Inject: no `draw_items` call. Fails with "lane 0 holds 0".
  - `reference_belt_items_converge`. Inject: `Sink` -> `DeadEnd`. Corrections 12 against 8, States 6 against 2.
- **Golden.** The first `golden:record` aborted before writing: its replay ends at the last logged action, and the drain ran past the despawner's placement. The passage now ends by picking the despawner up, and the second attempt wrote.
  - Checkpoints 10-730 are unchanged. The first changed checkpoint is 740 (`e8d76292ed1235bb`, was `bb15827cb6c1b132`): the first belt's bytes. The last is 966 (`0e5ef452882971cd`).
  - `.log` grew from 385 to 511 B, and its first 385 B are identical. That is 38,087 log bytes per player-hour, under the 65,000 ceiling.
  - No budget row moved: `net.bytesPerHour` and the `gc.pages.reference*` rows hold.
  - Replays green: reference-sim 156 (158 with `test-hooks`), `wasm -t reference` 36, `browser -t determinism` 1, `reference_full_game_single`.
- **Also run.** `netcode -t reference` 42 (2.2 s), `browser -t reference_` 40 in 13.9 s. `reference_world_mismatch_reloads_once_onto_the_new_world` lost one run to a `pumpUntil` timeout at load 5 (M52's known flake); it passed twice when rerun alone. Also `browser -t gc-reference` 7, `unit` 390, `wasm -t build-game-features` 2, lint and clippy (both feature sets).
- **Not done here.** No native no-alloc test of `RefClient::extract` exists; the gc page covers the JS side only. The gc rows passed their budgets, and the suite prints readings only on failure, so none were taken. The `belts-tick` bench and the full `pnpm test` were not run. The device check `M53-item-lead` (row written in the `device-check` skill), the tag and the commit are the manager's.

**Fix round 1 (implementer, 2026-10-12; review `m53b-review.md`).** This supersedes the `Belt.spawn_set` bullet and the `BELT_SCRIPT_HASH` re-pin above. Each inject was made, seen red, and reverted.
1. **`Belt.spawn_set` is dropped.**
   - The wake queue merges two `SetSpawner`s on different lanes in one tick into one wake, so the last action's lane was the only one set.
   - The `schedule` phase now re-sets both lanes, `Some` for a configured lane and `None` for a cleared one, on every spawner wake whose lines stayed. The unchanged lane restarts at `acc` 0 and loses at most one period of credit: 84 of 683 in `spawner_sets_the_engine_schedule`, which now pins both lanes at `acc` 256 after the second configuration.
   - `SCHEMA_VERSION` stays 9; its history line says the field never shipped.
   - New test `two_lanes_set_in_one_tick` (two `SetSpawner`s in one `dispatch_batch`, then `assert_topology`). Inject (re-set only the last action's lane, as `spawn_set` did): lane 0 `None` against `Some((683, Item(2)))`.
   - Pins moved by the credit reset:
     - `despawner_sinks_and_counts` (300, 261, 39) -> (300, 260, 40);
     - netcode counters 10 -> 11 lists and 8 -> 9 corrections (the extra resend of lane 0's list).
2. **`spawners_unscheduled()` counts every refused `set_spawner`.** It is a `debug_assertions` counter like `belts_unmapped`, asserted 0 by `assert_topology` and by `spawner_sets_the_engine_schedule`. Inject (no count): `spawner_rescheduled_when_a_neighbour_remaps_it`'s "the refusal counted" 0 against 1.
3. **`reform` schedules any spawner whose lines it (re)creates**, its own wake's or a neighbour's (re-mapping after a full cap's `drop_pair`). `on_wake` schedules only when the spawner's lines stayed (a `SetSpawner`), so one wake never sets a lane twice (two wakes in one tick can, harmlessly: both write the same schedule with `acc` 0 before that tick's `advance`).
   - New test `spawner_rescheduled_when_a_neighbour_remaps_it`. At line cap 2, a spawner placed beside a belt is unmapped and then configured; picking the belt up re-maps the spawner in that wake, scheduled (683, acc 256). A second lane is refused by the tracker's pool and counted (1).
   - Inject (the old `reform` with `on_wake`'s schedule for any change): `(None, None)` against `(Some((683, 256)), None)`.
4. **`gc-entry.ts` is ready only when iron (17) and coal (19) are both drawn.**
   - The rows were re-measured per the `gc-test` skill (budget set to 1 temporarily), at 1-min load 3.2-3.7:
     - hardware, 6 clean runs: main 227.03-227.05 B/frame; client, sim and gen0 a constant 0.76;
     - software, 3 runs: main 203.43 attributed.
   - The formulas held 225.82-225.99, 0.81-0.83 and 204.16, so each formula gains the new reading. The manager moved main to 236 = ceil(227.05) + 8 (0016 §1's convention; `budgets.json`'s formula says so); the other budgets are unchanged. A refusal at a full forecast pool can depend on lane order (lane 0 set before lane 1's clear frees an entry; counted, fixed by the next `SetSpawner`; clearing `None` lanes first would remove it: low priority, recorded).
   - The full `gc-reference` project (clean runs and the `object` controls) is green, 7 tests.
5. **Masks.**
   - Netcode now pins compared ticks, `(line, tick)` pairs and items exactly: `[199, 796, 5632]` per client, the same twice.
   - Browser: the 15/16 band stays, with the reviewer's reason in the comment: the phase is set by the `setSpawner` dispatch-to-ack tick, which this page does not fix; exact counts live in the netcode test.
   - The x-range and pixel checks are commented as invariants.
6. **`idle_belts_cost_nothing`'s comment derives the four figures.**
   - 497 belts point into a side. 164 are despawners and 84 point into a spawner, leaving 249 that feed: 130 side-loaders (260 lanes; 389 = 778 / 2 before) and 119 sole curve inputs.
   - 119 curves: 82 plain belts and 37 despawners.
   - 67 belts inside a run: exactly the plain belts behind a same-way despawner.
   - 2 x 933 lines.
   - `games/reference/CLAUDE.md` says `shape_of_kind` and the new schedule rule.
   - **For Tyler (the manager to put to him):** a spawner accepts no input from any side (built), and a rotated spawner restarts at zero credit (built).
7. **Golden re-recorded once.**
   - The `.log` is byte-identical (511 B).
   - The first changed checkpoint is 740, which returns to `bb15827cb6c1b132`, HEAD's value: without `spawn_set`, a plain belt's bytes are HEAD's again. Checkpoints 740-966 differ from round 0's; the last is 966 `a76c8e348bb16383`.
   - `BELT_SCRIPT_HASH` returns to HEAD's `213fa422f7abe35a`, so it does not move relative to HEAD.
   - Green:
     - reference-sim: 158 tests, and 160 with `test-hooks`;
     - `netcode -t reference`: 42 (2.2 s);
     - `browser -t reference_`: 40 (14 s);
     - `browser -t gc-reference`: 7;
     - `wasm -t reference`: 36;
     - `browser -t determinism`: 1;
     - typecheck and lint.

**Manager gate (2026-10-12).** The milestone exists as the reference half of the M53 split (`scratchpad/m53-research.md`). Two adversarial review passes (`scratchpad/m53b-review*.md`) and one fix round: pass 1 one must-fix (two `SetSpawner`s on different lanes in one tick lost the first lane's schedule: the wake queue is deduplicated and `spawn_set` was overwritten; `spawn_set` dropped, both lanes re-set on every spawner wake, the other lane losing at most one period of credit (84 of 683, pinned); `two_lanes_set_in_one_tick`), should-fix (a refused `set_spawner` counted by `spawners_unscheduled()` and asserted 0 by the oracle; a spawner re-mapped by a neighbour's wake scheduled in `reform`; the gc reference page's readiness requiring both item sprites and its rows re-measured: main 227.03-227.05 B/frame, the budget 234 → 236 by 0016 §1's `ceil + 8`, applied by the manager; the netcode convergence counts pinned exactly) and notes (the browser flow spec's 15/16 item band kept with its reason: a phase band over 683/256-tick periods on a page whose dispatch-to-ack tick is not fixed; the `idle_belts_cost_nothing` re-pin derived; the two rule choices put to Tyler as question 13). The golden was re-recorded once more after the field drop and its early checkpoints returned to HEAD's values (plain belts encode as before), the `.log` byte-identical at 511 B. Device check: no phone on USB at the gate (`adb devices` empty, no iOS driver; iOS judgement is driverless by rule), so `M53-item-lead` is left for Tyler's round with its default. Every claim rerun by the manager after the fix round: the reference-sim suite (158; the slow `test-hooks` leg 14), `rust -t spawner` (12), `netcode -t reference` (42, 2.1 s), `wasm -t reference` (36), `-t build-game-features` (2), `unit` (390), `browser -t determinism`, `browser -t reference_` (40, 14 s), `browser -t gc-reference` (7), typecheck, lint, no mask, the golden grown by the passage only, nothing in the engine crate or fixtures, `games/reference/CLAUDE.md` at 58 lines. Netcode suite alone at 1-min load 2.1: 6.8 s of 10. Bench at 1-min load 2.0-3.4 (the engine untouched): 0.2175 / 0.2139 / 0.2161 ms against 0.2146, within noise. Full `pnpm test` at 1-min load 3.1 (17 by the end, other sessions): rust 1,035, unit 390, wasm 216, netcode 170 (12 s of 10 under that load), browser 274 with one red, the engine's `gc: flat transport parity` (a gc page unrelated to this milestone): rerun alone three times at 1-min load 11.7-15.4 (green each time) and the whole browser suite once at load 1.7 (274 green, 49 s): the one red compared the sim isolate's idle bytes between two transports (404 vs 220) during the load spike, a timing-dependent attribution in an engine gc page this milestone does not touch (no engine change), recorded as a flake. Tag `belts-playable` on this commit.
