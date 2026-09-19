# M07: World model core

Status: not started · After: 05 · Tyler-dependent: no

## Goal
The engine crate holds terrain exactly as 0007 defines it: 4-byte tiles, tile/chunk/world coordinates, trait tables in a `Registry`, and a `TerrainStore` whose *state* is sparse canonical overlays over a pure pristine function and whose dense chunks are an LRU cache nothing can observe. A native test matrix proves invisibility: the same scripted operations at cache capacity 1, default and unlimited, with generation pre-warmed in shuffled orders, give identical reads and identical state hashes.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0007-world-model.md` (§1–6, §8, §9; skip §7)
3. `docs/spec/world.md` (Requirements)
4. `docs/decisions/0002-determinism-same-wasm-everywhere.md` (§2 rows on integers and collections; §3 lint bans)

Mine from spikes: `spikes/determinism-hash/src/lib.rs` (`mix64`, `SplitMix` for seeded test scripts; `finish_tile` for the tile byte order). Rules that apply: `.claude/rules/determinism.md`.

## Scope
- `Tile`, `TilePos`, `ChunkCoord`, `WorldPos` (Q24.8), `ChunkDims`, chunk key, local index, the valid coordinate range and `Tile::VOID` (0007 §2–4).
- `TraitSet`, `Registry`: base and resource trait tables, plus the prototype table as plain data (`TraitSet` + `Footprint` per `PrototypeId`) so `Game::register` (M12) has its full target (0007 §6).
- `PristineSource`: the object-safe seam through which terrain asks for `P`. `ChunkOverlay` with the canonical-overlay rule and per-entry cached pristine value (0007 §1, §5).
- Dense cache: slab pool reserved at init, intrusive LRU, fixed-hasher open-addressing index, cache events carrying slab indices (0007 §8; 0018 uses the client slab index as the GPU page slot).
- `TerrainStore`: total `tile`, `set_tile`, modified-tile count, overlay replace/clear for replicas, `insert_pristine` for externally generated chunks, canonical write/read and `StateHash`.
- The cache-invisibility test helper and matrix (0007 Consequences, 0020 §3 Rust native row).

## Non-scope
- Entities, `EntityId`, entity stores, `ChunkIndex`, occupancy, the occupant term of `traits_at`, footprint-vs-chunk assertion, active lists, timer wheel, `TickCx`: M12, M12b, M21 and M21b. Entity store layout and id reuse are decided in `docs/decisions/0022-entity-ids-and-provisional-ids.md`; nothing here depends on it.
- `WorldRead`/`WorldWrite`, `Unknown` outside a client subscription, deltas, `Store`: M12 and M12b (the replica decides what is `Unknown`; `TerrainStore` itself is total).
- `Worldgen`, `hash2`, worldgen fingerprint and `WORLDGEN_VERSION` stamping, gen role: M08. Gen workers and the generation queue: M08b. Texel conversion and upload: M09. State-budget check: M21 (this milestone only exposes the count).
- Wire overlay-run encoding: M14 (it encodes the same sorted entries). Snapshot container: M22 (it calls `write_canonical`).
- No ABI exports and no TypeScript.

## Files, packages and crates touched
`packages/engine/crates/engine/` only: `src/world/{mod,tile,coords,traits,overlay,cache,terrain}.rs`, `src/testing/cache_matrix.rs`, `tests/world_*.rs`, `tests/no_alloc_terrain.rs`, `tests/golden/`; `packages/engine/CLAUDE.md` updated.

## Seams
**Provides** (under `engine::world` unless noted):
- `Tile(pub u32)`: `new(base: u8, resource: u8, aux: u16)`, `base()`, `resource()`, `aux()`, `with_base/with_resource/with_aux`, `to_le_bytes()`, `Tile::VOID`.
- `TilePos { x: i32, y: i32 }`, `ChunkCoord { x: i32, y: i32 }` (`key() -> u64`, `from_key`), `WorldPos { x: i32, y: i32 }` (Q24.8; `from_tile`, `tile()`, `clamped()`), `ChunkRect { min: ChunkCoord, max: ChunkCoord }` (inclusive; `expanded(rings)`, `contains`, `iter` row-major), `TileRect { min: TilePos, max: TilePos }` (inclusive; `contains`, `intersects`, `chunks(ChunkDims) -> ChunkRect`; used by M17's `visible()`, M21's and M25's `entities_in`).
- `ChunkDims` (`new(bits: u32)` accepting the three sizes of 0007 §3, `bits`, `edge`, `area`, `slab_bytes`, `chunk_of(TilePos)`, `local_index(TilePos) -> u16`, `tile_at(ChunkCoord, u16) -> TilePos`, `in_range(TilePos)`).
- `TraitSet(pub u64)` (`EMPTY`, `ALL`, `contains`, `union`, `BitOr`), `PrototypeId(u16)`, `Footprint { w: u8, h: u8 }`, `Registry` (`set_base_traits(u8, TraitSet)`, `set_resource_traits(u8, TraitSet)`, `add_prototype(TraitSet, Footprint) -> PrototypeId`, `tile_traits(Tile) -> TraitSet`, `prototype_traits(PrototypeId)`, `footprint(PrototypeId)`).
- `trait PristineSource { fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]); }`.
- `CacheCapacity { Chunks(u32), Unlimited }` (`Unlimited` is test-only), `CacheEvent { Loaded { chunk, slot: u32 }, Evicted { chunk, slot: u32 } }`.
- `Overlays` (the state half: ordered map of `ChunkOverlay` by chunk key; reachable as `TerrainStore::overlays()`), and `TerrainStore`, the unit `Store<G>` (M12) embeds on host and client: `new(ChunkDims, Box<dyn PristineSource>, CacheCapacity)`, `tile(&self, TilePos) -> Tile`, `set_tile(&mut self, TilePos, Tile) -> Result<TileChange, OutOfRange>` (`TileChange { Unchanged, Changed { old: Tile } }`), `modified_tiles() -> u32`, `overlay(ChunkCoord) -> Option<&ChunkOverlay>`, `overlay_chunks()` (key order), `replace_overlay(ChunkCoord, &[(u16, Tile)])`, `clear_overlay(ChunkCoord)`, `is_cached`, `materialize(ChunkCoord) -> bool` (true when it generated), `insert_pristine(ChunkCoord, &[Tile])`, `touch(ChunkCoord)`, `slot_of(ChunkCoord) -> Option<u32>`, `copy_chunk(ChunkCoord, &mut [Tile]) -> bool`, `drain_cache_events(impl FnMut(CacheEvent))`, `memory_bytes() -> usize`, `write_canonical(&self, &mut impl ByteSink)`, `read_canonical(&mut self, &mut ByteReader) -> Result<(), CodecError>`, and `impl StateHash`.
- `engine::testing`: `CacheConfig { capacity, prewarm: Prewarm { None, All, Shuffled(u64) } }`, `assert_cache_invisible(run: impl Fn(&CacheConfig) -> Vec<u64>)` (runs the closure under capacity 1 / default / unlimited crossed with the three prewarm modes and asserts every returned checkpoint vector equal), `TestTerrain` (a `PristineSource` built on `mix64`), `CountingSource` (wraps a source, records call order and count). M12b, M21 and M22 rerun real logs through `assert_cache_invisible`.

**Consumes:** M05: `ByteSink`, `ByteReader`, `StateHash`, `mix64`, `CodecError`, `assert_golden_bytes!`. M02: the crate, `hash::Fnv64`, feature `testing`, `abi::Arena` + `abi::arena::{live_bytes, high_water_bytes}` (global allocator of the no-alloc test binary). Nothing from M06.

## Planning decisions
1. **Chunk size is a runtime `ChunkDims`, not a const generic (0024 §9).** `CHUNK_BITS` is an associated const of `Game` (0003); stable Rust cannot use `G::CHUNK_BITS` as a const-generic argument or array length inside code generic over `G`, so `[Tile; N*N]` cannot be spelled. Slabs are `&[Tile]` of `dims.area()` from the pool; M12 builds `ChunkDims::new(G::CHUNK_BITS)` once. A variable shift costs nothing measurable and keeps the world model out of monomorphisation. Tests run at all three sizes.
2. **`PristineSource` is separate from `Worldgen`.** `Worldgen` (M08) is a static, game-typed function with `Params`; terrain needs only "fill this slab", object-safe, so tests use `TestTerrain` and M08 adapts with `Pristine<W>`. A call per cache miss makes `dyn` free.
3. **Overlays and cache are one unit.** Keeping an overlay canonical needs the pristine value at write time, on the host and equally on a client replica applying `Delta::Tile`, so whoever applies tile writes must own the cache. `Store<G>` (M12) therefore embeds a `TerrainStore`, and `Authority` (M12b) reaches generate-on-miss through it rather than holding a second cache. **The cache sits behind a `RefCell` inside `TerrainStore`,** because `WorldRead::tile` takes `&self` (0003) while a read may generate and evict. The instance is single-threaded (0015 §1). No reference into a slab ever escapes: reads return `Tile` by value, bulk access is `copy_chunk`.
4. **Answer to M02's hand-off (do world pools need a sub-allocator over `abi::Arena`?): no.** The slab pool is one `Vec<Tile>` of `capacity x area` and the index table one `Vec`, both allocated in `TerrainStore::new` and never freed or resized, so reserve-and-free at `engine_init` is enough; only overlay `Vec`s grow afterwards, and that is state growth. `no_alloc_terrain` asserts it with `abi::arena` counters. **Own index table, not `HashMap`.** 0007 §2 allows a fixed-hasher table; the lint ban is on the type and std's map may reallocate on a hot path. Open addressing over `mix64(key)`, sized at init to twice the capacity, tombstone-free (backward-shift delete).
5. **Writes materialise.** `set_tile` materialises the chunk first, so the pristine value is at hand (the slab value when no entry exists, else the entry's cached `pristine`), the canonical check never regenerates, and the slab stays equal to `P + overlay`. In-memory entry: `{ index: u16, pristine_known: bool, tile: Tile, pristine: Tile }`, the nominal size 0007 §8 budgets. Entries loaded by `read_canonical` or `replace_overlay` have `pristine_known = false` until the chunk is next materialised; `clear_overlay` restores slab values from cached pristine values or drops the slab.
6. **Canonical terrain bytes** (whole-world hash and the snapshot's overlay section, 0005 Formats "raw little-endian arrays"): chunk count `u32`; per chunk in ascending key order `key u64`, entry count `u32`, entries `index u16` + `tile u32`, ascending index. Pristine values, cache contents and `modified_tiles` are never written. The per-chunk desync hash of 0013 uses the chunk-enter encoding instead; M14 builds that from the same sorted entries, so there are two encodings of one canonical entry list, not two canonical states.
7. **`Tile::VOID` is `Tile(u32::MAX)`**; `tile_traits` special-cases it to `TraitSet::ALL`. Out-of-range reads return it; out-of-range writes return `Err(OutOfRange)` and change nothing. How the infallible `WorldWrite::set_tile` surfaces that is M12's call.
8. **`insert_pristine` is idempotent and is the dev-build pristine check.** If the chunk is already cached, debug builds assert the incoming tiles equal the slab's pristine view and otherwise ignore them. This compares a gen-worker result with the instance's own synchronous generation for free (see M08 Planning decisions on the sampled pristine-hash item).
9. **Deferred item, decided: overlay promotion to dense at 512 entries is not built in Phase 3.** Reads never consult the overlay (they hit the slab), a sorted insert moves at most a few KB, and the 12 MiB overlay share of 0007 §8 already prices the worst case sparsely. Promotion is a pure representation change behind `ChunkOverlay` (canonical bytes stay the sorted entry list), so it needs no ADR when added. Trigger: M36's standard-large-save run shows overlay memory, not entities, breaking the world budget, or a game whose rules rewrite whole chunks.
10. **Deferred item, decided: bucketed per-chunk area effects are out of Phase 3.** No reference-game rule is area-based, chunks do not tick (0007 §7), and nothing in this milestone needs a hook for them. A game that wants them brings an ADR; the natural home is beside M21's active lists.
11. **Deferred item, scheduled: on-device validation of the 64 MiB split.** This milestone supplies `memory_bytes()` (pool + overlay capacity, deterministic accounting). M21 computes the init-time sum from real `size_of` (0007 §8). M36 asserts the WASM high-water mark on the standard large save against `budgets.json`. M39's device checklist loads that save on the iPhone in single-player. Question M39 must answer: does a world at the full default state budget run ten minutes on the baseline phone with `engine_mem_grows() == 0` and no tab reload; if not, which default drops first (`max_entities`, per 0007 §8 "entities are the memory problem").

## Order of work
1. `tile.rs`, `coords.rs` with tests at all three chunk sizes and at the range edges. 2. `traits.rs`. 3. `overlay.rs` (sorted entries, canonical rule as a pure function of `(entry?, pristine, new)`). 4. `cache.rs`: pool, LRU, index table, events; unit tests at capacity 1 and 2. 5. `terrain.rs`: compose; canonical write/read; `StateHash`. 6. `testing/cache_matrix.rs`, then the invisibility tests. 7. `no_alloc_terrain`. 8. `packages/engine/CLAUDE.md`: world module map, "cache is not state" rule, how to use `assert_cache_invisible`.

If the session passes half its context before step 6, stop after step 5, commit, and split the remainder into `07b-cache-invisibility.md` (new `PLAN.md` row, After: 07; M08 then waits on 07b).

## Tests added
`tile_le_byte_order`, `tile_void_traits_all`, `chunk_of_negative_tiles_floors`, `local_index_row_major`, `chunk_key_roundtrip`, `worldpos_range_and_clamp`, `dims_reject_unsupported_bits`, `traits_union_of_tables`, `overlay_never_holds_pristine`, `set_back_to_pristine_drops_entry_and_count`, `overlay_sorted`, `canonical_bytes_independent_of_write_history`, `canonical_roundtrip`, `golden_terrain_canonical` (`assert_golden_bytes!`), `loaded_entries_learn_pristine_on_materialize`, `clear_overlay_restores_slab`, `out_of_range_reads_void_writes_rejected`, `lru_evicts_least_recent`, `touch_protects`, `cache_events_report_slots`, `cache_invisible_matrix` (seeded script of 5,000 mixed reads and writes over 300 chunks, checkpoints = hash every 500 ops + a hash of all read results), `cache_invisible_insert_pristine_any_order` (results early, late, duplicated), `source_called_once_per_chunk_when_unlimited` (`CountingSource`), `no_alloc_terrain` (after init, reads and cache churn allocate zero bytes; only overlay growth may allocate).

## Exit criteria
- [ ] All tests above pass by name at `CHUNK_BITS` 4, 5 and 6 where parameterised.
- [ ] `cache_invisible_matrix` covers 3 capacities x 3 prewarm modes and compares both state hashes and read results.
- [ ] No `HashMap`/`HashSet` and no `#[allow(clippy::disallowed_types)]` under `src/world/`.
- [ ] `grep -n "pub fn" src/world/terrain.rs` shows no method returning a reference into a slab.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t world` · `pnpm test rust -t cache_invisible` · `pnpm test rust -t no_alloc_terrain` · `pnpm test && pnpm lint`.

## Budgets
Memory per instance (`PRE-PLAN.md` §7): the pool is `capacity x dims.slab_bytes()` reserved once; `memory_bytes()` is the counter, asserted exactly in `cache_events_report_slots`' setup for the default capacity of 0007 §8. Allocation row: `no_alloc_terrain`. Test-suite row: the matrix runs on the dev profile inside the native suite's budget; if it exceeds the demotion threshold, shrink the script, do not demote (it is the only test of cache invisibility until M12).

## Context artifacts
Updates `packages/engine/CLAUDE.md`. `determinism.md` globs (M02) already cover `src/world/`; add `packages/engine/crates/engine/src/world/cache.rs` to `hot-paths.md` globs (M06) since reads run per tick and per frame. No skill.

## Manual device checks
None of its own. The 64 MiB split check (Planning decision 11) is item M39-large-save: [device-checks.md, M39](device-checks.md#m39-acceptance).

## Deviations
(filled in during Phase 3)
