# M20: Reference game v0: world and collect rules

Status: not started · After: 16b · Tyler-dependent: no (Q4 answered: collect range is 3 tiles)

Split during planning: the PLAN.md row for M20 did not fit the sizing rule (about 2,100 lines, six files to read). This brief is the world and the headless rules; `20b-reference-player-and-collect-ui.md` is the player, presence and DOM, and is where the game becomes playable.

## Goal
`games/reference` exists as a private Vite app with a `sim/` crate ending in `export_game!`. `pnpm --filter reference dev` shows simplex terrain with a resource layer, drawn from script-generated art, pannable and zoomable. `StartCollect` / `CancelCollect` run headlessly through `apply` and `tick`, deplete a tile through the overlay, and the depleted tile looks different on screen.

## Read first
1. `docs/spec/overview.md`
2. `docs/spec/reference-game.md` (World; the collect bullets of Players)
3. `docs/decisions/0008-chunk-generation.md` (§1 rules for `generate`, §6 cost budget)
4. `docs/decisions/0018-renderer.md` (§3 texel format and `tile_visual`, §4 art contract)

Look up when you reach the step, do not read ahead: tile layout and trait tables `0007` §4, §6; float rules `0002` §2; what a game writes `0017` §6; the witness range check `0001` "Witness-carrying actions" step 2; durations `0006` "Conversion rule"; the mapping table in `PRE-PLAN.md` §4 ("The reference game on this API").
Mine from spikes: `spikes/determinism-hash/` (f64 simplex fBm, `hash2` scatter, the chunk timing loop). Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
- Package scaffold exactly as `0017` §6: one plugin line in `vite.config.ts`, `tsconfig` with `engine/virtual`, `index.html` using the page CSS of `0019` §3, `src/main.ts` calling `createClient` in single-player mode. `sim/` is a member of the root cargo workspace, `crate-type = ["cdylib", "rlib"]`, path dependency on the engine crate.
- `RefWorldgen: Worldgen` with `RefParams` (seed-independent knobs: octave counts, scales, sea level, per-resource density; `#[derive(TS)]`). Height (5 octaves) and moisture (3 octaves) f64 simplex fBm give five base terrains: deep water, water, sand, grass, dirt. `hash2` scatter puts iron, wood, stone or coal in the resource layer of land tiles only; `aux` starts at the units-per-tile Requirement.
- `content.rs`: terrain and resource ids, `TraitSet` bits `NOT_BUILDABLE` (both waters) and `COLLECTABLE` (every resource id), registered in `Game::register`; durations as `const` through `TICK_RATE.secs(..)`.
- Asset script `scripts/gen-assets.mjs`: plain Node, no npm dependency (PNG written with `node:zlib`), seeded, byte-reproducible. Emits `assets/tiles.png` + `tiles.json` (16 px, 4 variants per terrain, dither priority and band per visual) and an empty-but-valid `sprites.png` + `sprites.json`. Outputs are committed.
- Types: `Action::{StartCollect { tile, from }, CancelCollect}`, `Reject`, `PlayerState { inventory, stone_mined, collecting }`, `GlobalState` (empty for now), `Ui` (`Default` only; filled in M20b). ts-rs bindings written to `src/bindings/` and committed.
- Rules: `apply(StartCollect)` validates in this order: tile readable, resource present and `COLLECTABLE`, `dist(from, tile centre) <= RANGE` in Q24.8 integers, not already collecting; then puts the player with `collecting = Some { tile, done_at }`. `CancelCollect` clears it. `tick` completes due collects: decrement `aux` with `set_tile` (resource id cleared at zero), add one item, bump `stone_mined`. `on_player(Joined)` puts a default `PlayerState`.
- `ClientSide::tile_visual` override: resource visual id = f(resource id, depletion stage), three stages from `aux`.

## Non-scope
Player circle, spring, `Presence`, `admit`, spawn, any DOM UI (M20b). Inventory display, unlock, crafting (M32). Prediction (arrives with M25 without game changes). `checkSupport` capability screen (lands with M35).

## Files, packages and crates touched
`games/reference/` (new package) and `games/reference/sim/` (new crate); root `Cargo.toml` members list. Engine only for bug fixes.

## Seams
**Provides:** `RefGame`, `RefWorldgen`, `RefParams`; `content::{RANGE_Q8, COLLECT, UNITS_PER_TILE, NOT_BUILDABLE, COLLECTABLE}`; `rules::collect::in_range(from, tile) -> bool` (shared with M20b's button logic); native test helper `sim/tests/common/mod.rs::RefScenario` (new world with `TEST_SEED`, join a player, dispatch, step ticks, read player and tile, state hash); `tests/fixtures/landmarks.json` (nearest tile of each resource and nearest land tile to the origin for `TEST_SEED`, guarded by a Rust test); browser helper `tests/helpers/game.ts::openGame(page, opts)`.
**Consumes:** `export_game!`, `buildGame` (M02); `engine()` plugin (M02b); `Worldgen`, `hash2`, `engine::noise`, `assert_worldgen_contract` (M08); gen worker path (M08b); terrain renderer, `tiles.json`, `tile_visual`, `TileTexel` (M09); art sampling (M09b, if ticked); camera and input (M11); `Game` (incl. the `anchor` hook of 0024 §7), `Registry`, `Ticks`, `SimRng` (M12); `WorldRead`/`WorldWrite`, `TickCx::{player_count, player_id_at}`, `TickRate::secs`, `testkit::run_script` (M12b); sim worker (M13); `createClient` with `host: { kind: 'local' }` (M06b); `dispatch`, ts-rs bindings step, `add-action-type` skill (M16); `engine/test` stepping (M03, M06b, M13). Collect and craft timers belong to players, and the timer wheel of `0007` §7 is keyed by `EntityId`, so this game depends on M12b's player scan; if that seam changed, stop and fix the plan first.

## Planning decisions
- **Collects are not reservations.** Two players may collect one tile at once; at completion a collect whose resource is gone ends with no item. This keeps `apply` free of cross-player reads and produces the "last unit" rejection race that `0003` Consequences wants scripted (M34c).
- **Player timers are scanned, not scheduled.** `tick` walks the player table (at most `max_players`) and compares `done_at`. No engine timer is needed for players.
- **Scatter is per-tile and independent** (one `hash2` draw against a per-resource, per-terrain density in `RefParams`); no clustering, because the Requirement says "scattered randomly". Wood only on grass, stone only on dirt and sand, iron and coal on any land.
- **Noise helpers stay in the game crate** (`sim/src/noise.rs`). `0008` defers moving them into the engine; one game is not a reason.
- **Landmarks fixture.** Browser and netcode tests need tile coordinates; a native test recomputes `landmarks.json` from `RefWorldgen` and fails with the regenerate command if it drifts.
- **Depletion stages:** full (7–10), half (4–6), low (1–3), as three resource visuals per resource kind; well inside the visual limits of `0018` §4.

## Order of work
1. Scaffold package and crate; `export_game!(RefGame)` with no-op rules; page boots and shows the neutral colour.
2. `noise.rs`, `RefWorldgen`, native golden-hash and "no resource on water" tests.
3. Asset script and committed outputs; terrain visible; readback probe.
4. Types, `content.rs`, `register`; bindings committed.
5. Collect rules with `RefScenario` tests; `tile_visual` depletion; browser test that dispatches through `client.dispatch` and probes the texel.
6. `games/reference/CLAUDE.md`.

## Tests added
- Rust native (`sim/tests/`): `worldgen_golden` (raw tile bytes of 16 chunks incl. two near ±2^18), `worldgen_no_resource_on_water`, `landmarks_fixture_current`, `collect_completes_and_depletes`, `collect_out_of_range_rejected` (boundary at exactly `RANGE`), `collect_busy_rejected`, `collect_last_unit_clears_resource_and_overlay_is_canonical`, `collect_second_finisher_gets_nothing`, `cancel_collect_clears_timer`, `durations_at_20_and_30_hz` (`0006` Consequences), `replay_equals_live_hash`.
- TS unit: `gen_assets_reproducible` (run the script twice into a temp dir, bytes equal the committed files; manifest obeys the limits of `0018` §4), `reference_package_depends_only_on_engine` (`package.json` has `engine` as its single runtime dependency: the UI stays framework-free).
- Browser: `reference_terrain_renders` (semantic probes on three landmark tiles, `0020` §6), `reference_depletion_visible` (dispatch `StartCollect` from the test, step 40 ticks, the tile's resource texel changes stage).

## Exit criteria
- [ ] `pnpm --filter reference dev` serves a cross-origin-isolated page showing terrain and resources; pan and zoom work.
- [ ] Every test above passes by name.
- [ ] `git diff --exit-code games/reference/src/bindings games/reference/assets` is clean after a build and an asset-script run.
- [ ] No `HashMap`, std transcendental or wall clock in `sim/` (the M02 import-allowlist test and clippy bans run against `reference-sim`).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t reference` · `pnpm test browser -t reference_` · `node games/reference/scripts/gen-assets.mjs --check` · `pnpm --filter reference dev` (suite names as the `run-tests` skill gives them).

## Budgets
Chunk generation (`PRE-PLAN.md` §7 row 3): a `slow`-tagged native bench prints ms per chunk and warns above the desktop threshold of `0008` §6; M36 wires it into `pnpm test:slow`. Browser suite share: each reference browser test p95 ≤ 3 s (`0020` §4).

## Context artifacts
`games/reference/CLAUDE.md` (new, under 60 lines): commands, module layout, "rules live in `sim/src/rules/`, one file per feature", how to regenerate assets, bindings and landmarks. Add `games/reference/sim/**` to the globs of `.claude/rules/determinism.md`.

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
