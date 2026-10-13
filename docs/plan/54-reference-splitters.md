# M54: Reference game: splitters

Status: not started · After: 53b · Tyler-dependent: T (the **(assumed)** Splitters line: 128/128 halves, a per-input toggle, no buffer; questions 11 and 12 below, proceeding on their defaults)

Rewritten on 2026-10-12 against the code as built (the manager's survey `m54-research.md` in the session scratchpad): the engine's `Fork` maps the README's per-input alternation one to one; a 2x1 footprint needs two prototypes by axis with the anchor at the min corner; M52's topology assumes one belt per tile; two inputs sharing outputs can starve one of them under saturation; rotation of a placed 2x1 needs a rule.

## Goal
A 2x1 splitter entity (`BeltKind::Splitter`): each half's two lanes are an input line of 128 positions forking onto the two output halves' same lane (128 each): one sub-splitter per input lane, alternating 50/50 with the engine's toggle, a blocked side routing to the other, both blocked waiting; placed, rotated (180° in place) and picked up like a belt from construction mode with a 2x1 ghost; its output halves count as inputs for the belts in front (R7) and its long sides connect to nothing; generated art per facing; native, netcode and browser tests; items drawn on it by `draw_items` with no splitter code.

## Read first
1. `games/reference/README.md` ("Belts": Feature set, Splitters, Placement, Art), `/Users/tyler/repos/belts/docs/03-belt-shapes-and-connections.md` §4.2 and §7, `/Users/tyler/repos/belts/docs/06-splitters.md` (what Factorio does and what the README simplified)
2. `docs/decisions/0079-transport-core-decisions.md` §11, §15, §20 (b), §21; `docs/decisions/0076-*.md` §4, §9
3. `docs/plan/52-reference-belt-topology.md` and `53b-*.md` Deviations (the topology's run model, `inputs_of`, `Link`, `lanes_at`, the lane convention, the test hook, how spawners are kept out of `link`)
4. `games/reference/sim/src/{lib.rs, content.rs, rules/belts/topology.rs, rules/belt.rs, rules/place.rs, client.rs}`, `games/reference/src/ui/build.ts`, `scripts/gen-assets.mjs`, `sim/tests/{topology.rs, common/mod.rs, sprites_manifest.rs}`, `packages/engine/fixtures/belts/tests/golden_scenarios.rs` (the fork goldens), `packages/engine/crates/engine/src/transport/{mod.rs (Fork, set_out), advance.rs (the fork hand-off), surgery.rs (redirects)}`.
Rules: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md`. Skills: `add-action-type` (no new action: `PlaceBelt { kind: Splitter }` reuses the three), `run-tests`.

## Scope
- **Entity.** `BeltKind::Splitter` on `RefEntity::Belt`; `origin` is the footprint's min corner (the engine's anchor rule), the halves derived from `dir` (facing east or west the footprint is 1 x 2 and the left half along `dir` is the north tile for east, the south tile for west; facing north or south it is 2 x 1); two prototypes `SPLITTER_PROTO_EW` (id 2, `{1, 2}`) and `SPLITTER_PROTO_NS` (id 3, `{2, 1}`), traits `NOT_BUILDABLE`; `can_place` over the footprint with `BELT_FORBIDS` (no splitter on a resource). `shape` and `spawn` are unused for a splitter (`put_shape` skips it; `SetSpawner` rejects `NotASpawner`). `SCHEMA_VERSION` 10 (11 under `test-hooks`).
- **Rotation (question 12, default).** `RotateBelt` on a placed splitter turns it 180° in place (`dir` → its opposite; the footprint and anchor unchanged, so 0079 §20 (b) holds by construction and nothing is re-validated); changing the axis is pick-up and re-place. The tool's direction before placement cycles all four (the ghost shows the 2x1 footprint for the axis). Items on its lines are destroyed by rotation and pick-up (question 10).
- **Topology.** A splitter is a run boundary with eight own lines, never joined or rescaled: per half, per lane, an input line (from the midline to the back edge, 128) and an output line (from the front edge to the midline, 128), the input line's output `Fork{a: the left half's output lane k, b: the right half's}` (`a` the left half along `dir`: Factorio's first item goes right is not copied; pinned); a belt behind a half feeds its input lanes (`Next`, lane for lane); a half's output feeds the tile in front by C1-C4 (`Next`, a curve's sole side input, `Merge` by R7, or `DeadEnd`); anything pointing into a long side is `DeadEnd` (the README; measured `q15_splitter_long_side`); `inputs_of` treats a splitter half as a feeder like a belt (§4.2); `mapped`/`classify`/`want`/`lanes_at` gain the splitter branch (`splitter_lanes(half) -> { in: [LineId; 2], out: [LineId; 2] }`, in vs out by segment start); `on_wake` reconciles both halves' neighbours and the outputs diamond over both; `assert_topology` counts a splitter's eight lines and checks every fork's targets; the test hook addresses a splitter line by half and in/out.
- **Client and UI.** `apply_tap` matches a splitter by its footprint for `dir`; the ghost is a cursor-anchored 2x1 sprite tinted by `can_place` over the footprint; `Tool::Belt(Splitter)` through `BeltKind`; `build.ts` `TOOL.SPLITTER` (5; `content::local` mirrored), the palette button, the `FOOTPRINT` table keyed by tool and direction (Confirm at `(x + w/2, y + h)`), the popover's Rotate (180°) and Pick up.
- **Art.** Three sprites appended (ids 22, 23, 24): east `size [1, 2]`, south and north `[2, 1]`, 8 frames, pivot `[0, 0]`; west = east + `FLIP_X` (the art symmetric between halves); `sprites_manifest.rs` extended (names `splitter/<facing>`, the row rule adjusted); `belt-races.test.ts`' sprite ranges updated.
- **Tests.** Rust (`sim/tests/splitter.rs`): `splitter_maps_eight_lines` (lines, lengths 128, segments, four forks with exact targets, lane for lane, both halves), `splitter_long_side_is_dead_end`, `splitter_output_half_feeds_front` (Next / curve / Merge / DeadEnd cases), `splitter_50_50` (test-hooks items through one input over 1,000 ticks: the counts at both outputs within the engine's `fork-50-50` rule, `da-db ∈ {0,1}`, exact), `splitter_blocked_side` (one output blocked: everything to the other; the toggle holds), `splitter_two_inputs` (both inputs saturated, one output blocked: the measured per-input share recorded, not asserted beyond determinism: question 11), `splitter_rotate_180_in_place` (anchor and footprint unchanged, `dir` flipped, lines re-created, items destroyed), `splitter_pickup_unmaps_eight_lines`, `splitter_place_rules` (resource, furnace, belt under either tile rejected; a belt into the long side gets `DeadEnd`), `idle_belts_cost_nothing` with splitters in `KINDS`, `topology_random_edits_stay_canonical` placing splitters too, `no_reference_entity_moves_in_a_tick` with footprints checked. Netcode: `reference_splitter_same_tiles_race` (two players, overlapping footprints, one `NotBuildable`), `reference_splitter_topology_converges` (structures equal on two replicas incl. the forks). Browser: `reference_splitter_place_rotate_pickup` (palette tool, 2x1 ghost, place, popover Rotate flips the sprite, Pick up empties both tiles), `reference_splitter_touch_confirm` (Confirm under the 2x1 footprint for both axes). Golden: `fullGame()` gains a splitter in the belt passage; `golden:record` once with the diff stated; moved rows re-pinned with derivations.
- Docs: `games/reference/README.md` "Not implemented" (splitters built; undergrounds remain), `CLAUDE.md` (the splitter's prototypes and lane layout), the belts tests' CLAUDE.md lines.

## Non-scope
Input fairness across two inputs (question 11: recorded here, measured by M56's saturated-splitter scenarios, an engine "input turn" if Tyler wants Factorio's 50/50 across inputs); the client following forks (every fork crossing is an `Arrival`: M56 measures balancers against 0078 A5); undergrounds (M55); a migration.

## Files touched
`games/reference/sim/src/{lib.rs, content.rs, client.rs, rules/belt.rs, rules/place.rs, rules/belts/topology.rs}`, `sim/tests/{splitter.rs (new), topology*.rs, belt.rs, sprites_manifest.rs, common/mod.rs}`, `src/ui/build.ts`, `src/test-entry.ts`, `tests/helpers/{game,script}.ts`, `tests/browser/belt-construction.spec.ts` or `splitter.spec.ts`, `tests/netcode/{belt-races,belt-topology}.test.ts`, `scripts/gen-assets.mjs`, `assets/sprites.{png,json}`, `tests/golden/full-game.{log,json}`, `src/bindings/*.ts`, `README.md`, `CLAUDE.md`, `packages/engine/budgets.json` (re-pins with derivations only).

## Planning decisions
- **One `Fork` per input lane** is the README's rule, not Factorio's shared output toggle; the fork goldens already prove the alternation and the blocked side.
- **Rotation is 180° in place** (question 12's default): the only rotation that never moves a footprint, so 0079 §20 (b) holds by construction and no self-occupancy case exists in `can_place`.
- **Input fairness is recorded, not built** (question 11): two saturated inputs with a blocked output starve one input by update order; Factorio is 50/50; the README says nothing. M56's scenarios measure it; an engine input turn is the fix if Tyler wants it.
- **Fork `a` is the left output half along `dir`**, pinned, so the first item's side is a stated rule.

## Order of work
1. Entity, prototypes, placement, 180° rotation, pick-up; the client's tap and ghost; `SCHEMA_VERSION` 10; the place/rotate/pickup Rust tests.
2. Topology: eight lines, forks, the long-side rule, `inputs_of`/`fix_output`/`lanes_at`/`assert_topology` branches; the mapping tests; `idle_belts_cost_nothing`, the random-edit test, the moves test extended.
3. Items: `splitter_50_50`, `_blocked_side`, `_two_inputs` (test-hooks leg).
4. Art, manifest test, `build.ts` tool and `FOOTPRINT`, browser tests, netcode tests, the golden passage, docs, Deviations.

## Exit criteria
- [ ] The Rust tests above pass with an inject-fail-revert each; `idle_belts_cost_nothing`, the random-edit and moves tests hold with splitters.
- [ ] The netcode and browser tests pass; the golden has the splitter passage (reviewed diff).
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow rust` (the `test-hooks` leg) green; `belts-tick` within noise of 0.2146 ms.

## Verification commands
`cargo nextest run -E 'package(reference-sim)'` · `pnpm test rust -t splitter` · `pnpm test:slow rust -t splitter` · `pnpm test netcode -t reference_splitter` · `pnpm test browser -t reference_splitter` · `pnpm test wasm -t reference` · `pnpm test && pnpm lint`

## Budgets
`SCHEMA_VERSION` 9 → 10; the action-log and downlink rows if the passage moves them; `belts-tick` 0.2146 ms (engine untouched).

## Deviations
(filled in during execution)
