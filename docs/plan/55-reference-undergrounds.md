# M55: Reference game: undergrounds

Status: not started · After: 54 · Tyler-dependent: T (the **(assumed)** Undergrounds line, incl. "rotating an underground rotates that end only"; question 14 below, proceeding on its defaults)

Rewritten on 2026-10-12 against the code as built (the manager's survey `m55-research.md` in the session scratchpad): the hidden stretch is a separate segment-less line per lane that the engine never replicates, anchors, chunk-hashes or draws, so no engine change is needed; the sketch's "hidden segment flag" is dropped.

## Goal
Underground entrance and exit entities (`BeltKind::UndergroundIn` / `UndergroundOut`, one tile each, the direction the flow direction): an entrance pairs with the nearest same-facing exit within four empty tiles on its axis, a nearer new end steals the partner, an unpaired entrance backs up at its hood and an unpaired exit accepts nothing from behind; per lane the entrance's visible half (128), a hidden line of `(gap + 1) x 256` positions with no geometry, and the exit's visible half (128), linked by `Next`, so travel takes exactly the surface belt's time; side-loads onto the visible halves land through the hood filter; exits count as inputs for the belt in front; generated hood art; items on the hidden line are never drawn and surface at the exit as forecast `Arrival`s.

## Read first
1. `games/reference/README.md` ("Belts": Numbers (the halves and the hidden stretch), Undergrounds), `/Users/tyler/repos/belts/docs/03-belt-shapes-and-connections.md` §4.2, §6, `/Users/tyler/repos/belts/docs/dev/undergrounds-curves.md`, `/Users/tyler/repos/belts/docs/07-*.md` §3, §8 (Factorio's model and what the README simplified)
2. `docs/decisions/0079-transport-core-decisions.md` §13, §17 (what a segment-less line is to the replica), §20 (b), §21; `docs/decisions/0078-*.md` A8 (arrivals), A12
3. `docs/plan/52-*.md`, `53b-*.md`, `54-*.md` Deviations (the topology's kinds, run boundaries, `Form`, `mapped`, the hood/edge rules, the test hook's lane 2/3 addressing)
4. `games/reference/sim/src/{lib.rs, content.rs, rules/belts/topology.rs, rules/belt.rs, client.rs}`, `sim/tests/common/mod.rs` (`assert_topology_in`), `scripts/gen-assets.mjs`, `src/ui/build.ts`, `packages/engine/crates/engine/src/transport/{geometry.rs (set_segments with an empty list; a segment-less line's anchor/chunks), replicate.rs, mod.rs}`, `host/lines.rs` (a line without segments is never routed).
Rules: `.claude/rules/determinism.md`, `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md`. Skills: `run-tests`.

## Scope
- **Entities.** `BeltKind::UndergroundIn`, `BeltKind::UndergroundOut` (appended after `Splitter`), 1x1 on `BELT_PROTO`, `dir` the flow direction; `PlaceBelt { kind }`, `RotateBelt` (that end only: `dir.cw()`, the README's assumed line; a 90° turn unpairs) and `PickUpBelt` reused; two tools (`TOOL_UNDERGROUND_IN` 6, `_OUT` 7; `content::local` mirrored in `build.ts`); `SCHEMA_VERSION` 11 (12 under `test-hooks`). No partner id is stored: pairing is a pure function of the layout (0076 §4).
- **Pairing (`topology.rs`, in `on_wake`, never in `apply`).** From an entrance facing `d`, the first underground on the same axis within tiles 1..=5 ahead ends the search; it is the partner iff it is an exit facing `d`. Tiles between may hold anything; perpendicular undergrounds are transparent (question 14 (b), default). An edit on P reconciles P and every entrance whose five-tile ray contains P (both axes after a rotation). Per entrance: no partner → the hidden line is destroyed (its items with it: question 14 (c), default; the entrance's lanes become `DeadEnd` at the hood); a changed gap → the hidden line re-created at `(gap + 1) x 256` (its items destroyed) and the entrance's lanes re-pointed; a new partner → `Next` from the hidden line into the exit's lanes, lane for lane. An exit's own lines never change with pairing.
- **Lines.** Per lane: the entrance's visible half (128, one straight from the midline to the back edge, the edge rule), the hidden line (`create((gap + 1) x 256, 24)` with no `set_segments`), the exit's visible half (128, from the front edge to the midline); outputs entrance → `Next(hidden)` → `Next(exit lane)`. Undergrounds are run boundaries (`want` excludes them; `feeds()` false for an entrance; an exit a feeder for the belt in front: `Next` / a curve's sole side input / `Merge` / `DeadEnd` by C1-C4; `inputs_of` empty for both, always `Straight`); a same-facing belt behind an exit gets `DeadEnd`; `fix_output`'s `Next` arm handles a 128 target (a belt behind an entrance; an exit feeding the next entrance); side-loads onto the visible halves through the hood filter (entrance: landing L ≥ 128 → `Merge { at: L - 128 }` else `DeadEnd`; exit: L < 128 → `Merge { at: L }` else `DeadEnd`); `mapped`/`classify` gain `Form::Underground(dir, end)` by entity kind; the hidden lane is reached from the entrance lane's `Next`; destroying an entrance destroys its hidden line first; `assert_topology_in` models all of it (line count `2 x fronts + 2 x paired entrances`; hidden lines have no segments).
- **Rendering.** Six sprites after M54's (`underground_in` / `underground_out` x east, south, north; west = east + `FLIP_X`; the hood on the front half for an entrance, the back half for an exit); gap tiles draw nothing; items on hidden lines are never drawn (no geometry: `pos_to_world_slot` `None`); the manifest test extended; `belt_sprite` arms.
- **Tests.** Rust (`sim/tests/underground.rs`): `underground_pairs_nearest_exit` (gaps 0..4 pinned; a farther exit ignored; an exit facing the other way ignored; a perpendicular underground between is transparent), `underground_steal` (a nearer exit placed later takes the pair; an entrance placed between blocks the old one; removal restores: lines and `Next` targets pinned each step), `underground_unpaired_ends` (an entrance alone: `DeadEnd` at the hood, 2 items a lane with the test hook; an exit alone: the belt behind it `DeadEnd`), `underground_travel_time` (test-hooks: spawner → entrance → gap g → exit → despawner beside a plain run of g + 2 tiles: equal `sunk` ticks, `(g + 2) x 256 / 24`), `underground_capacity` (2 + 4(g + 1) + 2 items a lane at gap 4 = 44), `underground_sideload_hood` (L = 64 / 192 onto each half: `Merge` or `DeadEnd` per the filter, both directions of the edge rule), `underground_rotate_unpairs`, `underground_pickup_destroys_hidden` (no leaked line; `assert_topology`), `idle_belts_cost_nothing` with undergrounds in `KINDS`, the random-edit test placing undergrounds, `no_reference_entity_moves_in_a_tick`. Netcode: `reference_underground_items_emerge` (two clients: items vanish at the hood and surface at the exit; `arrivals_applied` equals the items emerged; replicas converge; the bytes of `Arrivals` over 200 ticks pinned for M56). Browser: `reference_underground_place_and_items` (place a pair with gap 2 through the tools, a spawner behind, a despawner ahead: no item sprite over the gap tiles while the host's hidden lines hold items; items on both visible halves). Golden: `fullGame()` gains an underground pair in the belt passage; `golden:record` once with the diff stated; moved rows re-pinned.
- Docs: `games/reference/README.md` "Not implemented" (every feature of the Feature set built; M56 scenarios, M57 measurements remain), `CLAUDE.md`, 0079 (the manager: the segment-less hidden line is sim state in the full hash and no chunk hash, never replicated; items surface as `Arrival`s; the cost for M56).

## Non-scope
A hidden `Geometry` variant or a one-line-per-pair form (M56's fallback if the `Arrival` bytes say so); Factorio's rotate-flips-both-ends; a pairing preview ghost; auto-flip of the tool.

## Files touched
`games/reference/sim/src/{lib.rs, content.rs, client.rs, rules/belt.rs, rules/belts/topology.rs}`, `sim/tests/{underground.rs (new), topology*.rs, belt.rs, sprites_manifest.rs, common/mod.rs}`, `src/ui/build.ts`, `src/test-entry.ts`, `tests/helpers/{game,script}.ts`, `tests/browser/underground.spec.ts` (new), `tests/netcode/belt-underground.test.ts` (new), `scripts/gen-assets.mjs`, `assets/sprites.{png,json}`, `tests/golden/full-game.{log,json}`, `src/bindings/*.ts`, `README.md`, `CLAUDE.md`, `packages/engine/budgets.json` (re-pins with derivations only).

## Planning decisions
- **Three lines per lane, the hidden one without geometry**: the engine already treats a segment-less line as sim state that no client holds, so the hidden stretch costs no engine change; items surface as `Arrival`s (about 165 B/s per saturated pair, 1 % of the soft cap: M56 measures with the fork arrivals).
- **Pairing is derived, never stored**, so a steal, a removal and a rotation reconcile from the layout alone, in the tick (prediction untouched).
- **A broken pair destroys the hidden items** (question 14 (c), default): Factorio keeps them in a length-1 stub; the README is silent; destroying is the rule already taken for rotation and pick-up (question 10).
- **Rotation turns one end** (the README's assumed line) even though Factorio flips both; **perpendicular undergrounds are transparent** (Factorio; the old TS sim blocked): question 14 for Tyler.

## Order of work
1. Kinds, tools, prototypes, sprites, the manifest test; the client's sprites; `SCHEMA_VERSION` 11.
2. Topology: `Form::Underground`, run boundaries, `feeds`/`inputs_of`/`output_of`/`fix_output` arms, the lines per lane, pairing in `on_wake` with the ray scan, destroy order; `assert_topology_in`; the pairing, unpaired, steal, rotate and pickup tests; the random-edit and idle tests.
3. Items: travel time, capacity, the hood filter (test-hooks leg).
4. Netcode and browser tests; the golden passage; docs; Deviations (the `Arrival` bytes figure for M56).

## Exit criteria
- [ ] The Rust tests above pass with an inject-fail-revert each; `idle_belts_cost_nothing`, the random-edit and moves tests hold with undergrounds; no leaked line in any test (`assert_topology`).
- [ ] The netcode and browser tests pass; the `Arrival` bytes per saturated pair recorded; the golden has the underground passage (reviewed diff).
- [ ] `pnpm test`, `pnpm lint` and the slow `test-hooks` leg green; `belts-tick` within noise of 0.2146 ms (engine untouched).

## Verification commands
`cargo nextest run -E 'package(reference-sim)'` · `pnpm test rust -t underground` · `pnpm test:slow rust -t underground` · `pnpm test netcode -t reference_underground` · `pnpm test browser -t reference_underground` · `pnpm test wasm -t reference` · `pnpm test && pnpm lint`

## Budgets
`SCHEMA_VERSION` 10 → 11; the action-log and downlink rows if the passage moves them; `belts-tick` 0.2146 ms (engine untouched).

## Deviations
(filled in during execution)
