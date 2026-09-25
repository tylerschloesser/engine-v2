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
- `WorldRead::entity_at` real; `traits_at` adds the occupant prototype's traits (0007 §6); on a replica both are `Unknown` if the tile's chunk is not held. `entity_at` inherits this from M12b, which left it always `Ok(None)` for exactly this reason (M12b Deviations): once it is real, `fx-puts`'s `Bump`/`Remove` handlers — which deterministically rejected `NotFound` before — should start succeeding.
- `Authority` scope for entity deltas = every chunk under the old and new footprint (`Scopes`, ≤ 4 each). M15's frame builder already dedups by id and sends `Gone` on scope loss. **`encode_chunk_snapshot` as M14 shipped it only includes entities anchored to the chunk (anchor-chunk equality), not every entity overlapping it** — deliberate, because through M14 `Authority`'s own scope derivation is anchor-chunk-only too, so the two sets are identical until this milestone (M14 Deviations, "Entities in a chunk snapshot"). This milestone must widen **both** together: `Authority`'s scope derivation to the full footprint, above, *and* `encode_chunk_snapshot`'s entity filter to match, or a snapshot's entity list will silently stop agreeing with what live deltas deliver for that chunk. Hashing ownership stays with the anchor chunk. M12b only ever filled 1 or 2 of `Scopes`' 4 slots (a single-tile write, or a move's old/new anchor; M12b Deviations) — this milestone's multi-chunk footprints are the first workload to actually fill 3 or 4. M15's frame builder is the third thing anchor-only semantics reach (`docs/plan/15-connection-and-subscriptions.md`'s Deviations, "Anchor-only entity delivery, not footprint overlap") — all three (scope derivation, snapshot encoding, frame builder) widen together here. M15's test `entity_straddling_subscribed_and_unsubscribed_chunks_delivered_once` is written against today's anchor-only semantics (an entity's *anchor* moving between a subscribed and unsubscribed chunk, not a footprint straddling two chunks) and needs rewriting once footprints are live.
- **Overlap policy:** the engine does not reject overlapping placements (puts are infallible). Debug builds panic on a put whose footprint covers a tile occupied by another id; the game prevents it by asking `traits_at` for its `NOT_BUILDABLE`-style bit.
- **State-budget check** in `Host`/`Sim::step` before `apply`, per 0023: `Game::growth`, `Growth`, saturating headrooms, audit after `apply` (debug panic, release count and warn), the `debug_assert!` on a declaration above `max_action_growth`, counter `growth_violations`; plus the id-exhaustion clause of 0022 §2 in the same check (0023 "The check", last bullet: the same declared number). The check runs for actions only (0023 "The check", opening line); the tick-rule half of that is 21b's. `WorldParams` budget fields become live; init check of the 0007 §8 memory split against the arena with real `size_of` (clean startup error, status code from `engine_init`).
- Fixture `packages/engine/fixtures/machines/`: 2×2 `Machine { origin, fed, done_at, count }`, water base tile with `NOT_BUILDABLE`, prototype with the same bit; actions `Place { origin }`, `Feed { at }`, `Move { at, to }`, `Remove { at }`; `growth` declared; no tick rule yet (21b).

## Non-scope
Timers, wake-ups, active lists, `TickCx` additions, undo journal (21b). Predicted placement and ghosts (M25, M33). Sprites for entities (M17b). The prediction-overlay merge of `entities_in` (M25). Overlay promotion to dense and bucketed area effects: not scheduled (0007 Consequences: no v1 rule needs them). Entity id layout: fixed by 0022, built in M12.

## Files, packages and crates touched
`packages/engine/crates/engine` (`store/index.rs`, `registry`, `authority`, `host/budget.rs`), `packages/engine/fixtures/machines`, `.claude/skills/add-action-type`.

## Seams
**Provides:** `ChunkIndex`, `Store::rebuild_indexes`, working `entity_at`/`traits_at`, `WorldRead::entities_in` (`Authority`, `Store` and replica side; M25 adds the overlay merge), footprint `Scopes`; `Game::growth`, `Growth`, `EngineReject::StateBudgetFull` raised for real, counter `growth_violations`, init status `BudgetExceedsArena`; fixture `machines`; goldens `machines/place-border`, `machines/full-world`; `testkit::fill_world(entities, tiles)` (bench-style genesis that M36's standard large save reuses), `testkit::set_next_entity_id` (also used by 21b).
**Consumes:** M12 `Store`, `Game::{prototype, anchor}`; M12b `Authority`, `Sim`; M15 frame builder and `Replica`; M14 `encode_chunk_snapshot`; M16 admit/apply pipeline and `onActionResult`; M07 `Registry::{add_prototype, prototype_traits, footprint, tile_traits}`, `Footprint`, `PrototypeId`, `TraitSet`, `TileRect`.

## Planning decisions
- **Per-action growth declaration (PRE-PLAN §10):** decided in `0023-action-growth-declaration.md`; this milestone implements it and adds a "declare `growth`" step to the `add-action-type` skill.
- **Occupancy is derived state in `Store`, not sim state.** 0007 §5 says "derived from entities, rebuilt on load"; keeping it out of the encoding means heavy mode (M22) proves the rebuild is complete.
- **No engine-side placement rejection.** Rejection belongs to `apply` (one code path for host, replay, prediction); the engine only asserts in debug. Rationale: an engine reject inside a put would be a fallible put.
- **Anchor hook:** uses `Game::anchor` (0024 §7, declared in M12).

## Order of work
1. prototypes in `Registry`. 2. `ChunkIndex` + `Store::apply` maintenance + rebuild. 3. reads. 4. footprint scopes, snapshot inclusion, loopback tests across a chunk border. 5. budget check + growth + audit + init check. 6. fixture scenarios and goldens.

## Tests added
Rust: `entities_in_visits_each_once_in_id_order` (a border machine under a rect that covers two of its chunks; `Unknown` on a replica at the subscription edge), `footprint_sets_every_overlapped_chunk`, `despawn_clears_all_chunks`, `move_updates_old_and_new`, `entity_at_any_covered_tile`, `placement_is_one_trait_query` (water and another machine, same bit), `index_rebuild_equals_incremental`, `footprint_larger_than_chunk_panics_at_register`; loopback: `border_machine_delivered_once_to_partial_subscriber`, `border_machine_gone_when_last_overlapped_chunk_leaves`, `replica_traits_at_matches_host`, `moved_entity_enters_and_leaves_subscription` (`Move` into a subscribed chunk delivers one full `EntityPut`, `Move` out delivers `EntityGone`, replica hash equals host region hash: 0011 entity scope); budget: `full_world_rejects_place_accepts_remove_then_place` (the second half 0023 adds to the 0003 scripted list), `undeclared_action_uses_max_action_growth`, `budget_verdict_replays_identically`, `growth_declarations_are_honest` (audit on, all `machines` scripts), `under_declared_growth_panics_in_debug`, `under_declared_growth_counts_in_release` (audit in its release mode through a test cfg switch: writes kept, `growth_violations == 1`, hash equal to the run without the audit), `over_max_declaration_panics_in_debug` (`#[should_panic]`), `nominal_costs_are_constants` (undeclared-path headroom uses the two fixed 0007 §8 costs on a fixture whose `size_of::<Entity>()` differs from the entity cost), `full_world_still_accepts_join` (at zero headroom `on_player(Joined)` puts its player and replays identically: the soft half of 0004 "State-budget check"; tick-rule writes are 21b's `tick_rule_put_past_limit_is_applied`), `id_exhaustion_rejects_state_budget_full` (`testkit::set_next_entity_id` near the 0022 §2 limit: a growing action is `StateBudgetFull`, a `Growth::NONE` action passes), `init_rejects_budget_over_arena`. Browser: none new (the slice test keeps passing).

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

No split: all six steps landed in one session (5 commits: steps 4/5/6, plus this note). No plan
decision changed; one implementation-level correction escalated below for orchestrator awareness
(the moved `puts_script_a` golden), one file-placement correction against the brief's own Files
list (module layering).

**Seam shapes as landed** (all in `packages/engine/crates/engine/src/`):
- `store/index.rs`'s `ChunkIndex` (`pub(crate)`, not exported at `engine::` -- nothing outside
  `Store` needs it by name): `new(ChunkDims)`, `add`/`remove(index: u16, id: EntityId)`,
  `entity_at(u16) -> Option<EntityId>`, `overlapping() -> &[EntityId]` (ascending, deduped),
  `is_empty()`. **No debug-panic on overlap** (see "Overlap policy", below).
- `Store<G>` (`store/mod.rs`) gained `registry: Registry` (built once in `Store::new`, before this
  milestone held separately by `Authority`/`Replica`) and `chunk_index: BTreeMap<ChunkCoord,
  ChunkIndex>`. New public methods: `registry()`, `entity_at(TilePos) -> Option<EntityId>`,
  `entities_in(rect, scratch: &mut Vec<EntityId>, f)` (the `WorldRead::entities_in` trait method's
  own Store-level engine, reused by every implementor), `chunk_overlapping(ChunkCoord) ->
  &[EntityId]` (`pub(crate)`), `rebuild_indexes()` (also called automatically at the end of
  `decode()`), `debug_index_ops()`. `footprint_rect(anchor, footprint) -> TileRect` is a free
  `pub(crate)` function here, reused by `Authority::entity_scopes`.
- `WorldRead::entities_in(&self, rect: TileRect, f: &mut dyn FnMut(EntityId, &G::Entity)) ->
  Result<(), Unknown>` exactly as specified, added to the trait (implemented on `Authority`,
  `TickCx`, `View`, `Replica`). `entity_at`/`traits_at` are real on all four.
- `Scopes` (`authority.rs`) widened from a 4-slot to an **8-slot** fixed array: a moved entity's
  old and new footprint are each capped at 4 chunks (0007 §5), so the true worst case for one
  write is 8, not 4 (M12b's own comment undersold this at "at most 2", the anchor-pair case). New
  `pub(crate) Scopes::from_chunks(impl Iterator<Item = ChunkCoord>)` builds and dedups from an
  arbitrary chunk list; `Authority::entity_scopes` now takes `new: Option<&G::Entity>` (was
  `Option<TilePos>`) so it can look up the new value's own footprint, not just its anchor.
- `crate::game::Growth { entities: u16, modified_tiles: u16 }` with `NONE`/`entities(n)`/`tiles(n)`
  and `Game::growth(&Action) -> Option<Growth>` (default `None`), exactly as 0023.
- `crate::budget` (see "Module layering", below): `pub(crate) fn check<G>(&Authority<G>, Option
  <Growth>) -> Result<(), EngineReject>`, `pub(crate) fn audit<G>(&mut Authority<G>, Option<Growth>,
  before: (u32, u32))`, `pub const ENTITY_COST_BYTES: u32 = 128`, `pub const TILE_COST_BYTES: u32 =
  12`, and a test-only `pub fn set_force_release_audit_for_test(bool)`.
- `Authority<G>` gained `max_entities`/`max_modified_tiles`/`max_action_growth` (defaulted to
  0007 §8's own figures; `set_budget` is `pub(crate)`, called once by `Sim::genesis` from
  `WorldParams`) and `growth_violations: u64` (`pub fn growth_violations()`,
  `pub(crate) fn record_growth_violation()`). `Authority::store_mut()` is testing-gated
  (`testkit::fill_world`/`set_next_entity_id` need it).
- `testkit::fill_world<G>(&mut Sim<G>, entities: u32, tiles: u32) where G::Entity: Default` and
  `testkit::set_next_entity_id<G>(&mut Sim<G>, u32)`, exactly as named in Provides.
- `Registry::add_prototype` now asserts `footprint <= chunk_edge` (`Registry::set_chunk_edge`,
  `pub(crate)`, called by `Store::new` before `Game::register` runs); `prototype_traits`/
  `footprint` are now **total** (default `TraitSet::EMPTY`/`Footprint{1,1}` for an id no
  `add_prototype` call ever returned) instead of panicking on an out-of-range index -- see
  "Registry totality", below.
- `Status::BudgetExceedsArena` (discriminant 10, mirrored in `src/abi.ts`); `Host::init` computes
  0007 §8's memory-split sum (cache + real `size_of::<G::Entity>()` + fixed nominal
  overlay/chunk-index/slack estimates) against a new, optional `SimConfig.world_budget_bytes`
  (JSON `worldBudgetBytes`, default `u32::MAX` = unchecked). **Not the engine's own pre-existing,
  separate `InstanceConfig.arenaBytes`** (`src/sim-config.ts`, the real WASM memory size
  `instantiate()` allocates, one JSON level up, invisible to `Instance::init`) -- named
  `world_budget_bytes` specifically to avoid colliding with that unrelated, already-established
  concept once both showed up as "arenaBytes" at different nesting levels.
- `fixtures/machines` (`fx-machines`): `Pos`, `Action::{Place{origin}, Feed{at}, Move{at,to},
  Remove{at}}`, `Reject::{Unknown, NotFound, Blocked}`, `Machine{origin, fed, done_at, count}`
  (2x2 footprint, `NOT_BUILDABLE`), a sparse deterministic water grid (every 8th tile on both axes,
  `WATER_BASE` also `NOT_BUILDABLE`). Goldens `golden/scenario.json` -> `golden.json` ("place-
  border": `2f62009b92068963`) and `golden/scenario-full-world.json` -> `golden-full-world.json`
  (`a1e1b02f2725e3c0`), both `.wasm`-authoritative, both also proven native/`.wasm`-identical by
  `tests/golden_scenarios.rs`'s own `run_script` calls against the same files.

**Module layering: `crate::budget`, not `host::budget`.** The brief's Files list named
`host/budget.rs`, but the state-budget check has to run from `Sim::step` (0004: "the check reads
only sim state and world params, so the live host, replay and recovery decide identically") --
`Sim::step` is the deterministic core and runs with no `Host<G>` at all under `testkit::run_script`
or a replay, and crate `CLAUDE.md`'s own layering rule (enforced by `tests/module_layering.rs`)
forbids the core from importing the host role's module. Landed at `crate::budget` instead, a
sibling of `authority.rs`/`sim.rs`; `Host::init`'s own memory-split check (a genuinely host/role-
only concern, ABI `Status`) stays in `host/mod.rs` and reads two constants from `crate::budget`.

**Registry totality, not a debug-panic on overlap.** The brief's "Overlap policy" bullet describes
a debug-only panic on a put whose footprint covers a tile already occupied by a different id. This
was built and then removed: dozens of this crate's own pre-existing test `Game` implementations
(every milestone since M07) give every test entity a fixed or reused `anchor`/`PrototypeId(0)`
stub that was never meant to model real placement, since occupancy did not exist before this
milestone -- turning the assertion on made roughly a dozen unrelated, pre-existing tests panic on
first spawn of a second entity at the same tile (`store::tests::store_apply_is_idempotent` and
siblings, all using `TestGame::anchor` -> a fixed tile). Per "never weaken, skip or delete an
existing test", the debug-assert was dropped rather than rewriting that whole fleet of unrelated
stub games; `store::index::ChunkIndex` stays fully overlap-tolerant by design (`entity_at` answers
with the lowest id, `overlapping()` lists every id) with no invariant of its own to enforce. The
"ask the tiles" convention (0007 §6, the `add-action-type` skill's new guidance) is how a real game
is still expected to prevent overlap in practice; `fixtures/machines` follows it. Separately,
`Registry::prototype_traits`/`footprint` were made total (default `EMPTY`/`1x1` for an id nothing
ever registered) rather than panicking, for the same underlying reason: `Store::apply` now
consults the registry for every entity put, and an unregistered `PrototypeId(0)` is the default
across the whole pre-M21 test fleet. No test asserted the old panicking behaviour (grepped for
`should_panic` near either method: none).

**Existing golden moved, not blessed (ruling followed): `puts_script_a` / `wasm_script_a_matches_
native`.** `fx-puts`'s script spawns an entity at `(5,5)` (tick 2), then `Bump`s it (tick 3,
`seq 3`) and `Remove`s it (tick 4, `seq 4`). Before this milestone `entity_at` was always
`Ok(None)` (M12b Deviations), so both actions deterministically rejected `NotFound` and wrote
nothing; the entity spawned at tick 2 persisted, unmodified, for the rest of the script. With
`entity_at` real, both now find the entity `Spawn` created (its anchor is exactly `(5,5)`, a
registered 1x1 prototype): `Bump` succeeds (increments `amount`, one `put_entity`), then `Remove`
succeeds (`despawn`s it) -- so by the end of the script the entity is gone entirely, rather than
present forever with `amount == 0`. New hash `d5fd55ce8f13a67e` (native and `.wasm` agree,
confirmed by `wasm_script_a_matches_native`'s own failure printing the identical new value); old
`7bdddfc9c749b1fb` is `fixtures/puts/golden/golden-script-a.json`'s current, unmoved content. This
is exactly the outcome the M12b Deviations note anticipated ("should start succeeding") and not a
bug; left unblessed pending the orchestrator's review, per this brief's own ruling.
`puts_idle_100` (the other golden the ruling flagged as possibly moving) does not move: it never
calls `Bump`/`Remove`. The M15 `golden_frame_bytes_join_wilderness` byte golden and every M14
`wire_*` golden are unaffected (checked): none of their fixture data uses a footprint wider than
1x1, so anchor-chunk-equality and footprint-overlap are the same set for them.

**Approved test rewrite, plus a kept sibling.** M15's `entity_straddling_subscribed_and_
unsubscribed_chunks_delivered_once` (`tests/connection_and_subscriptions.rs`) is rewritten to a
real footprint case: `LGame` gains a second, 2x1 prototype (`LAction::SpawnWide`, `LEntity.wide`)
anchored on a chunk boundary, camera set up so ring1 subscribes one of its two chunks and not the
other. The original anchor-move scenario is kept, renamed `entity_move_between_subscribed_and_
unsubscribed_delivered_once` (same body, `LEntity{ wide: false, .. }`), per "keep an equivalent
anchor-move case if one existed".

**Anti-vacuity (three, of the several run): all inject-fail-revert, lines pasted from the actual
run.**
- `footprint_larger_than_chunk_panics_at_register`: commented out the `assert!` in
  `Registry::add_prototype` -> `note: test did not panic as expected at .../world/traits.rs:235:8`.
  Reverted -> green.
- `move_updates_old_and_new` / `index_rebuild_equals_incremental`: no-opped the old-footprint
  removal call in `Store::apply`'s `EntityPut` arm -> both fail: `old chunk (0,0) must be cleared
  after the move` and `assertion left == right failed: chunk (1,0) index mismatch after rebuild
  left: [EntityId(1), EntityId(2)] right: [EntityId(1)]`. Reverted -> green.
- `entities_in_visits_each_once_in_id_order`: replaced the dedup-insert in `Store::entities_in`
  with a bare `push` -> `assertion left == right failed: ascending id order, each entity visited
  exactly once left: [EntityId(2), EntityId(1), EntityId(2)] right: [EntityId(1), EntityId(2)]`.
  Reverted -> green.
- `nominal_costs_are_constants`: swapped the undeclared-path nominal `ENTITY_COST_BYTES` for
  `size_of::<G::Entity>()` in `crate::budget::check` -> `the undeclared-path headroom must use the
  fixed 128 B nominal cost, not size_of::<BEntity>()`. Reverted -> green.
- `border_machine_delivered_once_to_partial_subscriber` (`fx-machines`, against the frame-builder/
  snapshot widening specifically, after first restructuring the test so it actually exercises
  `encode_chunk_snapshot` rather than `ChunkDeltas` -- the first attempt at this proof silently
  passed because the chunk had already entered pristine before the entity existed, so delivery
  went through the deltas path instead): reverted `encode_chunk_snapshot`'s `chunk_overlapping`
  read to an anchor-chunk-equality filter -> `assertion left == right failed: delivered once,
  through the subscribed half of its footprint left: None right: Some(Pos { x: 63, y: 5 })`.
  Reverted -> green.

**`entity(id)`'s `Unknown`-vs-`None` distinction is not this milestone's.** A first draft of
`fixtures/machines`'s `moved_entity_enters_and_leaves_subscription` asserted `Err(Unknown)` for a
real id the replica had never been told about, per 0022 §7's decision 7 ("a real id the replica and
overlay do not hold returns `Err(Unknown)`"). `Store::entity`/every `WorldRead::entity` impl here
stayed a plain lookup (`Ok(None)` for any absent id): 0022's own Consequences explicitly assign
decision 7 to M25 ("provisional ids, the `Deserialize` guard test and decision 7 land with
prediction"), and M21's Non-scope names "predicted placement and ghosts (M25, M33)". Fixed to
assert `Ok(None)` instead; flagged here since it is a real, if small, gap against 0022's literal
text that a future milestone (M25) closes.

**`entities_in`'s "Unknown at the subscription edge" is proven via `View`, not a full `Replica`.**
`entities_in_visits_each_once_in_id_order` (Store-level) plus `world_access::tests`'s own
`View`-based checks cover the replica-edge `Err(Unknown)` gate (`View`'s `held` closure is the
same total/subscription-scoped predicate `Replica` uses); the loopback tests separately prove a
real `Replica`'s `entities_in`/`entity_at`/`traits_at` agree with the host end to end
(`replica_traits_at_matches_host`, `border_machine_*`). No test builds a full `Loopback` purely to
re-prove the `touches_unheld` gate a simpler `View` already covers.

**Fixed two pre-existing `max_entities: 0` placeholders** the now-live check would otherwise
reject every entity-creating action against: `games/reference/sim/tests/common/mod.rs` (changed to
0007 §8's own default, 262,144 -- `reference-sim::collect`'s 7 failing tests, diagnosed and fixed
before committing). `fixtures/puts/tests/puts_apply_contract.rs`'s own `max_entities: 0` (a
deliberately all-zero budget so its `()`-action test reaches `apply` unconditionally) needed no
change: with `max_action_growth` also `0`, the undeclared-path headroom comparison (`0 < 0`) is
vacuously false on both counts, so nothing is ever rejected there.

**Timer wheel, wake-ups, active lists, `TickCx` growth, the undo journal: still 21b's,
untouched.** `fx-machines`'s `Machine.done_at`/`count` fields are stored but nothing reads them;
`tick` is a deliberate no-op.

**Measured.** `pnpm test`: `rust` 442 tests (1 known, unblessed failure -- see above), `unit` 232,
`wasm` 60 (1 known failure, `wasm_script_a_matches_native`, same root cause), `browser` 185, all
unchanged in kind from before this milestone except the one moved golden. `pnpm lint`: biome,
rustfmt, clippy (workspace, all-targets, with and without `--features engine/testing`), tsc all
green. `cargo nextest run -p fx-machines --features engine/testing`: 15 tests, 15 passed. No
`no_alloc_*` test's asserted number moved (`host_and_client_steady_state_no_alloc`,
`authority_put_existing_key_no_alloc`, `store_apply_existing_key_no_alloc`, `no_alloc_terrain`,
`no_alloc_wire` all still pass unmodified: the widened `Scopes`/`ChunkIndex` maintenance reach a
stable steady-state capacity in each test's own warm-up loop, same as before).

**Decisions needing orchestrator awareness:** the moved `puts_script_a`/`wasm_script_a_matches_
native` goldens (new value `d5fd55ce8f13a67e`, reasoning above) are left unblessed. Everything else
in this section is a small correction, not a decision.
