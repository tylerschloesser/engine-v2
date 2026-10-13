# M52: Reference game: belt topology (lines mapped on the host tick)

Status: not started · After: 51b · Tyler-dependent: T (the **(assumed)** Shape and Side-loading lines, proceeding on their defaults; new question 10: whether rotation keeps a tile's items, default destroy)

Rewritten on 2026-10-12 against the code as built (the manager's survey `m52-research.md` in the session scratchpad: a despawn wakes nothing, so a pick-up never reached the tick; the furnace rule drains every wake; nothing outside the tick can insert an item for a test; `rescale` is whole-line and a line holds at most 16 segments; the golden passage needs M51b's script steps). The shape rules are `/Users/tyler/repos/belts/docs/03-belt-shapes-and-connections.md` §4-§5, §8-§9 (R1-R8, C1-C4, verified in Factorio 2.0.77), summarised in `games/reference/README.md` "Belts" (Shape, Side-loading).

## Goal
Placed belts become engine lines: the game's host tick rule maps every woken belt (placed, rotated, picked up, or reshaped by a neighbour) onto the engine's lines by R1-R8 and C1-C4: one line per lane per maximal straight run, each curve tile its own pair of single-arc lines (106 / 295), straight-through chains joined, splits on removal, side-loads wired as `Merge` at the geometric entry points (64 and 192 from the target tile's front), head-on and unconnected fronts `DeadEnd`; the entity's derived `shape` put for rendering; an idle mapped world costs nothing per tick; the full-game golden gains a belt passage. Items are not created yet (M53), but the surgery keeps them (rescale and join) wherever a test injects them.

## Read first
1. `docs/architecture/README.md`
2. `games/reference/README.md` ("Belts": Numbers, Lanes, Shape, Side-loading, Placement), `/Users/tyler/repos/belts/docs/03-belt-shapes-and-connections.md` §4.1-4.2, §5, §8, §9, `/Users/tyler/repos/belts/docs/dev/undergrounds-curves.md` "Shapes"
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§3, §4, §6, §9), `docs/decisions/0079-transport-core-decisions.md` (§8-§14: speed vs length, cut/join, rescale keeps squashed pairs, segments and the tile index; §20 (b))
4. `packages/engine/crates/engine/src/transport/{mod.rs (the write API), surgery.rs, geometry.rs}`, `packages/engine/fixtures/belts/src/lib.rs` (`Op::*` → API; the `geometry-arc` and side-load goldens in `fixtures/belts/tests/golden_scenarios.rs`), `games/reference/sim/src/{lib.rs, rules/belt.rs, rules/furnace.rs, client.rs}` (M51), `sim/tests/common/mod.rs` (`RefScenario`), `tests/helpers/script.ts` (M51b's belt steps).
Rules: `.claude/rules/determinism.md`, `.claude/rules/prediction.md` (the mapping runs in `tick`; `apply` writes the entity only). Skills: `run-tests`.

## Scope
- **The tick dispatch.** `rules::tick` drains `next_woken`/`next_due` once and dispatches by variant: furnaces to `furnace::advance` (unchanged), belts to `topology::on_wake`. A despawn wakes nothing, so `PickUpBelt`'s `apply` no longer despawns: it puts the belt with `removing: true` (a new `Belt` field; `SCHEMA_VERSION` 8 / 9 under `test-hooks`; a removing belt is drawn as nothing, taps ignore it, `can_place` treats its tile as occupied until it is gone), and the tick unmaps its lines, reshapes its neighbours and despawns it in the same tick (0079 §20 (b): the entity never moves).
- **The mapping (`rules/belts/topology.rs`).** For a woken tile P: compute `inputs(P)` from the three neighbours (`entity_at` x3; a neighbour feeds P iff it is a belt whose front is P and P accepts from that side: C1, R6), `shape(P)` by R1-R5, then P's output by C1-C4 (`Next` into the front belt's lanes when P feeds its back or is a curve's sole side input; `Merge{near lane, at}` when the front is straight with another input, `at` = the target tile's offset in its line + 192 for the feeder lane nearer the target's back and + 64 for the other; `DeadEnd` otherwise); then the same for P's front tile (its inputs changed) and for every feeder of P and of P's front whose output kind changed. Lines: **one line per lane per maximal straight run** (a run of straight tiles each feeding the next by `Next`: one straight segment from the run's back edge to one position before its front edge, so no index entry lands in the tile in front), **a curve tile is its own pair of single-arc lines** (106 inner / 295 outer, the arc about the inner corner, radii 0.5 ∓ 60/256 tiles; the inner lane is the lane on the turn side), joined to its neighbours by `Next`; a tile entering a run joins (`join` after `set_out(Next)`; `extend_*` when it is the run's new end), a tile leaving splits (`split` at its offset, then `destroy` the one-tile line), a straight ↔ curve reshape splits the tile out, `rescale`s its two lines (256 ↔ 106/295, items kept by `floor(pos*new/old)`), re-registers segments and joins what is end-to-end again. Every `len` change re-registers the run's segments (the engine clears them). Lane 0 is the lane on the belt's left seen along `dir`, lane 1 its right; a `Next` keeps lanes; a `Merge` sends both feeder lanes to the target's near lane. A closed loop keeps its last link as `Next` (the engine refuses `join` across a cycle; 0079 §11). Head-on belts: `DeadEnd` both ways.
- **Shape in `apply` too.** `PlaceBelt` and `RotateBelt` compute the placed tile's own shape from its neighbours in `apply` (reads only, `?` on each) and write it in the same put, so a predicted belt shows its curve at once; neighbours' shapes are the tick's (a brief flip on them until the host's put: recorded).
- **Rotation and items (question 10, default):** a rotated tile's lines are re-created and the items on that tile are destroyed (the lane geometry has no mapping across a turn); pick-up destroys the tile's items (README Placement). Both through `destroy`'s item callback (nothing to count until M53).
- **Test hook.** Under `test-hooks` only: `RefAction::TestInsertItem { at, lane, pos, item }` applied on the tick through a request-style put (the belt entity itself: a `test_insert: Option<(u8, u16, u8)>` field would widen the schema for a never-shipped build: instead the hook spawns and despawns a one-tick `RefEntity::TestRequest` variant behind `#[cfg(feature = "test-hooks")]`: appended last; the shipped enum is unchanged). `build-game-features` already fails a shipped build with the poison.
- **Tests** (`sim/tests/topology.rs`, `topology_items.rs` under `test-hooks`): the R1-R8 table (every input set x the four directions, shape and output pinned exact), C1-C4 (each front case: `Next`, `Next` into a curve, `Merge` at 64/192 on the near lane, `DeadEnd` for empty, furnace, head-on), a chain of 20 tiles is two lines of 5,120 with one segment each, removing the middle tile splits into two pairs and placing it back joins (ids, lengths, segments pinned), a curve's lanes are 106 and 295 with their arcs pinned, a reshape (a second input placed beside a curve) rescales 106/295 → 256 with injected items at `floor(pos*256/106)` and keeps a squashed pair, rotation destroys the tile's items and re-creates its lines, pick-up unmaps in one tick (no line survives, the entity is gone, no chunk stamp twice: the chunk version moves once), `no_reference_entity_moves_in_a_tick` re-pointed (shapes now vary), `idle_belts_cost_nothing` extended (a mapped world of 1,000 belts with curves and side-loads: no visit, no put, the same hash over 1,000 ticks), `lines_at` on the tile in front of a run reports nothing (the edge rule), the tick's surgery count per edit pinned for one placement into a 20-tile run (so the O(lines)+O(index) cost stays visible). Netcode: `reference_belt_topology_converges` (two clients place a 10-tile chain with a curve and a side-load; structures equal on both replicas; `lineStructures`).
- **Golden.** `fullGame()` gains a belt passage using M51b's steps (place a 6-tile run with a curve and a side-loading feeder, rotate one, pick one up); `golden:record` once; the `.log` and `.json` diffs reviewed and stated; the action-log and downlink rows re-pinned if they move (with the derivation).
- Docs: `games/reference/README.md` "Not implemented" (topology built; items M53), `games/reference/CLAUDE.md` (the tick dispatch, the topology module, the test hook, lane naming), `docs/architecture/README.md` if it names the reference game's tick rules.

## Non-scope
Items, spawners, despawners, `set_spawner` (M53); splitters (M54; the first 2x1 entity, 0079 §20 (b)); undergrounds (M55); a per-chunk bucketed tile index (0079 §14 decides on the measured placement tick); a migration for schema 7 saves.

## Files, packages and crates touched
`games/reference/sim/src/{lib.rs, rules/mod.rs, rules/belt.rs, rules/belts/topology.rs (new), rules/furnace.rs (the drain moves to rules::tick), client.rs (removing belts drawn as nothing; taps)}`, `sim/tests/{topology.rs, topology_items.rs (new), belt.rs, belt_predict.rs, common/mod.rs}`, `tests/helpers/script.ts` (the passage), `tests/golden/full-game.{log,json}`, `tests/netcode/belt-topology.test.ts` (new), `src/bindings/*.ts` (regenerated), `README.md`, `CLAUDE.md`, `packages/engine/budgets.json` (only if a row moves, with the derivation).

## Seams
**Provides:** `rules::belts::topology::{on_wake, inputs, shape_of, output_of}`, `Belt.removing`, `RefEntity::TestRequest` (test-hooks), the lane convention, the golden passage. **Consumes:** M43/M44 surgery and geometry, M51 entities and `RefScenario::{place,rotate,pick_up}_belt`, M51b's script steps.

## Planning decisions
- **Runs are lines; curves are their own lines.** A joined line would need a range rescale the engine does not have and holds 16 segments at most; cutting at every curve keeps every line one segment (one straight or one arc), every reshape local (split, rescale, join around one tile), and the item hand-off cost confined to curves. 0076 §4's "curves are one arc segment per lane" holds per curve line.
- **Pick-up is a two-step put** because a despawn wakes nothing and the tick must unmap; the client hides a removing belt so the player sees it vanish at the tap (predicted).
- **Shape is derived twice**: in `apply` for the edited tile (prediction) and in `tick` for everyone (authority); both read the same rule, and the tick's put is the one that counts.
- **A test hook, not an engine hook,** gives tests items: the engine stays untouched and the hook never ships.
- **Rotation destroys items** until Tyler says otherwise (the README is silent; Factorio keeps them).

## Order of work
1. `rules::tick` dispatch; `Belt.removing`; `SCHEMA_VERSION` 8; the furnace suite green.
2. `topology.rs`: inputs/shape/output, runs and curves, join/split/reshape; the structural tests and the R1-R8 table; the edge rule.
3. Side-loads (`Merge` at 64/192), head-on, loops; C1-C4 tests; `apply`-side shape; `idle_belts_cost_nothing` extended; the surgery count pin.
4. `test-hooks` insert; the items tests (rescale, rotation, pick-up).
5. The netcode scenario; the golden passage; bindings; docs; Deviations (the placement tick's cost: surgery ops and µs per edit on a 1,000-belt world, for 0079 §14).

## Tests added
Rust: `topology_shape_table`, `topology_outputs_c1_c4`, `topology_run_join_split`, `topology_curve_lanes`, `topology_reshape_rescales_items` (test-hooks), `topology_rotate_destroys_items` (test-hooks), `topology_pickup_unmaps_in_one_tick`, `topology_front_edge_indexes_nothing`, `topology_surgery_count_per_edit`, `idle_belts_cost_nothing` (extended). Netcode: `reference_belt_topology_converges`.

## Exit criteria
- [ ] The tests above pass with an inject-fail-revert each; `no_reference_entity_moves_in_a_tick` still holds with curves.
- [ ] `idle_belts_cost_nothing` holds on a mapped world (no visit, no put per tick).
- [ ] The full-game golden has the belt passage, re-recorded once with the reviewed diff stated; any moved budget row re-pinned with its derivation.
- [ ] `pnpm test` and `pnpm lint` green; `belts-tick` within noise (engine untouched); the placement tick's cost recorded in Deviations.

## Verification commands
`cargo nextest run -E 'package(reference-sim)'` · `pnpm test rust -t topology` · `pnpm test:slow wasm -t test-hooks` (if the hook's build is covered there) · `pnpm test netcode -t reference_belt` · `pnpm test wasm -t reference` · `pnpm test browser -t determinism` · `pnpm test && pnpm lint`

## Budgets
`SCHEMA_VERSION` 7 → 8; the action-log and downlink rows if the passage moves them; `belts-tick` 1.2638 ms (engine untouched); the placement tick's cost recorded (no row yet: 0079 §14).

## Context artifacts
`games/reference/README.md`, `games/reference/CLAUDE.md`.

## Manual device checks
none (M57).

## Deviations
(filled in during execution)
