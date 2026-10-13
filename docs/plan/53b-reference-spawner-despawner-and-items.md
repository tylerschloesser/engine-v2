# M53b: Reference game: spawner, despawner and items on screen (**Playable**)

Status: not started · After: 52, 53 · Tyler-dependent: no (his Spawner line built as written; question 9 (0078 A12's lead) judged here on a device)

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
- [ ] The Rust, browser and netcode tests above pass with an inject-fail-revert each; `spawner_writes_nothing_per_insert` holds.
- [ ] The golden has the passage (reviewed diff); `gc-reference*` rows green with items moving.
- [ ] `pnpm test`, `pnpm lint`, `pnpm test:slow browser -t reference_` green; `belts-tick` within noise of its M53 baseline.
- [ ] `M53-item-lead` run on a device and Tyler's judgement recorded (or the row left for his next round with the default "accept").
- [ ] Tag `belts-playable` on the pushed commit.

## Verification commands
`cargo nextest run -E 'package(reference-sim)'` · `pnpm test rust -t spawner` · `pnpm test browser -t reference_belt` · `pnpm test netcode -t reference_belt` · `pnpm test browser -t gc-reference` · `pnpm test wasm -t reference` · `pnpm test && pnpm lint`

## Budgets
`SCHEMA_VERSION` 8 → 9; the action-log and downlink rows if the passage moves them; `gc.pages.reference*` unchanged in JS bytes.

## Deviations
(filled in during execution)
