# M42b: Transport core goldens (`fx-belts` requests and scenarios)

Status: done (2026-10-11) · After: 42 · Tyler-dependent: no

## Goal
`fx-belts` drives `engine::transport` (M42) through tick-rule requests and pins the first belt goldens natively, under Node and under Bun: a straight chain fed to saturation, a dead-end backup, spawn-to-sink conservation and a big-step crossing. Split from M42 on 2026-10-11 to meet the sizing rule (M42 is the engine crate; this is the fixture and the cross-runtime proof).

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0076-transport-lines-engine-game-split.md` (§2, §3 `insert_back`, §6 topology changes are host tick rules, §9)
3. `docs/plan/42-transport-core.md` (Seams: what `TransportWrite`/`TransportRead` provide; Deviations: anything that moved)
4. `docs/architecture/testing-and-tooling.md` (goldens, `pnpm golden`, the `wasm` suite's determinism legs)
Rules that apply: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`. Skills: `.claude/skills/run-tests/SKILL.md` (goldens: `pnpm golden belts`), `.claude/skills/add-action-type/SKILL.md`.

## Scope
- `fx-belts` grows the request pattern: `Action::Request(Op)` spawns a `Request` entity (plain data, one `Op` enum: `Chain { from, dir, tiles, speed, items_at_rest }`, `Link { from_line, to_line }`, `Spawner { line, item, period }`, `Sink { line }`, `DeadEnd { line }`); the entity's auto-wake lets `Belts::tick` execute it through `transport_mut()` and despawn the request. `Belts::tick` also runs the spawners (an active list) with `insert_back` (an integer accumulator per spawner, never a burst). Scenarios (`golden/scenario-*.json`) drive everything through these actions; `Action::Noop` stays for pre-existing encoded values.
- Goldens (`pnpm golden belts`, checkpoint hashes native/Node/Bun): `straight-chain` (one line pair fed to saturation, 400 ticks: speed, spacing, hand-off), `deadend-backup` (capacity 4 per tile per lane, boundary spacing), `spawn-to-sink` (conservation: spawned = live + sunk, read through `TransportRead::count` and the per-line `sunk` counter), `big-step` (speed 72: two items crossing in one tick). Each scenario's native test also asserts the stated property, not only the hash (0069 §3: a hash comparison alone cannot catch a self-consistent error).
- `transport_request_is_deferred_to_tick`: the fixture's own proof that a request is executed by `tick`, never by `apply` (an `apply`-time `transport_mut()` is `Unknown`: M42 pins the engine side; this pins that the fixture obeys it, by asserting no line exists at the tick the action was applied and one exists at the next).

## Non-scope
- Any change to `engine::transport` (M42; a defect found here is reported, fixed in the engine crate and recorded in M42's Deviations). `Merge`/`Fork`, surgery, geometry (M43, M44). The scale benchmark (M45).

## Files, packages and crates touched
- `packages/engine/fixtures/belts/` (`src/lib.rs`, `tests/golden_scenarios.rs`, `golden/scenario-*.json`, `golden/golden-*.json`, `CLAUDE.md`).

## Seams
**Provides:** `fx-belts` `Action::Request`, `Op`, the `Request` entity, the spawner active list; goldens `straight-chain`, `deadend-backup`, `spawn-to-sink`, `big-step` (M43's edit-while-running goldens extend this set; M45's benchmark reuses the request pattern to build the bench world inside a real `Sim`).
**Consumes:** M42's `TransportWrite::{create, destroy, set_out, set_speed, insert_back}`, `TransportRead::{len, speed, out, count, front, items_in}`, `WorldWrite::transport_mut`, `WorldParams::{max_lines, max_items}`; `testing::testkit::run_script`, `pnpm golden` (0020 §5); `fx-machines`'s golden test shape (`fixtures/machines/tests/golden_scenarios.rs`).

## Planning decisions
- **Requests, not direct writes.** Every topology change goes through a `Request` entity because 0076 §6 forbids `apply` from touching lines; the auto-wake of an apply-time spawn (`next_woken` in the same tick's `tick`) is the hand-off, the same pattern as `fx-machines`'s `Feed`.
- **`Op::Chain` builds lines in tile units** (`tiles x 256` positions, one `speed`), so a scenario reads like a belt and M43's surgery goldens can reuse the vocabulary; the fixture never computes geometry (M43).
- **Scenario sizes for the fast tier.** Four scenarios of a few lines each, at most 400 ticks; `wasm` stays inside 7 s with both runtime legs.

## Order of work
1. `Op`, `Request`, `Action::Request`, `Belts::tick` executing requests and spawners; a native smoke test.
2. The four scenarios and their property assertions; `pnpm golden belts`; `pnpm test wasm -t determinism` (Node and Bun).
3. `transport_request_is_deferred_to_tick`; `fixtures/belts/CLAUDE.md`; Deviations.

## Tests added
Rust suite (`fx-belts`): `belts_golden_straight_chain`, `belts_golden_deadend_backup`, `belts_golden_spawn_to_sink`, `belts_golden_big_step` (each: hash plus property), `transport_request_is_deferred_to_tick`. `wasm` suite: the four goldens replay under Node and Bun through the discovery leg added in this milestone's follow-up (`tests/wasm/determinism.test.ts` and `bun-leg.mjs` replay every fixture's `golden/scenario*.json` not already replayed by a named test; the brief's assumption that an existing test discovered fixtures was wrong).

## Exit criteria
- [x] The four goldens are written by `pnpm golden belts` from the `.wasm` under Node and match natively and under Bun; `deadend-backup` holds exactly 4 items per tile per lane at rest; `spawn-to-sink` conserves items; `big-step` lands two items in one tick.
- [x] Each golden test had an inject-fail-revert (a changed landing position changes the hash and fails the property).
- [x] `transport_request_is_deferred_to_tick` passes with an inject-fail-revert.
- [x] The fast `rust` suite stays inside 10 s and `wasm` inside 7 s.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t belts_golden` · `pnpm golden belts` · `pnpm test wasm -t determinism` · `pnpm test && pnpm lint`

## Budgets
- Fast-tier suite budgets (`scripts/suites.mjs`): `rust` 10 s, `wasm` 7 s.

## Context artifacts
`fixtures/belts/CLAUDE.md`: the request pattern and the goldens; one line in `fixtures/CLAUDE.md`.

## Manual device checks
none

## Deviations
Steps 1-3 done by the implementer (2026-10-11); the commit is the manager's.

**Built.** `fixtures/belts/src/lib.rs` 391 lines (`Op`, `Action::Request`, entity `Thing::{Request, Spawner}` replacing M40's `Marker`, `Global::lines`, `Belts::tick`, `Reject::BadOp`, `SCHEMA_VERSION` 2), `tests/golden_scenarios.rs` 360 (four golden tests and `transport_request_is_deferred_to_tick`; the native leg parses the scenario JSON itself, so its script cannot drift from the one Node runs), `golden/` four `scenario*.json` (101-191 lines, Biome-formatted) and four `golden*.json`; `fixtures/belts/CLAUDE.md`, one entry in `fixtures/CLAUDE.md`. No engine file changed.

**Spawner rule.** Per tick `acc += 256`; when `acc >= period` (`period` in 1/256 tick per item, `apply` refuses `< 256`) exactly one `insert_back`: accepted `acc -= period`, `spawned += 1`; refused (`NoRoom`/`Full`) `acc -= 256`, so the credit is held and the next tick is due again. At most one attempt per tick, never a burst; `period = 256` saturates. A spawner is the request entity itself, rewritten in place as `Thing::Spawner` and put on the `"spawner"` active list in the tick that executes it (its first attempt is that same tick).

**Id table.** `Global { chains, lines: [u32; 32] }`: `Chain` appends its `LineId` (or `0` when `create` refuses, so later indices stay aligned); every other op names a line by chain index; an index past `chains` is `LineId(0)` and the engine refuses it (`NoLine`), silently.

**Goldens** (`maxLines` 64, `maxItems` 4,096; property checked after every tick unless stated; first and only checkpoint):
- `straight-chain` (the canonical `scenario.json`/`golden.json`, tick 400, `60a22c73b46f98c5`): chain 0 (4 tiles) `Next` chain 1 (4 tiles, `Sink`), speed 24, a `period` 256 spawner. Along the path (`pos + 1024` on chain 0) consecutive items are exactly 64 apart, across the hand-off too, and every item's phase mod 64 is `2000 - 24 (t - 1)` (the first item lands at `1024 - 24` before tick 1's move); items are on both lines at once; conservation.
- `deadend-backup` (tick 300, `2a04864df67ef817`): a belt of two lanes, each chain 3 tiles `Next` chain 2 tiles, sinking until tick 60 (`Sink`), then `DeadEnd`; spawners 256 and 600. At tick 300 every line holds items at exactly `0, 64, ..., len - 64` (4 per tile per lane, boundary included) and nothing moved in the last tick; conservation every tick.
- `spawn-to-sink` (tick 400, `ad314a709a98fb35`): two lanes 3 tiles `Next` 2 tiles `Sink`, spawners 700 and 1500 on the feeders and 2000 on lane 0's sink line itself; `spawned == live + sunk` every tick (`count`, `sunk`), and at the end items are both live and sunk.
- `big-step` (tick 60, `fec39527c906aa81`): speed 72, chain 1 (2 tiles) holds items at rest at 0 and 64 (`items_at_rest`, `DeadEnd`) through tick 4; tick 5 links it to chain 0 (`Sink`) and both cross in that tick, at 440 and 504; a spawner from tick 10 puts its first item at `512 - 2 x 72 = 368` at the end of tick 10; conservation.

**Changed from the brief, and why.**
1. *No `scenario-straight-chain.json`.* The canonical pair is the straight chain; a second copy would put one fact in two files. `golden.mjs` discovers the fixture by `scenario.json` and writes `golden.json` for it; the test is still `belts_golden_straight_chain`.
2. *Node/Bun replay.* The brief said the goldens replay "through the existing determinism test (no new file; the fixture is discovered)". At the time no test discovered fixtures or replayed a `script` scenario. The Follow-up and Review fixes below added that discovery leg.
3. *The native script needs `Connected` after `Joined`.* `Host::connect` logs both, and `Sim::step` sets the roster bit on `Connected` (0024 §8); with `Joined` alone every native hash differed. `scenario.ts`'s `runScriptScenario` doc comment said the opposite. It is fixed in the Follow-up, and `fx-machines`' native leg is fixed in Review fixes.
4. *Every `Op` field in JSON*: `items_at_rest` is `[(u16, u32); 8]` with `#[serde(default)]`, so a chain without items omits it and one with items lists all eight pairs (`[0, 0]` = none).
5. *`transport_request_is_deferred_to_tick` calls `Belts::apply` directly* on `sim.authority_mut()` between two steps (the phase `Sim::step` gives `apply`: neither genesis nor tick) for all five op kinds, asserts no line and six request entities, then steps once and asserts two lines, the `Next`/`DeadEnd` outputs and one remaining entity (the spawner). No `#[should_panic]` or `catch_unwind`: the engine's debug assertion is what fails the test when the fixture misbehaves.

**Inject-fail-revert** (each injected, the named tests run, reverted with `git checkout` or a saved copy, green again; hashes read with a temporary print and the per-tick property disabled):
- `insert_back` landing `len - speed + 1` (`transport/advance.rs`, both branches): `belts_golden_straight_chain` red "tick 1: item 0 at path distance 2001", left 17, right 16 (hash `58bd23192838bbf3`); `belts_golden_big_step` red "tick 10: the first spawned item", left `[(3, 369)]` (hash `7375e26a91ab9d53`); `belts_golden_spawn_to_sink` red on the hash only (`5ba870cce44269c1`: conservation cannot see a landing); `belts_golden_deadend_backup` stayed green with an unchanged hash (`2a04864df67ef817`): a fully backed-up line at rest erases where items entered.
- Hand-off landing `tlen + p + 1`: straight chain red "tick 42: item 0 at path distance 1017", left 57, right 56; big step red "tick 5: both landed", left `[(1, 441), (2, 505)]` (hash `a0f3d2e6ad21e862`); the other two trip the engine's own debug assertion "landing past the end: 512 >= 512".
- Dead-end bound one short (`-SP + 1`): `belts_golden_deadend_backup` red "chain 0: 4 items per tile at 0, 64, 128, 192", left `[1, 65, 129, ...]`, hash `6392720890716cc3`.
- Fixture counting a refused insert as spawned: `belts_golden_spawn_to_sink` red "tick 42: spawned == live + sunk", left 27, right 26, hash `fca80a3a02c6142a`.
- `apply` calling `transport_mut()` and `create`: `transport_request_is_deferred_to_tick` red with the debug assertion "WorldWrite::transport_mut is host-tick only: Err(Unknown) inside apply/on_player (0076 §6); topology changes are tick rules".
- `tick` skipping requests: same test red "the next tick executed both chains", left 0, right 2.

**Engine defects found:** none.

**Follow-up (2026-10-11): the Node and Bun legs.** Change 2 above is closed.
- `tests/wasm/determinism.test.ts` discovers every fixture's `golden/scenario*.json` (`fixtures.ts` `goldenScenarios()`, `golden.mjs`'s rule) and replays each from the `.wasm` under Node against its `golden*.json`: one test per (fixture, scenario), `determinism: node matches golden <fixture>/<file>`. `bun-leg.mjs` does the same under Bun (`runScenarioLegs`, `determinism: bun matches golden <fixture>/<file>`). Both call the new `scenario.ts` `runGoldenScenario`, which is `golden.mjs`'s dispatch (`script` scenarios on a sim plus an encoder instance). At first this covered belts 4, hash 1, puts 3 and worldgen 1, about 0.2 s under Node (belts 33 ms, worldgen 69 ms, puts 27 ms, hash 14 ms). Review fixes 3 narrowed it.
- **`fx-machines` was excluded at first** (a `NOT_YET_REPLAYED` set, since deleted: see Review fixes 1). All four of its goldens disagree with its own `.wasm` under Node: `place-border` gives `a5038f1aa5ae8d03` against the checked-in `58cf4dd2cba3ea96`, `full-world` `55f8ba894f15fa46`, `smelt-cycle` `6b98341e7b92da4d`, `idle-world-costs-zero` `660ca72a501daaee`. Its native test passes only because it omits `Connected`. With `Connected` added to the native script, the native hashes equal the `.wasm` ones exactly (checked, then reverted), so the goldens predate the roster bit `Connected` sets (0024 §8). This is not a determinism fault. The fix needs a decision: re-bless with `pnpm golden machines`, add `Connected` to `fixtures/machines/tests/golden_scenarios.rs`, then remove the exclusion.
- `scenario.ts`'s `runScriptScenario` doc comment now says that `Connected` changes `state_hash()` through the roster bit.
- *Inject-fail-revert:* `golden-big-step.json` with `...aa81` changed to `...aa80` turned both legs red. Node: "belts/golden-big-step.json: checkpoint 0: got fec39527c906aa81, golden has fec39527c906aa80". Bun: "checkpoint 0: got fec39527c906aa81, golden has fec39527c906aa80". After the revert `wasm -t determinism` passes 29 tests.
- `scripts/suites.mjs`'s Bun `tests` list still names only `determinism: bun matches golden`. `-t determinism` runs the new Bun results, but `-t belts` skips the Bun leg.

**Review fixes (`m42b-review.md`, decisions of 2026-10-11).**
1. *`fx-machines` replays cross-runtime.* Its native leg (`fixtures/machines/tests/golden_scenarios.rs`) omitted `Connected`. Its four goldens therefore agreed only with that leg, while the `.wasm` gave other hashes. The sim did not change; the native leg was wrong. `Connected` was added after each `Joined`, `pnpm golden machines` regenerated the goldens, the native tests are green, and the Node and Bun legs replay all four. `NOT_YET_REPLAYED` is deleted. Old -> new hashes:

   | Golden | Old | New |
   |---|---|---|
   | `golden.json` (place-border) | `58cf4dd2cba3ea96` | `a5038f1aa5ae8d03` |
   | `full-world` | `a813319e1e3ca417` | `55f8ba894f15fa46` |
   | `smelt-cycle` | `10e42f7b444fb9cc` | `6b98341e7b92da4d` |
   | `idle-world-costs-zero` | `ee2e53b50bc029ab` | `660ca72a501daaee` |
2. *`deadend-backup` sees landings.* At `period` 256 and 600 both lanes were already packed 64 apart, so they stopped all at once at tick 60 with no squash. The spawners are now 1000 and 1500 (sparse). Every tick the test checks conservation and that every gap on a lane, across the `Next` boundary included, is at least `SPACING`. Tick 75's positions are pinned (mid-squash on both lanes: chain 0 `[0, 64, 128, 192, 256, 336, 432, 528, 624, 720]`, chain 2 `[48, 192, 336, 480, 624]`, chain 3 `[0, 64, 128, 192, 296, 440]`). The tick-300 at-rest check is unchanged. The new golden is `806c734f63e1daf0`. Inject-fail-revert: `insert_back` landing `len - speed + 1` now turns it red: "tick 75: positions mid-squash, chains 0-3", left `[[0, 64, 128, 192, 256, 337, 433, ...], ..., [49, 193, 337, 481, 625], [0, 64, 128, 192, 297, 441]]`.
3. *No duplicate replays.* The discovery legs skip the `<fixture>/<file>` pairs a named test already replays in that runtime (`REPLAYED_BY_NAME` in `scenario.ts`). Under Node that is hash, worldgen and puts' three scenarios; under Bun it is hash, worldgen and puts idle. So the discovery legs now run belts 4 + machines 4 under Node, and those plus puts `connected` and `script-a` under Bun.
4. *Docs.* Changes 2 and 3 above, `fixtures/belts/CLAUDE.md`, the header of `determinism.test.ts`, and `docs/architecture/testing-and-tooling.md` (the determinism-checks list and the goldens bullet: `golden*.json` per `scenario*.json`; a native leg must make the same calls) now describe the discovery leg.
5. *The 33rd `Chain`* creates nothing: with a full table, the request is despawned before `create`.
6. *Renamed* `transport_request_is_deferred_to_tick` to `transport_request_is_deferred_to_tick` (the earlier sections of this file keep the old name). Its doc says the debug assertion is what fails it, in the dev profile the `rust` suite builds.
7. *Spawner idle cost.* `put_entity` runs only when the spawner's state changed. A held refusal leaves it unchanged, so a backed-up spawner writes nothing. No golden moved: re-putting an identical value never changed the state hash. The stale comment saying a spawner's put wakes it is fixed (`TickCx` puts never auto-wake).

**Manager's gate and review (2026-10-11).** The brief's claim that the existing determinism test discovers fixtures was wrong (it read `fixtures/hash` only), so the follow-up added the discovery leg under Node and Bun; it exposed that `fx-machines`' four goldens matched only its native leg (which omitted `Connected`) and not the `.wasm`: the native leg was fixed and the goldens re-blessed with `pnpm golden machines` (old and new hashes above; the sim did not change, the native leg had). Adversarial review (an Opus reviewer, read-only): seven findings, all fixed in "Review fixes" (the machines leg; `deadend-backup` now pins mid-squash positions and per-tick spacing so a landing change reddens it, which the earlier inject could not; no duplicate replays; docs; the 33rd `Chain`; the test's name; the backed-up spawner writes nothing). The manager reran: `belts_golden` 4, `golden` 53, `pnpm test wasm` 195 tests in 2 s alone and 3 s inside the full run (budget 7 s), `pnpm lint` green, `pnpm golden belts` idempotent (the same four hashes), full `pnpm test` green at load 3.8. Noted, not fixed: the Bun leg's test names in `scripts/suites.mjs` are fixed strings, so `pnpm test wasm -t belts` skips the Bun leg while `-t determinism` and the plain suite run it.
