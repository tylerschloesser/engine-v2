# 0007: World model: pristine function, sparse overlays, global entities

Status: Accepted (2026-09-19)

## Context

Requirements are in `docs/spec/world.md`: an infinite chunked grid, deterministic generation, async generation driven by viewports, a configurable cap, and a world that fits in (WASM) memory. The forces pull against each other:

- Viewports are unlogged and never reach the sim (`0001-camera-and-presence.md`), yet they are what triggers generation. If the sim could observe *whether* or *when* a chunk exists, replay (which has no viewport data at all) would diverge. Factorio carried exactly this bug for seven years: generation results were applied into lockstep state, the number of parallel map-gen tasks depended on `hardware_concurrency()`, and an `on_chunk_generated` event let scripts mutate tiles that later tasks read (FFF-415).
- "Refuse exploration at the cap" would make memory pressure sim-visible for the same reason.
- The baseline phone allows 256 MB per WASM instance and a 64 MiB default world budget (Requirements in `docs/spec/runtime-and-packaging.md`).
- Tiles are read by random point lookups (placement checks, range queries), never swept per layer, and the client must turn a chunk into GPU texels cheaply.

## Decision

**1. Pristine terrain is a total pure function; world state is only what actions caused.**
- `P(seed, params, chunk) -> [Tile; N*N]` (signature and rules: `0008-chunk-generation.md`). Every chunk in the coordinate range exists to the sim at all times; the sim has no "ungenerated" state and no "chunk generated" event.
- World state = per-chunk sparse **overlays** of modified tiles + globally stored **entities** + players/globals. Effective tile = overlay entry if present, else `P`. Snapshots, state hashes, per-chunk desync hashes, and the wire carry overlays and entities, never pristine tiles.
- **Dense chunks are a cache** (`P + overlay`, one pooled slab per chunk), LRU-evicted, excluded from state, hashes, and snapshots. A sim read that misses generates synchronously inside the tick; because `P` is pure the only observable effect is wall-clock time. Materialization and eviction are therefore invisible to the sim and to replay. On the host `world.tile(pos)` is total. On a client replica it returns `Unknown` outside the subscription, because that chunk's overlay is not held (`0012-prediction-and-reconciliation.md`).
- **Canonical overlay:** an overlay never holds an entry equal to pristine. Each in-memory entry caches the pristine value it replaces (filled when the chunk is materialized; never serialized or hashed), so the check needs no regeneration. State is thus a function of the effective world, not of write history, and the modified-tile count can fall.

**2. Coordinates.**
- `TilePos { x: i32, y: i32 }`; `ChunkCoord = tile >> CHUNK_BITS` (arithmetic shift, floor division, correct for negatives); local index `= (y & MASK) << CHUNK_BITS | (x & MASK)`, row-major.
- `WorldPos`: fixed-point **Q24.8 in an i32 per axis** (1/256 tile), one representation for sim, wire, and hash. Valid range is therefore **[-2^23, 2^23) = ±8,388,608 tiles per axis**; movement clamps at the edge, writes outside are rejected, reads outside return `Tile::VOID` (all traits set).
- Chunk map key `u64 = (cx as u32 as u64) << 32 | (cy as u32)`. Containers iterated for snapshots, hashes, or deltas are ordered (`BTreeMap` or sorted `Vec`), per `0002-determinism-same-wasm-everywhere.md`. The dense cache is not state and may use a fixed-hasher table.
- Rendering far from the origin is camera-relative with an integer tile origin: `0018-renderer.md`.

**3. Chunk size.** A power of two: 16, 32, or 64 tiles; **default 32** (`CHUNK_BITS = 5`). It is a compile-time constant of the game crate, recorded in the world params. All numbers in ADRs assume 32; tile-denominated limits (view clamp, subscription cap) scale.

**4. Tile = 4 bytes.**
```rust
#[repr(transparent)] pub struct Tile(pub u32);   // little-endian bytes: [base, resource, aux_lo, aux_hi]
// bits 0..8   base      terrain id (grass, water, ...)            engine-known layer
// bits 8..16  resource  resource id, 0 = none                     engine-known layer
// bits 16..32 aux       game-defined (e.g. remaining amount)      opaque to the engine
```
- Packed array-of-structs: one cache line yields every layer of a tile. A 32x32 dense slab is exactly **4,096 bytes**, row-major. Building occupancy is not a tile layer (see 5). Per-tile variants and dithering cost zero bytes: the shader hashes integer tile coordinates.
- **Upload path.** The main thread has no WASM and instance memory is not shared (`0015-threads-memory-and-topology.md`), so every chunk is copied once into a SAB upload ring anyway. That copy *is* the tile-to-texel mapping pass: the client worker writes a texel slab of the same size and stride (4 bytes per tile, 32 tightly packed rows; `queue.writeTexture` has no 256-byte row alignment), and the main thread issues one `writeTexture` per chunk into a page slot; a tile delta patches one texel. Texel format and the game's visual mapping are owned by `0018-renderer.md`.

**5. Three per-chunk structures with different lifetimes.**

| Structure | Contents | World state? | Lifetime |
|---|---|---|---|
| `ChunkTerrain` | dense `[Tile; 1024]` | no (cache) | pooled 4 KiB slab, LRU |
| `ChunkOverlay` | sorted `Vec<(u16 index, Tile)>` | **yes** | only for chunks with modified tiles |
| `ChunkIndex` | occupancy bitset (128 B) + sorted `(u16 index, EntityId)` + overlapping entity ids | derived from entities, rebuilt on load | only for chunks with entities; never evicted |

- **Entities are not stored in chunks.** They live in global, type-segregated stores keyed by `EntityId` (allocated from a counter in sim state, never by generation). In v1 worldgen spawns no entities.
- **Multi-tile entities** are stored once: anchor tile (min corner) + footprint from the prototype. Every covered tile sets its occupancy bit and index entry in the chunk that owns that tile; placement and removal update all overlapped chunks in one tick. The engine asserts footprint ≤ chunk size, so an entity overlaps at most 4 chunks. It is owned by its anchor chunk for hashing and relevant to a client if *any* overlapped chunk is subscribed (`0010-rates-and-subscriptions.md`).

**6. Traits.** `TraitSet(u64)`. The game declares the bit constants (`NOT_BUILDABLE`, `NOT_WALKABLE`, `COLLECTABLE`, ...); the engine defines only the mechanism. At init the game registers `base_traits: [TraitSet; 256]`, `resource_traits: [TraitSet; 256]`, and one `TraitSet` per entity prototype. `world.traits_at(pos) = base_traits[t.base] | resource_traits[t.resource] | occupant prototype traits`: three table lookups. Placement "asks the tiles": every footprint tile must satisfy `!traits_at(t).contains(NOT_BUILDABLE)`. Water's table entry and the furnace prototype both carry the bit, so "not on water" and "not on a building" are one query that names no tile type. The same tables exist in the client-role instance, so ghosts and prediction run the identical check (`0003-game-facing-api.md`).

**7. What ticks.** Everything that exists simulates, watched or not. **Chunks never tick; entities do**, so tick cost is O(active entities), never O(chunks):
- per-system **active lists** in deterministic (insertion) order;
- **sleep/wake**: an idle entity leaves its list and registers with what it waits on; wake-ups are queued and applied at one fixed point in the tick;
- a **timer wheel** keyed `(tick, EntityId)`: a furnace computes its finish tick and sleeps, so an idle world costs about zero.
Active lists, wake registrations, and timers are sim state and serialize in canonical order.

**8. The cap is two budgets of different nature.**
- **Cache budget** (bytes, per host, invisible): dense slabs from a fixed pool reserved at init, LRU. Exploration consumes only cache, so it is **never refused**. Defaults: host 1,024 chunks = 4 MiB; client 1,024 chunks = 4 MiB (the client resident set is at most 15x15 = 225 chunks at unsubscribe ring 3).
- **State budget** (deterministic counts, part of world params, identical in every replay): `max_entities` default **262,144**, `max_modified_tiles` default **1,048,576**. It counts sim state, never allocator bytes or cache pressure. *Headroom* of a count is `(max − current) × nominal cost`, with nominal costs fixed by the engine rather than taken from `size_of`, so they are equal in every build: 128 B per entity, 12 B per modified tile (the figures of the split below). `max_action_growth` (world param, default **4 KiB** = 32 entities or 341 modified tiles) is the game's declared worst-case growth of one action. Writes are infallible (`0003-game-facing-api.md`), so the budget is enforced per action, before `apply`, when either headroom is below `max_action_growth`; that check and its rejection are owned by `0004-action-timing-and-rejection.md`. Tick-rule writes are never refused, so the budget is soft by that margin: a count may pass its limit through tick rules, the slack in the split below absorbs it, and a game whose tick rules create state without a player action bounds that itself.
- **Baseline-phone default (64 MiB world budget):** dense cache 4 MiB + entities 32 MiB (at 128 B each) + overlays 12 MiB (12 B per in-memory entry) + chunk indexes about 8 MiB + 8 MiB for lists, timers, players, and slack. At init the engine computes this sum from the real `size_of` of the game's entity types and fails startup if it exceeds the configured budget or the instance arena. Desktop and server may raise the budgets; the state budget is fixed per world.
- View bound (`0010-rates-and-subscriptions.md`): 256 tiles per axis spans at most 9 chunks, so at most 81 visible, 121 at ring 1, hard cap 128 subscribed = 512 KiB of dense terrain. Terrain is not the memory problem; entities are.

**9. Worldgen stamping.** Overlays only mean something against the `P` that produced them. World params, snapshots, and log segment headers carry the game-declared `WORLDGEN_VERSION: u32` and an engine-computed **worldgen fingerprint** (64-bit hash of the pristine tiles of 16 fixed chunks, near the origin and near ±2^18). On load, a mismatch in either yields the `SaveIncompatible` path of `0005-persistence-and-recovery.md`. The fingerprint catches a forgotten version bump; clients are covered by the build hash in the handshake (`0013-sessions-and-integrity.md`).

## Alternatives rejected

- **"Chunk generated" as a logged engine action applied at a tick** (Factorio-like): puts viewport-driven data in the log, contradicts "camera is not an action", and is where FFF-415 lived.
- **Rules fail or no-op on unmaterialized chunks:** cache timing becomes sim-visible.
- **Persist every generated chunk / neighbor-dependent generation** (Minecraft): forces streaming and large saves. **Tick only near players** (Minecraft tickets): depends on unlogged input and breaks "the furnace keeps smelting".
- **SoA tile layers with game-declared widths:** several slabs per chunk and worse locality for point lookups. **Tile-as-entity** (bevy_ecs_tilemap): per-tile overhead far above 4 bytes. **A dense `u32` occupant layer:** doubles chunk size for sparse data; hidden behind `entity_at(tile)` so it can change.
- **Uploading the sim slab verbatim as `rgba8uint`:** ties art to sim encoding, and no copy is saved because WASM memory is not visible to the main thread.
- **f64 sim positions** (needs a second quantized wire form, exposes NaN hazards); **i64 tile coordinates** (doubles keys for no benefit).
- **Rust trait objects or per-tile-type impls for traits:** dispatch per tile, not data, unusable from tables.
- **Spilling modified chunks to storage** (async I/O in the sim path); **refusing exploration at the cap** (memory pressure becomes sim-visible); **one byte-denominated cap** (bytes are not deterministic across builds).

## Consequences

- Snapshots and resyncs are small (params + overlays + entities) and independent of how much was explored.
- Every host pays generation on cache misses; bounded by `0008-chunk-generation.md`.
- A world created with raised state budgets on a desktop may fail the init check on a phone; the error is clean, not a crash.
- The engine fixes two 8-bit tile layers; a game needing more than 256 terrain or resource ids, or more than 32 bits per tile, needs a new ADR.
- `0020-testing-strategy.md` must include: replay one log with cache capacity 1, default, and unlimited, and with generation order shuffled; all state hashes equal. That mechanically proves cache invisibility.
- Deferred to Phase 2: entity store layout and `EntityId` reuse policy, because they depend on the provisional-id problem left open by `spikes/prediction-api`.
- Deferred to Phase 2: overlay promotion to a dense chunk at 512 entries and bucketed per-chunk area effects (FFF-421 style), because no v1 rule needs them; on-device validation of the 64 MiB split, because no engine code exists to measure.

## Sources

- `docs/research/world.md` sections 1.1, 1.3, 3.1, 3.4-3.8; `docs/research/client.md` 3.3, 3.5; `docs/research/sync.md` 3.3; `spikes/prediction-api/RESULT.md` (`Unknown` reads, trait tables); `spikes/determinism-hash/RESULT.md`.
- Factorio: desync at the generation seam https://www.factorio.com/blog/post/fff-415 ; map structure https://wiki.factorio.com/Map_structure ; fixed-point positions https://lua-api.factorio.com/latest/concepts/MapPosition.html ; collision masks https://lua-api.factorio.com/latest/types/CollisionMask.html ; sleep/wake https://www.factorio.com/blog/post/fff-67 , https://factorio.com/blog/post/fff-364 ; update buckets https://www.factorio.com/blog/post/fff-421
- Veloren overlay persistence: https://docs.veloren.net/src/veloren_server/terrain_persistence.rs.html
- Bevy `TilemapChunk` (one quad + per-tile data texture): https://github.com/bevyengine/bevy/pull/18866
- WebKit tab memory limits: https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit ; declared `maximum` on iOS: https://github.com/godotengine/godot/issues/70621
- `writeTexture` row alignment: https://webgpufundamentals.org/webgpu/lessons/webgpu-copying-data.html
