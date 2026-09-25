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
- TS unit: `gen_assets_reproducible` (run the script twice into a temp dir, bytes equal the committed files; manifest obeys the limits of `0018` §4), `reference_package_depends_only_on_engine` (`package.json` has `engine` as its single runtime dependency, as `workspace:*`, and `"private": true`: the UI stays framework-free; `sim/Cargo.toml` depends on the engine crate by a relative `path`, never through `node_modules`, `0017` §1), `reference_bindings_have_no_bigint` (no `bigint` in `src/bindings/`: `0003` TS-facing types; the fixture half is M16's).
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

Steps 1-3 only (a second implementer takes steps 4-6 from these commits and this section). Base
`b2fe26f`; `pnpm test && pnpm lint` green there and still green after these steps (`rust 376`, `unit
222`, `wasm 55`, `browser 171` at `26s/35s`; lint's four checks all pass).

**Crate/package names.** `games/reference/sim`'s package is `reference-sim` (lib target
`reference_sim` in Rust path syntax); the npm package is `reference`. `sim/Cargo.toml` depends on
the engine crate at `../../../packages/engine/crates/engine` (a direct relative path, never through
`node_modules`, 0017 §1/§6); no `[profile.*]` section (the workspace root's apply to every member,
0017 §6's own note for an in-repo game).

**Seam shapes (Provides), exact:**
- `RefWorldgen`/`RefParams` in `sim/src/worldgen.rs`. `RefParams` has 12 fields (`height_octaves:
  u32`, `height_freq: f64`, `moisture_octaves: u32`, `moisture_freq: f64`, `deep_water_level: f64`,
  `water_level: f64`, `sand_level: f64`, `dirt_moisture_max: f64`, `iron_density`/`wood_density`/
  `stone_density`/`coal_density: u32`), `#[serde(default)]` (container form, backed by its own
  `Default` impl) so a world config's `params.worldgen` may be `{}`. Defaults: octaves 5/3, both
  freqs `1/128`, `deep_water_level -0.25`, `water_level -0.05`, `sand_level 0.0`,
  `dirt_moisture_max 0.0`, densities `1200/3500/1200/900` (out of 65,536, one `hash2` draw's low 16
  bits). `TEST_SEED = 0x5EED_1234_ABCD_0042` (`6840143426475589698` decimal) lives in
  `sim/tests/common/mod.rs` and is also the real page's own world seed (`src/main.ts`), so the
  landmark tiles below are what a player actually sees.
- `content.rs` (step 1/2, ahead of step 4's `register`/`TraitSet`s): `DEEP_WATER=0, WATER=1,
  SAND=2, GRASS=3, DIRT=4`; `IRON=16, WOOD=19, STONE=22, COAL=25`; `RESOURCE_STAGE_{FULL,HALF,
  LOW}=0/1/2`; `UNITS_PER_TILE=10`. **A resource id doubles as its own "full" depletion-stage
  visual id**; step 5's `tile_visual` computes `resource_id + stage` (0/1/2) for the resource
  layer's visual. This makes the *default* (identity) `Registry::resource_visual` mapping already
  show correct "full" art with no `register` override at all -- confirmed by the browser test
  below, which passes using only the step-1 no-op `register`.
- `scatter_resource` (`worldgen.rs`, private): one `hash2` draw per tile, `& 0xffff` against a
  fixed, ordered per-terrain resource list (grass: iron/wood/coal; dirt+sand: iron/stone/coal;
  water: none), cumulative-threshold selection. Not itself a Provides seam (private fn), but
  `content.rs`'s ids are.
- `sim/tests/common/mod.rs` holds only `TEST_SEED` so far; `RefScenario` (new world, join, dispatch,
  step ticks, read player/tile, state hash) is **left for step 4/5**, since it needs `Game::apply`/
  real `PlayerState` to drive, neither of which exists before step 4.
- `tests/fixtures/landmarks.json` + its guard test: **left for step 5** (same reason: "nearest land
  tile"/spawn is collect/player logic). For steps 1-3's own browser test, three landmark tiles for
  `TEST_SEED` were found by an ad hoc native scan (a scratch test, not committed) and hardcoded in
  `tests/browser/terrain.spec.ts`: `(1, 0)` = plain `SAND`, no resource; `(3, 0)` = `WATER`; `(0,
  0)` = `IRON`. Step 5 should either reuse these exact coordinates for `landmarks.json` or update
  the spec if they differ.
- `tests/helpers/game.ts::openGame(page, opts: { path?: string })`: mirrors `packages/engine/tests/
  browser/support/page.ts::openPage` byte-for-byte (navigate, assert `crossOriginIsolated`, fail on
  page error/console error, wait for `window.__pageReady`), duplicated rather than imported across
  the package boundary (`reference_package_depends_only_on_engine` forbids a runtime dependency on
  anything but `engine`, and a dev-only cross-package import would still be irregular for an
  external game to copy).
- Browser test wiring (exact files/pattern, per the delegation prompt's own ask): `packages/engine/
  playwright.config.ts` gained a `reference` project (`testDir: '../../games/reference/tests/
  browser'`, `use.baseURL` a fixed `http://127.0.0.1:4520`) and a second `webServer` array entry
  (`vite preview --port 4520 --strictPort`, `cwd` = `games/reference`). `scripts/suites.mjs`: a new
  `reference` build step (`vite build`, `cwd: 'games/reference'`, run after `pages`) and
  `'--project', 'reference'` appended to the `browser` suite's own `args` (same leg as
  `chromium`+`gc`, not a new leg -- a leg is a separate `playwright test` process that starts every
  configured `webServer` regardless of `--project`, so a second leg would need its own *third* port
  for the pages server too). The `playwright` adapter (`scripts/lib/adapters.mjs`) hardcodes this
  one config file for every playwright-kind suite/leg, so a project + `testDir` override was the
  only way in without editing that adapter. Measured: `pnpm test browser -t reference_` (this
  brief's own verification command) -- `1 test, 2.3s/35s`; full `browser` suite `171 tests,
  26s/35s` (was 170/24s before this milestone touched it elsewhere in Phase 3), so the new test's
  own cost is about 1 test / +2s, comfortably under the "≤ 3s p95" budget note and the suite's own
  headroom.
- `unit` suite: `vitest.config.ts`'s `unit` project `include` gained `games/*/src/**/*.test.ts` and
  `games/*/scripts/**/*.test.mjs` (previously `packages/*` only) so `gen_assets_reproducible`,
  `reference_package_depends_only_on_engine` and `reference_bindings_have_no_bigint` (all three
  Tests-added TS unit tests) actually run under `pnpm test unit`.

**`engine/render`: a new public export subpath (packages/engine, "Engine only for bug fixes"),
added because it did not exist.** No production code outside `packages/engine` could previously
build a real WebGPU page at all: `initDevice`, `createTerrainRenderer`, `loadTileArt`,
`createRealFrameLoop`, `attachVisibilityHandling`, `installPageStyles`, `systemClock`/
`systemScheduler` were reachable only via relative imports into `packages/engine/src/*`, which
`games/reference` (a `workspace:*` consumer of the *built* package, per 0017 §1/§8) cannot do.
`packages/engine/CLAUDE.md`'s own rule ("Add an exports subpath only together with the file that
backs it") anticipates exactly this: one new file, `packages/engine/src/render.ts`, re-exporting
those eight names/types (not `camera/transform.ts`'s `pxPerTile`, a one-line formula inlined in
`main.ts` instead of adding a ninth), plus one new `"./render"` entry in `package.json`'s `exports`
map pointing at `dist/render.d.ts`/`dist/render.js`. No existing test asserts a closed/fixed exports
map (checked: no `package.json`/`exports` string appears in any `packages/engine` test); the
tarball-install test of 0017 §8 does not exist yet (a later milestone's). This is a **decision an
orchestrator may want to confirm** rather than a pure bug fix, since it is new published surface,
but it was made unilaterally here because the alternative (no way to build a real page from outside
`packages/engine` at all) blocks this milestone's own Goal outright and the addition is purely
additive, small, and matches the package's own stated extension process.

**`games/reference/vite.config.ts`: `publicDir: 'assets'`.** The brief's own Scope/exit-criterion
wording fixes the on-disk directory as `games/reference/assets/` (not `public/`), but Vite only
serves a package's `public/` directory at the URL root by default; `assets/tiles.json` on disk is
therefore `fetch('/tiles.json')` at runtime (not `/assets/tiles.json`) -- `main.ts` and
`ClientOptions.assets.tiles` both use `/tiles.json`. Confirmed by Vite's own runtime error message
when this was first wrong ("Instead of /assets/tiles.json, use /tiles.json").

**`TerrainRenderer` has one colour-target format, fixed at creation** (`createTerrainRenderer`'s own
contract): `main.ts` creates it with `navigator.gpu.getPreferredCanvasFormat()` (as the real canvas
also uses, via `createRealFrameLoop`'s internal `configureCanvasContext`) and the diagnostic probe
below creates its own offscreen target with that *same* format, swapping R/B channels back on
readback when the preferred format is `bgra8unorm` (measured: this machine's preferred format is
`bgra8unorm`). `slice.ts`'s own precedent (reconfiguring the canvas to `rgba8unorm` instead) was not
followed, since `main.ts` never overrides `createRealFrameLoop`'s own canvas configuration.

**Step 1's neutral-colour bar and step 3's real pipeline.** Step 1's `main.ts` was a single
`createClient` call with no WebGPU pipeline at all (canvas painted via CSS, since `tiles.json`
doesn't exist yet); step 3 replaced it wholesale with the real `initDevice`/`createTerrainRenderer`/
`loadTileArt`/`createRealFrameLoop` wiring (`packages/engine/tests/browser/pages/src/device.ts`'s
own shape), plus a `?`-free camera-drive `onCamera` (real pan/pinch/wheel/WASD/inertia via
`client.camera.tick`) and two test-only diagnostic window hooks (`__setCamera`, `__probeTile`) built
entirely from production `TerrainRenderer`/plain-WebGPU calls -- **never `engine/test`**, which must
not be imported by production code; `__probeTile` polls real animation frames (up to 300) rendering
the target tile alone into an 8x8 offscreen target until its centre pixel leaves
`terrain.wgsl`'s own `NEUTRAL_COLOR` (`32,32,32,255`), the same "wait for the real event, not a
fixed timer" discipline `slice.ts` uses, built without that page's own indirection-mirror machinery
(not needed: nothing else races this renderer for a production page with no continuously-changing
diagnostic overlay).

**Asset script (`scripts/gen-assets.mjs`).** Terrain visuals 0-4 (4 variants each, cells 0-19,
flat colours, no per-variant pixel noise); resource-stage visuals 16-27 (1 variant each, cells
20-31). Exact flat RGB (opaque, `rgba8unorm`/`bgra8unorm`-normalised on readback): deep water
`(20,40,110)`, water `(40,100,200)`, sand `(215,195,140)`, grass `(70,150,60)`, dirt `(120,85,55)`;
iron full/half/low `(230,140,60)/(180,110,50)/(120,80,40)`; wood `(150,110,40)/(110,80,30)/
(70,55,25)`; stone `(170,170,170)/(130,130,130)/(90,90,90)`; coal `(50,50,55)/(35,35,38)/
(20,20,22)`. **"Slight per-tile randomness ... dithering" (Requirements) is not hand-baked into the
art**: the engine's own shader-level PCG brightness jitter (±1/255) and stateless edge dithering
(0018 §3) already provide it per tile at render time regardless of the art's own content, so each
terrain's 4 variant cells are byte-identical flat colours -- simpler and exactly reproducible
without a seeded PRNG. `tile_px=16`, `columns=8` (image `128x64`); `sprites.png`/`sprites.json` are
a 1x1 transparent pixel and `{sprites: {}}` (valid against `render/atlas.ts`'s own
`validateSpritesManifest`, checked directly). `--check`/`--out <dir>` flags: no dependency, so no
prior art to match; documented in the script's own header. Verified: `node games/reference/scripts/
gen-assets.mjs --check` passes; both `tiles.json` and `sprites.json` validated against the real,
built `render/art.ts`/`render/atlas.ts` schema functions (not just this script's own idea of the
schema).

**M02 import-allowlist / target-features coverage gap, found and left open (escalated, not fixed).**
Verified two different ways: (1) clippy's workspace lint bans (`disallowed_methods`/`disallowed_types`,
`[lints] workspace = true` in `sim/Cargo.toml`) **do** reach `reference-sim` -- `cargo clippy -p
reference-sim --all-targets -- -D warnings` is clean, and it is an ordinary workspace member so
`pnpm lint`'s `cargo clippy --workspace ...` already covers it. (2) `packages/engine/tests/wasm/
allowlist.test.ts` (the "import allowlist"/"target features" tests) does **not** reach it:
`describe.each(fixtureNames())`, and `tests/support/fixtures.ts::fixtureNames()` only scans
`packages/engine/fixtures/*` -- `games/reference/sim` is a different directory entirely, so its
built `.wasm` is never checked there. No fix applied here (a shared M02 test's scope is not this
brief's Scope to decide unilaterally); a follow-up should either extend `fixtureNames()`/
`fixtureBytes()` to also cover `games/*/sim`, or add a small dedicated test in this package once its
own `.wasm` is guaranteed built by a `pnpm test` build step (the `reference` step added above builds
it via `vite build`, so the artifact exists by test time -- a future step could read it directly
from `games/reference/sim/target/engine/dev/game.wasm`).

**Verification command note.** `pnpm test rust -t reference` (this brief's own command) matches
**1** unrelated pre-existing test (`engine::module_layering::scanner_reaches_a_real_host_reference`)
and **none** of this crate's own tests: `cargo-nextest`'s bare positional filter matches the test
*name* only, never the package/binary id, and none of this crate's test names contain the substring
"reference" (they contain "worldgen"/"scatter"/"export_bindings" instead). The crate's own 10 tests
were verified instead with `cargo nextest run -E 'package(reference-sim)'` (all pass) and are
included in the `rust` suite's `376`-test total above.

**Context artifacts.** `games/reference/CLAUDE.md` and the determinism-rule glob addition are **not
written yet** (Scope names them as part of this whole milestone's Context artifacts; the module
layout they'd document -- `sim/src/rules/`, one file per feature -- doesn't exist until step 5's
collect rules land). Left for the step 4-6 implementer.

**Not yet done (steps 4-6, for the next implementer):** `content.rs`'s `register`/`TraitSet`s; the
real `Action`/`Reject`/`PlayerState`/`GlobalState`/`Ui` (replacing this step's placeholders
verbatim, same type names `RefAction`/`RefReject`/`RefPlayer`/`RefGlobal`/`RefUi` -- rename only if
there's a reason to); collect rules and `RefScenario`; `tile_visual` depletion override (formula
above); `landmarks.json` + guard test; `reference_depletion_visible` browser test;
`games/reference/CLAUDE.md`. `durations_at_20_and_30_hz`, `replay_equals_live_hash` and the rest of
the collect-rule native tests are untouched (not yet written).

---

## Steps 4-6 (second implementer)

Base `5dfbfd3`; `pnpm test && pnpm lint` green there and still green after these steps (`rust 388`,
`unit 224`, `wasm 57`, `browser 172` fast tier at `26s/35s`; `browser` slow tier `41` tests at
`31s`; lint's four checks all pass). Commits `a4b04d2`..`a47a06e`.

**Seam shapes (Provides), exact, continuing cut 1's numbering:**
- `content.rs` additions: `NOT_BUILDABLE = TraitSet(1 << 0)`, `COLLECTABLE = TraitSet(1 << 1)`;
  `RANGE_Q8: i32 = 3 * 256` (768, three tiles in Q24.8 raw units); `pub const fn collect_ticks(rate:
  TickRate) -> Ticks { rate.secs(2) }` and `COLLECT: Ticks = collect_ticks(RefGame::TICK_RATE)`
  (`Ticks(40)` at the crate's own 20 Hz); `pub fn register(r: &mut Registry)` (both waters
  `NOT_BUILDABLE`, all four resource ids `COLLECTABLE`, no prototypes).
- `RefAction` (`lib.rs`): `StartCollect { tile: TileXY, from: WorldXY }` / `CancelCollect`, matching
  0001's own reference-game example field-for-field. `RefReject`: `Unknown | NoResource |
  OutOfRange | Busy`, in Scope's own validation order (minus `Unknown` = the "tile readable" read
  failure). `TileXY`/`WorldXY` (`lib.rs`, `#[ts(export)]`): `{ x: i32, y: i32 }`, `.tile()`/
  `.world()` convert to `engine::world::{TilePos, WorldPos}` -- needed because those engine types
  derive neither `Serialize` nor `TS` (`fixtures/presence`'s own `TileXY`/`WorldXY` precedent,
  independently re-derived here since this package cannot import across the package boundary).
- `RefPlayer { inventory: Inventory, stone_mined: u32, collecting: Option<Collecting> }`.
  `Inventory { iron, wood, stone, coal: u32 }` with an `add(resource: u8, n: u32)` helper (a no-op
  for any id outside the four resources, defensive). `Collecting { tile: TileXY, done_at:
  engine::time::Tick }` (`TileXY`, not `TilePos`, same Codec-derive reason as above).
- `rules::collect` (`sim/src/rules/collect.rs`, the first file under `rules/`, one per feature):
  `pub fn in_range(from: WorldPos, tile: TilePos) -> bool` (Provides, exact signature) -- squared
  distance in `i128` against `RANGE_Q8^2`, never `sqrt` (avoids the NaN-guarding question entirely
  rather than answering it). `pub fn start(w, who, tile: TilePos, from: WorldPos) -> Result<(),
  RefReject>` and `pub fn cancel(w, who) -> Result<(), RefReject>` are the two `apply` handlers,
  called from `lib.rs`'s `RefGame::apply` after converting the wire `TileXY`/`WorldXY` fields with
  `.tile()`/`.world()`. `pub fn tick(cx: &mut TickCx<'_, RefGame>)` is the whole tick-completion
  pass, called from `RefGame::tick`.
- **Depletion completion (`complete_one`, private):** decrements `aux` by exactly 1 per completed
  collect (Scope: "add one item" -- one unit per one item, ten total collects to fully deplete a
  tile); at `aux == 0` also clears the resource id in the *same* `set_tile` call ("overlay is
  canonical": no tile is ever left with a stray non-zero `aux` and no resource). `stone_mined` only
  bumps when the harvested resource is `content::STONE` (Scope's own wording, "add one item, bump
  stone_mined", read as two effects of one collect completion rather than an unconditional counter
  -- `PRE-PLAN.md` §4's "unlock at 5 stone" only makes sense counting stone specifically). Re-reads
  the tile at completion time rather than trusting what `apply` saw (Planning decisions "Collects
  are not reservations"): `collect_second_finisher_gets_nothing` is this path's own proof.
- `ClientSide::tile_visual` (`lib.rs`, `RefClient`): table lookup for the base layer
  (`TileTexel::from_tables`) plus `resource_id + depletion_stage(aux)` for the resource layer, where
  `depletion_stage` buckets `aux` into `RESOURCE_STAGE_{FULL,HALF,LOW}` at the thresholds Planning
  decisions fixes (7-10/4-6/1-3). **A single completed collect never crosses a stage boundary from a
  fresh tile** (10 -> 9 is still "full"): the fewest collects that do are four (10 -> 6, into
  "half"), load-bearing for `reference_depletion_visible` below.
- `sim/tests/common/mod.rs::RefScenario`: `new()` (genesis at `TEST_SEED`/default `RefParams`),
  `join(who)`, `dispatch(who, action) -> Result<(), RefReject>` (auto-incrementing `seq`,
  `Rejected::Engine` panics -- never expected here), `step_ticks(n)`, `player(who) -> RefPlayer`,
  `tile(pos) -> Tile`, `set_tile(pos, tile)` (a direct write bypassing `apply`, native-test-only, used
  to set up a near-depleted tile without nine real collects first), `hash() -> u64`. `#![allow
  (dead_code)]` at the module's top: `landmarks_fixture.rs` uses neither `RefScenario` nor most of
  its own methods, and each `tests/*.rs` file compiles this module as a separate, whole copy.
- `tests/fixtures/landmarks.json` (`games/reference/tests/`, one level above `sim/`, shared by the
  Rust guard test and (in principle) a browser test): `{ seed: "6840143426475589698", land: {x,y},
  resources: { iron, wood, stone, coal: {x,y} } }`. For `TEST_SEED`: land and iron both `(0, 0)`
  (the origin tile itself is grass with iron -- `terrain.spec.ts`'s own hardcoded iron probe from
  cut 1 already used this coordinate), wood `(-4, -2)`, stone `(-1, 2)`, coal `(-4, -16)` (the
  farthest, `dist_sq = 272`). `landmarks_fixture_current` (`sim/tests/landmarks_fixture.rs`)
  recomputes all five by generating every chunk within a fixed `SEARCH_CHUNK_RADIUS = 4` (chunks
  `-4..4` each axis, `256x256` tiles, ~0.03s) and comparing byte-for-byte against the JSON; no
  separate regenerate script exists (Deviations note in `games/reference/CLAUDE.md`: update the JSON
  to match the test's own computed values). `terrain.spec.ts` (cut 1) was **not** changed to read
  this file -- its three hardcoded coordinates already agree with it exactly, and duplicating a tiny
  amount of literal data across a Rust JSON fixture and a five-line TS test did not seem worth a new
  cross-language read for three numbers that cannot drift independently (the guard test already
  catches drift in the JSON itself).
- `main.ts` gains three more test-only window hooks, all built from production APIs, never `engine/
  test` (same discipline as step 3's `__setCamera`/`__probeTile`): `__dispatchStartCollect(tileX,
  tileY, fromX, fromY) -> number` (`client.dispatch`, returns the action's `seq`); `__cameraState()
  -> { x, y, tilesAcross }` (reads `client.cameraState`, a production public field the page's own
  `onCamera` already reads every frame).

**Depletion browser test cost, found and resolved by moving it to the slow tier (a real, measured
budget conflict, not a design error left in place).** `reference_depletion_visible` needs four real,
sequential `StartCollect` completions to see any texel change at all (previous bullet), each a real
2-second wait (`content::COLLECT` = 40 ticks at the page's own real 20 Hz pace) -- `ClientOptions.
test` (the only way to fast-forward a real `Client`'s sim deterministically, `engine/test`'s
`stepTick`/`asHarness`) is documented in `packages/engine/src/client.ts` itself as "never set by a
game", so this could not be sped up without either that or a change to the fixed depletion-stage
thresholds (Planning decisions, not this brief's own step to relitigate). Measured: adding it to the
fast `browser` project pushed the whole suite from a `170/26s` baseline to `173 tests/33s`, against
a `35s` budget with almost no headroom left for any later milestone's own browser test. `@slow` in
the test's title (`packages/engine/CLAUDE.md`'s own convention) moves it out of `pnpm test`
entirely: fast tier is back to `172 tests/25s` (net: `+2` tests, `-1s`, since only `camera.spec.ts`'s
`reference_pan_and_zoom_work` and the unchanged `terrain.spec.ts` remain fast); the slow tier runs
it standalone in `10-11s`, well inside `pnpm test:slow`'s own, much larger budget. Verified with
`pnpm exec playwright test --config packages/engine/playwright.config.ts --grep
'(?=.*@slow).*reference_' --project chromium --project gc --project reference` (`1 passed (10.7s)`)
-- `pnpm test:slow browser -t reference_depletion_visible` itself reports `0 tests` through
`scripts/test.mjs`'s own slow-tier `-t` composition, reproduced identically with the pre-existing,
unrelated `-t determinism` (also `0 tests` under `--tier slow`), so this is a runner-level quirk
predating this milestone, not something introduced here; `pnpm test:slow browser` with no `-t` does
run and pass it (`41` tests total). **A decision an orchestrator may want to record**: whether a
future milestone should revisit the depletion-stage granularity (e.g. more, narrower stages) so a
single collect is visibly demonstrable, given this workaround; not changed here since Planning
decisions fixes the exact thresholds and changing them was outside this cut's own step.

**M02 import-allowlist/target-features coverage gap, closed (cut 1 found and left it open).**
`packages/engine/tests/support/fixtures.ts` gains `gameCrateNames`/`gameCrateBuildDir`/
`gameCrateBytes` (scanning `games/*/sim`), kept separate from `fixtureNames`/`fixtureBytes` (other
tests, e.g. `abi-registry.test.ts`, also iterate those, and widening them would silently pull every
such test onto every game crate). `allowlist.test.ts`'s two checks are factored into one
`checkAllowlist(label, bytes)` function, called once per fixture (`describe.each(fixtureNames())`,
byte-identical to before) and once per game crate (a new, separate `describe.each
(gameCrateNames())`). A new dev-profile build step, `game-sims` (`scripts/build-game-sims-dev.mjs`,
mirroring `build-fixtures.mjs`), was needed: the existing `reference` build step is a plain `vite
build`, which defaults to the *release* profile, and release (`lto = "fat"`, `strip = true`) strips
the `target_features` custom section this test's second check reads -- confirmed by first pointing
`gameCrateBuildDir` at the release output and seeing `target features` fail with "dev-profile
modules keep the target_features section" (0 features found), then fixing it with the dedicated dev
build step instead of loosening that assertion. Proof the widened test actually reaches
`reference-sim` (per the delegation prompt's own ask): a temporary `unsafe extern "C" { fn
__proof_of_banned_import(); }` called once from `content::register` made `import allowlist` fail
with `games/reference/sim imports outside the allowlist:\n  env (1: __proof_of_banned_import): an
unresolved C symbol`; reverted immediately after, `cargo nextest run -E 'package(reference-sim)'`
and the widened `wasm` suite both clean again.

**Context artifacts.** `games/reference/CLAUDE.md` (48 lines) and `.claude/rules/determinism.md`'s
`games/reference/sim/**` glob addition are both written (commit `a47a06e`).

**Verification commands, exact outputs:**
- `cargo nextest run -E 'package(reference-sim)'`: `22 tests run: 22 passed, 0 skipped` (10 from cut
  1's steps 1-3 plus 12 new: 8 collect tests, `in_range_boundary_is_inclusive`,
  `landmarks_fixture_current`; `export_bindings_*` counted separately per binary above).
- `pnpm test browser -t reference_`: `2 tests 2.6s/35s` (`reference_terrain_renders`,
  `reference_pan_and_zoom_work`; `reference_depletion_visible` is `@slow`, see above).
- `node games/reference/scripts/gen-assets.mjs --check`: `gen-assets.mjs --check: committed assets
  match a fresh generation.` (unchanged by this cut; re-verified after every asset-adjacent change).
- `pnpm --filter reference dev` (smoke, this session): `curl -sD -` on `/index.html` shows `HTTP/1.1
  200 OK`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`.
- `pnpm test && pnpm lint`: green, exact counts above.

**Exit criteria, met/unmet/not verified:**
- "`pnpm --filter reference dev` serves a cross-origin-isolated page ... pan and zoom work": **met**
  -- COI headers confirmed by curl above; pan/zoom by `reference_pan_and_zoom_work` (real drag +
  wheel, `cameraState` read back, `1 passed` standalone).
- "Every test above passes by name": **met** for the fast tier's two reference browser tests and all
  22 `reference-sim` native tests; `reference_depletion_visible` **met but slow-tier-only** (see
  above), a deviation from the brief's own implicit fast-tier placement, not from correctness.
- "`git diff --exit-code` on bindings/assets after a build": **met** (re-verified after the final
  `pnpm --filter reference build` of this cut).
- "No `HashMap`, std transcendental or wall clock in `sim/` ...": **met** -- clippy bans pass
  (`cargo clippy -p reference-sim --all-targets -- -D warnings` clean) and the widened `wasm` suite's
  import-allowlist/target-features checks now cover `reference-sim` directly (proof above).
- "`pnpm test` and `pnpm lint` are green": **met**, counts above.
