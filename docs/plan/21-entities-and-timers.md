# M21: Entity prototypes, footprints, occupancy and the state budget

Status: not started · After: 16 · Tyler-dependent: no

Split: the PLAN.md row for M21 is two subsystems. This brief lands the spatial half and the state-budget check. `21b-timers-wakeups-and-tickcx.md` lands the timer wheel, wake-ups, active lists, the completed `TickCx` and the undo-journal measurement. M22, M25 and M32 list 21b under After.

## Goal
A game registers entity prototypes (trait set + footprint). Spawning, moving and despawning a multi-tile entity updates occupancy in every overlapped chunk within the tick; `entity_at` and `traits_at` answer from it on the host and on a replica; delta scope and chunk snapshots follow the footprint. Before every `apply` the host runs the state-budget check with the per-action growth declaration.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0007-world-model.md` (§5 three structures, multi-tile entities; §6 traits; §8 state budget and the memory split)
3. `docs/decisions/0004-action-timing-and-rejection.md` ("State-budget check", pipeline step 4, `EngineReject`)
4. `docs/decisions/0023-action-growth-declaration.md`

Mine from spikes: `spikes/prediction-api` (`occupancy` derivation, `placement_is_trait_driven_*`, the furnace spanning a chunk border). Rules: `determinism.md`, `hot-paths.md`.

## Scope
- Prototypes: M07's `Registry::add_prototype(TraitSet, Footprint) -> PrototypeId` becomes live: called from `Game::register`, footprint asserted ≤ chunk edge (0007 §5), `Game::prototype(e)` consulted on every entity put.
- `ChunkIndex` per 0007 §5 (occupancy bitset, sorted `(index, EntityId)`, overlapping ids); derived, never encoded or hashed, rebuilt by `Store::rebuild_indexes()` after decode. Lives in `Store` so host and replica share it.
- `Store::apply` for `EntityPut`/`EntityGone` maintains every overlapped `ChunkIndex`, including a put that changes anchor or prototype.
- `WorldRead::entities_in(&self, rect: TileRect, f: &mut dyn FnMut(EntityId, &G::Entity)) -> Result<(), Unknown>`: the `Authority`/`Store` side, over `ChunkIndex`: each entity whose footprint intersects `rect` once, ascending `EntityId`, ids collected into a reused scratch vector (no allocation after warm-up); on a replica `Err(Unknown)` before any callback if `rect` touches a chunk that is not held. M25 adds the overlay merge.
- `WorldRead::entity_at` real; `traits_at` adds the occupant prototype's traits (0007 §6); on a replica both are `Unknown` if the tile's chunk is not held.
- `Authority` scope for entity deltas = every chunk under the old and new footprint (`Scopes`, ≤ 4 each). M15's frame builder already dedups by id and sends `Gone` on scope loss; M14's `encode_chunk_snapshot` now includes every entity overlapping the chunk; hashing ownership stays with the anchor chunk.
- **Overlap policy:** the engine does not reject overlapping placements (puts are infallible). Debug builds panic on a put whose footprint covers a tile occupied by another id; the game prevents it by asking `traits_at` for its `NOT_BUILDABLE`-style bit.
- **State-budget check** in `Host`/`Sim::step` before `apply`, per 0023: `Game::growth`, `Growth`, saturating headrooms, audit after `apply`, counter `growth_violations`; plus the id-exhaustion clause of 0022 §2 in the same check. `WorldParams` budget fields become live; init check of the 0007 §8 memory split against the arena with real `size_of` (clean startup error, status code from `engine_init`).
- Fixture `packages/engine/fixtures/machines/`: 2×2 `Machine { origin, fed, done_at, count }`, water base tile with `NOT_BUILDABLE`, prototype with the same bit; actions `Place { origin }`, `Feed { at }`, `Remove { at }`; `growth` declared; no tick rule yet (21b).

## Non-scope
Timers, wake-ups, active lists, `TickCx` additions, undo journal (21b). Predicted placement and ghosts (M25, M33). Sprites for entities (M17b). The prediction-overlay merge of `entities_in` (M25). Overlay promotion to dense and bucketed area effects: not scheduled (0007 Consequences: no v1 rule needs them). Entity id layout: fixed by 0022, built in M12.

## Files, packages and crates touched
`packages/engine/crates/engine` (`store/index.rs`, `registry`, `authority`, `host/budget.rs`), `packages/engine/fixtures/machines`, `.claude/skills/add-action-type`.

## Seams
**Provides:** `ChunkIndex`, `Store::rebuild_indexes`, working `entity_at`/`traits_at`, `WorldRead::entities_in` (`Authority`, `Store` and replica side; M25 adds the overlay merge), footprint `Scopes`; `Game::growth`, `Growth`, `EngineReject::StateBudgetFull` raised for real, counter `growth_violations`, init status `BudgetExceedsArena`; fixture `machines`; goldens `machines/place-border`, `machines/full-world`; `testkit::fill_world(entities, tiles)` (bench-style genesis that M36's standard large save reuses).
**Consumes:** M12 `Store`, `Game::{prototype, anchor}`; M12b `Authority`, `Sim`; M15 frame builder and `Replica`; M14 `encode_chunk_snapshot`; M16 admit/apply pipeline and `onActionResult`; M07 `Registry::{add_prototype, prototype_traits, footprint, tile_traits}`, `Footprint`, `PrototypeId`, `TraitSet`, `TileRect`.

## Planning decisions
- **Per-action growth declaration (PRE-PLAN §10):** decided in `0023-action-growth-declaration.md`; this milestone implements it and adds a "declare `growth`" step to the `add-action-type` skill.
- **Occupancy is derived state in `Store`, not sim state.** 0007 §5 says "derived from entities, rebuilt on load"; keeping it out of the encoding means heavy mode (M22) proves the rebuild is complete.
- **No engine-side placement rejection.** Rejection belongs to `apply` (one code path for host, replay, prediction); the engine only asserts in debug. Rationale: an engine reject inside a put would be a fallible put.
- **Anchor hook:** uses `Game::anchor` (0024 §7, declared in M12).

## Order of work
1. prototypes in `Registry`. 2. `ChunkIndex` + `Store::apply` maintenance + rebuild. 3. reads. 4. footprint scopes, snapshot inclusion, loopback tests across a chunk border. 5. budget check + growth + audit + init check. 6. fixture scenarios and goldens.

## Tests added
Rust: `entities_in_visits_each_once_in_id_order` (a border machine under a rect that covers two of its chunks; `Unknown` on a replica at the subscription edge), `footprint_sets_every_overlapped_chunk`, `despawn_clears_all_chunks`, `move_updates_old_and_new`, `entity_at_any_covered_tile`, `placement_is_one_trait_query` (water and another machine, same bit), `index_rebuild_equals_incremental`, `footprint_larger_than_chunk_panics_at_register`; loopback: `border_machine_delivered_once_to_partial_subscriber`, `border_machine_gone_when_last_overlapped_chunk_leaves`, `replica_traits_at_matches_host`; budget: `full_world_rejects_place_accepts_remove_then_place` (the second half 0023 adds to the 0003 scripted list), `undeclared_action_uses_max_action_growth`, `budget_verdict_replays_identically`, `growth_declarations_are_honest` (audit on, all `machines` scripts), `under_declared_growth_panics_in_debug`, `init_rejects_budget_over_arena`. Browser: none new (the slice test keeps passing).

## Exit criteria
- [ ] All tests above pass; goldens regenerated by command.
- [ ] `full_world_*` runs in under the 0020 §4 fast-tier p95 (use `testkit::fill_world` with small configured budgets, not the defaults).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t footprint` · `pnpm test rust -t budget` · `pnpm test rust -t machines` · `pnpm lint`.

## Budgets
Memory per instance row: `init_rejects_budget_over_arena` and the computed split logged once at init. Tick time row: occupancy maintenance is O(footprint), asserted by a counter `index_ops_per_put ≤ footprint area + 4`.

## Context artifacts
`add-action-type` skill: add "declare `growth`" and "ask the tiles, do not name tile types". Crate `CLAUDE.md`: what is derived (indexes) vs state.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
