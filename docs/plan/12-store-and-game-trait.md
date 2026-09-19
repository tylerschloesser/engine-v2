# M12: `Game` trait, `Delta` and the `Store`

Status: not started · After: 07, 08 (PLAN.md lists 07 only; `Game::Worldgen` needs M08's trait) · Tyler-dependent: no

Split: the original M12 exceeded the reading-list and size rules. This brief lands the data side (trait, deltas, store, hash). `12b-world-access-and-sim-driver.md` lands `WorldRead`/`WorldWrite`, `Authority`, `Ticks` conversions, the `Sim` driver and the golden-hash scenarios.

## Goal
The engine crate has the full `Game` trait of 0003, the engine-defined `Delta<G>`, and a `Store<G>` (tile overlays via M07, entities, players, global) whose only mutator is `Store::apply(&Delta<G>)`. The store encodes canonically and hashes with M05's state hash; a fixture game's types compile against the trait natively and for `wasm32`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0003-game-facing-api.md` (Decision: the trait block, "Deltas are engine-defined", "`Codec`"; Consequences item 7)
3. `docs/decisions/0011-wire-format-and-deltas.md` ("Deltas are the only write path", "Scopes")
4. `docs/decisions/0022-entity-ids-and-provisional-ids.md` (or its numbered successor: entity store layout, `EntityId` reuse)

Mine from spikes: `spikes/prediction-api/engine/src/lib.rs` (`Store`, `Store::apply`, `Delta`, `Scope`; replace its `BTreeMap` tiles with M07 overlays and its std `Hash` with `Codec` bytes). Rules that apply: `.claude/rules/determinism.md`.

## Scope
- `Game` trait with **every** associated item of 0003 Decision, so later milestones never touch fixture `impl Game` headers. Types this milestone cannot fill are declared as shells with no-op defaults: `TickCx<'_, G>` (M12b/M21b), `FrameCx`, `FrameView`, `DrawList` (M16b/M17/M19), `PresenceTable<G>` (M19), `OldStore` (M24), `SaveIncompatible`, `PlayerEvent`, `Unknown`. `ClientSide<G>` and `Presence` get `impl .. for ()` so a fixture writes `type Client = (); type Presence = ();`. If M09 already declared `ClientSide` for `tile_visual`, extend it instead.
- `Tick(u32)`, `Ticks(u32)`, `TickRate` with `hz()` and `HZ_20` only (conversions: M12b). `PlayerId`, `EntityId` (per the entity-id ADR §1: `u32`, 0 = none, bit 31 never set on a real id; the `Deserialize` guard is M25).
- `Delta<G>` per 0011 plus the engine-internal `Roster` variant (Planning decisions).
- `Store<G>`: embeds M07's `TerrainStore` (overlays are its state half; the canonical-overlay rule stays M07's), entity store **per the entity-id ADR §3–4** (ordered map, `next_entity_id`, nothing about layout encoded), player table (`PlayerSlot { state, last_seq, online }`, ordered by `PlayerId`), `G::Global`, id counters. `Store::apply`, idempotent. Counts `entity_count()` and `modified_tile_count()` (the latter delegates to `TerrainStore::modified_tiles()`; M21 consumes both).
- Canonical encoding `Store::encode(&self, &mut impl ByteSink)` / `Store::decode(&mut ByteReader)` in the order 0005 "Snapshot" lists for the engine section (terrain through `TerrainStore::write_canonical`; timers and active lists are appended by M21b), and `impl StateHash for Store<G>` (M05).
- `SimRng` (0002 "Randomness" row: PCG32, integer range sampling, `fork`), unless M05 already landed it.
- Fixture crate `packages/engine/fixtures/puts/` (package `fx-puts`, M02 conventions): types only in this milestone (`Action`, `Reject`, `Entity`, `Player`, `Global`, `Ui = ()`); handlers arrive in M12b.

## Non-scope
`WorldRead`/`WorldWrite`, `Authority`, `View`, scope routing, `genesis`/`apply`/`tick` execution, `Ticks` conversions (M12b). Prototypes, footprints, occupancy (M21). Wire bytes of deltas (M14). Snapshots to storage (M22). No ABI export changes.

## Files, packages and crates touched
`packages/engine/crates/engine` (modules `game`, `delta`, `store`, `rng`, `time`), `packages/engine/fixtures/puts`.

## Seams
**Provides:** `Game`, `ClientSide`, `Presence`, `Unknown`, `PlayerEvent`, shells `TickCx`/`FrameCx`/`FrameView`/`DrawList`/`PresenceTable`/`OldStore`; `Tick`, `Ticks`, `TickRate::{hz, HZ_20}`; `PlayerId`, `EntityId`; `Delta<G>`; `Store<G>::{new, apply, encode, decode, state_hash, entity_count, modified_tile_count, player, entity, global, last_seq}`; `SimRng`; fixture `puts` types.
**Consumes:** M05 `Codec`, `ByteSink`/`ByteReader`, `StateHash`, `assert_golden_bytes!` + `pnpm golden:bytes`; M07 `Tile`, `TilePos`, `ChunkCoord`, `ChunkDims`, `TerrainStore`, `Registry`, `TraitSet`, `PrototypeId`, `Footprint`; M08 `Worldgen`, `Pristine<W>`; M09 `ClientSide`/`TileTexel` if present; M02 fixture conventions, `abi::Arena` counters for the no-alloc test.

## Planning decisions
- **Entity anchor (ADR gap, reported to Tyler's planner).** 0003 replaced the spike's `footprint(e)` (origin + size) with `prototype(e) -> PrototypeId`, which carries no position, so the engine cannot derive scope or occupancy. Assumed fix: a required hook `fn anchor(e: &Self::Entity) -> TilePos` next to `prototype`. M12 declares it; M12b routes scope by it; M21 adds the footprint. If the amendment lands differently, only these three call sites change.
- **`Delta::Roster { who, online }`.** 0011 puts the engine roster in `Global` scope but its `Delta` enum has no variant for it. The roster changes only through logged connection events, so it is sim state: a sixth, engine-only variant keeps "`Store::apply` is the only mutator" true.
- **Missing player.** `Store::player(who)` for an id with no slot is the one host-side `Err(Unknown)`. M12b asserts a slot exists after `on_player(.., Joined)` with the message "on_player(Joined) must put_player".
- **`last_seq` lives in `PlayerSlot`**, because 0004 makes it sim state; it is encoded and hashed.
- **Shell types now, not later:** associated type defaults are unstable, so adding `type Ui` in M16b would break every fixture; declaring the full trait once is cheaper.

## Order of work
1. ids, `Tick`, `TickRate` minimal, `Unknown`, `PlayerEvent`, shells. 2. `Game` trait + `ClientSide`/`Presence` unit impls. 3. `Delta`. 4. `Store` + `apply`. 5. encode/decode/hash. 6. `SimRng`. 7. fixture types; build for native and `wasm32`.

## Tests added
Rust native: `store_apply_is_idempotent`; `store_roundtrip_bytes_equal` (encode → decode → encode); `store_hash_ignores_insertion_order`; `store_golden_bytes` (M05 pattern); `entity_id_policy_*` (cases named by the entity-id ADR); `simrng_golden_sequence`; `puts_fixture_builds_wasm32` (import allowlist test from M02 picks the fixture up).

## Exit criteria
- [ ] Every test above passes; the `puts` fixture appears in M02's allowlist test run.
- [ ] `grep -r "HashMap" crates/engine/src/store*` is empty (ordered containers only, 0007 §2).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t store` · `pnpm test rust -t simrng` · `pnpm test wasm -t allowlist` · `pnpm golden:bytes -- store` (only to bless new goldens) · `pnpm lint`.

## Budgets
None measured here. `Store` must not allocate in `apply` for an existing key with plain-data values (asserted with the counting allocator from the spike's `alloc.rs`, test `store_apply_existing_key_no_alloc`).

## Context artifacts
Update `packages/engine/crates/engine/CLAUDE.md` (module map: `game`, `delta`, `store`). Extend `paths:` of `.claude/rules/determinism.md` to the new modules.

## Manual device checks
none

## Deviations
(filled in during Phase 3)
