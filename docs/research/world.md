# Research: world

Phase 1 findings for the open questions in `docs/spec/world.md`. Evidence and recommendations, not decisions. All URLs accessed 2026-09-19.

Incorporates the spec correction of 2026-09-19 (`docs/spec/overview.md`, Fixed decisions): the camera is not an action, never mutates the world, and reaches the sim's host only as an unlogged subscription message.

## 1. Findings

### 1.1 Memory limits on phones (WASM + WebKit)

- **iOS tab budget.** A Jan 2026 deep-dive on WebKit RAM internals gives approximate per-tab limits: iPhone 8/X ~300-350 MB, iPhone 11/12 ~350-400 MB, iPhone 13/14 ~400-450 MB, iPhone 15+ ~1 GB+. WebKit's base threshold is `min(3 GB, min(physical_RAM, jetsam_limit))`, which "typically lands in the 300-450MB range for most devices currently in use". At 50% WebKit enters conservative mode, at 65% it discards all compiled JS, at 100% the page is killed and reloaded. This is whole-process memory (JS heap, WASM, JIT code, DOM, and GPU allocations on unified memory), not just linear memory. https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit
- **Jetsam hard limit.** Reports show the WebContent process killed at an ActiveHard limit of 2048 MB on iPhones (iPads get more), including on an iPhone 16 Pro on iOS 26.x. https://github.com/frankhinek/webkit-wasm-compiler-memory-repro
- **Declared `maximum` matters.** Godot's web export failed at `WebAssembly.Memory` construction on iOS Safari 16.2 purely because `maximum` was 2048 MB; declaring 256 MB fixed it. https://github.com/godotengine/godot/issues/70621
- **Engine-vendor guidance.** Unity's manual: heap growth "can cause your application to crash if the browser fails to allocate a contiguous memory block"; for mobile, set the initial size to typical usage rather than relying on growth. Community guidance for iOS is a 256 MB heap (384 MB "if you can accept that some iPhones will still fail"). https://docs.unity3d.com/6000.3/Documentation/Manual/webgl-memory.html , https://bugnet.io/blog/how-to-fix-unity-webgl-build-crashing-on-safari-ios
- **Shared + growable memory is fragile on iOS.** iOS 26.2 regressed multi-threaded WASM with growable memory (`RuntimeError: Out of bounds memory access`); workarounds were fixed-size memory or single-threading. Open as of the last update. https://github.com/emscripten-core/emscripten/issues/25905
- **Memory64** is standardized (Wasm 3.0) but was not in Safari as of Jan 2026, carries a performance penalty, and is irrelevant at our budgets. https://platform.uno/blog/the-state-of-webassembly-2025-2026/

Takeaway: plan for a whole-tab budget of about 300 MB on the baseline phone, declare a small `maximum`, prefer a fixed-size memory, and do not depend on WASM threads.

### 1.2 Determinism of generation in WASM

- The Wasm design's list of nondeterminism is short: feature availability, host call sequence, shared-memory races, **NaN bit patterns/sign**, **relaxed SIMD**, and resource exhaustion. Ordinary IEEE-754 float arithmetic is otherwise fully specified. https://github.com/WebAssembly/design/blob/main/Nondeterminism.md
- Relaxed SIMD explicitly "gave up determinism across different architectures". https://github.com/WebAssembly/spec/blob/wasm-3.0/proposals/relaxed-simd/Overview.md
- Consequence: the same WASM module running simplex noise with `+ - * / sqrt floor` on f32/f64 produces identical bits in V8, JSC, and SpiderMonkey, provided no NaN payload is ever observed and relaxed SIMD is off. Transcendentals (`sin`, `pow`) are compiled into the module from Rust's software libm on `wasm32-unknown-unknown`, so they are also identical WASM-to-WASM, but would differ from a native build that calls the system libm. Whether the server is WASM or native is `simulation.md`'s question; worldgen should be written to survive either answer (section 3.2).

### 1.3 Factorio facts used below

- Chunks are 32x32 tiles. The map limit is 2,000,000 tiles per side. Chunks generate "20 chunks distance in each direction around each player", slowly, or immediately when revealed. "Entire chunks are set inactive when nothing important is happening in them." https://wiki.factorio.com/Map_structure
- The far ring generates at about one chunk per second, giving at least 41x41 = 1,681 chunks per surface per stationary player. It exists for gameplay (so enemy nests spawn), not for rendering. https://forums.factorio.com/viewtopic.php?p=692095
- Positions are fixed-point: 32-bit with 8 fractional bits (1/256 tile). Tile position = floor of map position; chunk position = floor(tile / 32), rounding toward negative infinity. https://lua-api.factorio.com/latest/concepts/MapPosition.html , https://forums.factorio.com/viewtopic.php?t=101269
- Noise is a pure function: each point's value "can be calculated solely based on the point's coordinates and the map seed". Chunk generation cost fell from 18.35 ms to 2.83 ms per chunk with Noise Expressions 2.0. https://factorio.com/blog/post/fff-390
- **A seven-year desync bug lived exactly at the generation/sim seam.** With forced generation of several chunks, the number of parallel map-gen tasks depended on `hardware_concurrency()`, and the `on_chunk_generated` event let mods mutate tiles that later tasks read, so results depended on core count. https://www.factorio.com/blog/post/fff-415 , https://forums.factorio.com/113601
- Sleep/wake: an idle inserter "will go to sleep. It will also tell the chest and the transport belt to wake it up"; about 86% of inserters were asleep in a test save, nearly doubling update speed. https://www.factorio.com/blog/post/fff-67 Activation order matters for determinism, so wake-ups are queued, not applied immediately. https://factorio.com/blog/post/fff-364
- Chunk-scoped periodic work uses registration counters and update buckets: "we loop through 1 bucket each tick". https://www.factorio.com/blog/post/fff-421 Most entities "don't use the chunk system but update globally as needed". https://forums.factorio.com/viewtopic.php?t=107797
- "Can X be placed here" is a collision-mask intersection: tiles and entities each carry a set of layers; they collide if the sets share a layer (`water_tile` is one such layer). https://lua-api.factorio.com/latest/types/CollisionMask.html

### 1.4 Minecraft facts used below

- Chunk lifecycle is a ticket system: tickets (player, forced, portal) have a level that propagates outward; level 31 = entity ticking, 32 = block ticking, 33 = border (loaded, not ticked). Only chunks near a ticket simulate. https://minecraft.wiki/w/Chunk
- The server streams full chunks in a palette-compressed format (variable bits per entry). The client never regenerates terrain and is only given a hashed seed. https://minecraft.wiki/w/Java_Edition_protocol/Chunk_format
- Generation is multi-stage with neighbor dependencies (features may write into adjacent chunks), which is why a chunk is not a pure function of its own coordinates and why generated chunks must be persisted.

### 1.5 Rust prior art

- **Veloren terrain persistence** stores only modifications: per chunk a `HashMap<Vec3<i32>, Block>` that is overlaid on freshly generated terrain at load. Entries that equal the generator's output are dropped ("Reset any unchanged blocks (this is an optimisation only)"). Formats are versioned: "must always be able to load old formats". https://docs.veloren.net/src/veloren_server/terrain_persistence.rs.html
- **Bevy 0.17 `TilemapChunk`** renders a chunk as one quad; per-tile data (tileset index, visibility, tint) is uploaded as a small data texture and the tileset is a `texture_2d_array`. No per-tile geometry. https://bevy.org/news/bevy-0-17/ , https://github.com/bevyengine/bevy/pull/18866
- **bevy_ecs_tilemap** makes every tile an ECS entity. Useful as a counterexample: flexible, but per-tile overhead is far above a few bytes.

### 1.6 WebGPU facts relevant to the layout

- Default limits: `maxTextureDimension2D` 8192, `maxTextureArrayLayers` 256, `maxBufferSize` 256 MB. https://www.w3.org/TR/webgpu/
- The 256-byte `bytesPerRow` alignment applies to buffer-to-texture copies, not to `queue.writeTexture`, so a tightly packed 32-texel row uploads directly. https://webgpufundamentals.org/webgpu/lessons/webgpu-copying-data.html

## 2. Prior art: what to take

| Source | Take | Leave |
|---|---|---|
| Factorio | 32x32 chunks; floor-division coordinate math; fixed-point positions; generation as a pure function of (seed, coords); everything materialized keeps simulating; sleep/wake lists plus time-bucketed chunk work instead of scanning; collision-mask-style trait sets | Applying generation results *into* lockstep game state and raising a sim-visible "chunk generated" event (the FFF-415 bug class); the 20-chunk far ring (a gameplay feature) |
| Minecraft | Ticket/level idea as the model for *subscription* rings with hysteresis (not for ticking); palette compression if we ever stream full chunks | Ticking only near players; neighbor-dependent multi-stage generation; persisting every generated chunk; hiding the seed |
| Veloren | World state = generator output + sparse overlay; drop overlay entries equal to pristine; version the format | HashMap iteration in anything hashed or serialized (use ordered containers) |
| Bevy TilemapChunk | One quad per chunk + per-tile data texture; the CPU layout *is* the GPU layout | Tile-as-entity |

## 3. Recommendations

### 3.1 Async generation vs. determinism (the key tension)

**Recommendation (confidence: high).** Make the question disappear by definition:

1. **Pristine content is a total pure function.** `P(seed, params, chunk_coord) -> [Tile; N*N]`. Every chunk in the coordinate range "exists" to the sim at all times. There is no "ungenerated" state in the sim's vocabulary, and the game-facing `world.tile(pos)` is a total function with no "not loaded" error.
2. **World state is only what actions caused.** The sim's terrain state is a sparse per-chunk **overlay** of modified tiles, plus entities. Effective tile = `overlay(c).get(i)` else `P(c)[i]`. Snapshots, state hashes, and deltas contain overlays and entities, never pristine data.
3. **Materialized dense chunks are a cache.** `dense(c) = P(c) + overlay(c)`. Materialization and eviction are invisible to the sim and to replay. This is now forced, not just convenient: viewports are unlogged, so a replay has no viewport information at all and would diverge if anything viewport-driven were sim-visible.
4. **A sim read that misses the cache generates synchronously, inside the tick.** Because `P` is pure, the only observable effect is wall-clock latency. Async pre-generation is purely a cache warmer. The spec's two candidate rules ("block on sync generation" and "defined to see pristine content") are the same rule seen from the implementation and from the semantics.
5. **Rules that keep `P` pure** (engine-enforced by the generator's signature: it receives seed, params, coords, and an output slice, and nothing else):
   - No reading or writing neighbor chunks. Features that cross borders (ore patches, forests) come from the continuous noise field or from a per-region feature hash evaluated independently by each chunk it touches.
   - No sim-visible "chunk generated" event, ever. A game that wants "on first explored" semantics must drive it from an action.
   - Generation never allocates entity IDs or touches sim RNG. In v1 the generator outputs tile data only. If generator-spawned entities are needed later, their IDs derive from coordinates.
   - Single-threaded per chunk; parallelism only across chunks. No relaxed SIMD. Prefer integer/fixed-point hashing and `+ - * / sqrt floor`; avoid transcendentals unless the server is confirmed to run the same WASM (section 1.2).
6. **Canonical overlay:** an overlay never holds an entry equal to pristine (Veloren's optimization, promoted to an invariant), so state hashes are canonical. This is deterministic because a write always materializes the chunk first.

Cost check: the reference generator is about 1,024 tiles x (2-3 fields) x (4-5 octaves), roughly 10-15k noise evaluations, well under 1 ms in WASM on a phone-class core (Factorio's far heavier pipeline is 2.83 ms). A sync miss inside a 33-50 ms tick is tolerable, and misses are rare because rules read near player entities and buildings, which the warmer covers. Full-speed replay simply runs all generation synchronously.

**Rejected:** (a) treating "chunk generated" as a logged engine action applied at a tick (Factorio-like). It works for lockstep but puts viewport-driven data into the log, contradicts "camera is not an action", and is where Factorio's bug lived. (b) Rules failing or no-op'ing on unmaterialized chunks: makes cache timing sim-visible.

### 3.2 Client regeneration vs. server streaming full chunks

**Recommendation (confidence: medium-high): clients regenerate pristine terrain from the seed; the server sends only overlays and entities.** Single-player uses the identical path.

Why, given our constraints rather than Minecraft's:
- The client already ships the game's WASM (prediction), and prediction already requires cross-engine determinism. Worldgen adds no new class of risk, only more surface.
- **Reconnect is the common path on mobile** (`sync.md`). Resync cost becomes overlays + entities, independent of zoom level.
- **No pop-in.** The camera is client-side and unlogged; the client can generate ahead of the camera with zero round trips, whereas the server learns of a viewport one RTT late.
- **Prediction on partial state gets easier.** The predicting instance has total terrain knowledge (sync-generate on miss); only entities/overlays outside the subscription are unknown.
- **Server cost.** The server never generates or holds chunks merely because someone looks at them, only those its rules read.
- Seed secrecy is irrelevant for friends playing co-op.

Bandwidth is *not* the deciding factor: a 4 KB chunk compresses to a few hundred bytes, and a worst-case 345-chunk subscribe is roughly 1.4 MB raw, maybe 150-250 KB compressed. Streaming would be feasible; it is rejected because it is slower to first pixel, makes reconnects heavier, and doubles server work, while buying nothing in a trusted co-op setting. Minecraft streams because its generation is expensive, neighbor-dependent, and secret; none apply.

Safeguards: build/worldgen hash in the version handshake (already an open question in `sync.md`); CI golden chunk hashes across engines; optionally the client reports a hash of a sampled pristine chunk and the server verifies in idle time. Keep the chunk-enter message shape able to carry a full tile payload later, but do not build that path in v1.

### 3.3 Where generation runs; prioritization, cancellation, margin

**Recommendation (confidence: medium-high).**

- **Game-facing API:** one pure, synchronous, non-allocating function, e.g. `fn generate(&self, params: &WorldParams, chunk: ChunkCoord, out: &mut [Tile])`. The engine supplies the asynchrony by choosing where and when to call it.
- **Client:** 1 generation worker by default (2 on desktop), each instantiating the same compiled `WebAssembly.Module` (compile once, instantiate per worker). Generation workers hold no world state, so their memory is small and fixed.
- **Sim host (worker or server):** synchronous on cache miss, plus an optional warmer that runs in the idle gap between ticks under a time budget (about 2 ms), targeting chunks around player entities and current subscriptions. Both inputs are fine because the cache is invisible. No extra threads, no shared memory.
- **Queueing:** the priority queue lives with the requester, not in the worker. At most 2 jobs in flight per worker. Priority = (ring class: visible, then margin, then lookahead), then distance from a lookahead point `camera + velocity * 0.5 s`. Re-prioritize when the camera crosses a chunk boundary or zoom changes; the queue is a few hundred entries in a preallocated array, sorted in place.
- **Cancellation:** drop not-yet-dispatched requests that left the keep-radius. Never cancel in-flight jobs (they cost under 1 ms); a late result is cached anyway.
- **Margins (in chunk rings around the visible rectangle):** ring 1 = generate + upload + subscribe; ring 2 = generate only, biased toward the direction of motion; unsubscribe/un-upload at ring 3 (hysteresis; exact values belong to `sync.md`). Factorio's 20-chunk ring is a gameplay feature and not copied.
- Throughput sanity: a fling at two viewport-widths per second fully zoomed out exposes about 260 new chunks/s, or about 130 ms of CPU per second at 0.5 ms/chunk. One worker suffices.

**Rejected:** a generation pool using WASM threads/shared memory (iOS fragility per 1.1, and ordering hazards per FFF-415); generating only inside the sim and streaming to the renderer (adds a hop and makes the sim host pay for viewing).

### 3.4 Coordinate types and far-from-origin rendering

**Recommendation (confidence: high for tile/chunk types and camera-relative rendering; medium for the fixed-point position type).**

- `TilePos { x: i32, y: i32 }`. `ChunkCoord { x: i32, y: i32 } = tile >> CHUNK_BITS` (arithmetic shift = floor division, correct for negatives as in Factorio). Local index = `(y & MASK) << CHUNK_BITS | (x & MASK)`. **Chunk size must be a power of two**: 16, 32, or 64; default 32.
- Chunk map key: `u64 = (cx as u32 as u64) << 32 | cy as u32`. Any container that is iterated for hashing, snapshotting, or deltas must be ordered (BTreeMap or sorted Vec); hash maps are lookup-only with a fixed hasher.
- Continuous positions (players, anything moving): `WorldPos` = fixed-point **Q24.8 in an i32 per axis** (1/256 tile), as Factorio. One representation for sim, wire, and hashing; 4 bytes per axis; exact equality; no NaN hazard. 1/256 tile is 1/8 px at 32 px per tile; clients interpolate in f32 camera-relative space. Velocities and spring state can carry more precision.
- Playable range is therefore **+/-2^23 = 8,388,608 tiles per axis** (4x Factorio's 1M). At 10 tiles/s that is 9.7 days of walking. Movement clamps at the edge. This is what "infinite" means in practice.
- **Rendering is camera-relative, always.** f32 has a 24-bit mantissa: at 100,000 tiles its resolution is 1/128 tile (visible shimmer when zoomed in); at 8M tiles it is a whole tile. The CPU computes `chunk_origin - camera` in integers/f64 and passes a small f32 offset per chunk; in-chunk coordinates are 0..32. Per-tile visual randomness and dithering must hash **integer** absolute tile coordinates in WGSL (`i32`/`u32`), never f32 world positions.

**Rejected:** f64 positions in the sim (pleasant to write, but needs a second quantized form for the wire and ties correctness to the float-determinism answer); i64 tile coordinates (no benefit; doubles keys).

### 3.5 Chunk data layout

**Recommendation (confidence: medium).** Three separate structures per chunk, because they have different lifetimes:

| Structure | Contents | Is it world state? | Lifetime |
|---|---|---|---|
| `ChunkTerrain` | Dense `[Tile; 1024]`, row-major | No (cache of `P + overlay`) | LRU-evictable, pooled 4 KiB slab |
| `ChunkOverlay` | Sorted `Vec<(u16 local_index, Tile)>` | **Yes** | Exists only for chunks with modified tiles |
| `ChunkIndex` | Occupancy bitset (128 B) + sorted `(u16 local_index, EntityId)` pairs + list of overlapping entity IDs | Derived from entities; rebuilt on load | Exists only for chunks with entities; never evicted |

- **Tile = 4 bytes, packed AoS:** `#[repr(C)] struct Tile { base: u8, resource: u8, aux: u16 }`. The engine treats it as an opaque `u32` with game-declared bit fields (`aux` might be the remaining resource amount). A 32x32 chunk is exactly **4,096 bytes**: one page-sized slab, 64 cache lines.
- **Why AoS, not SoA layers:** the sim's access pattern is random point lookups (placement checks, range queries), not per-layer sweeps, because tiles do not tick. One cache line yields every layer of a tile. And the slab uploads verbatim as one `rgba8uint` 32x32 `writeTexture` with no repacking.
- **GPU side (for `client.md` to confirm):** a single data atlas, e.g. 2048x2048 `rgba8uint` = 4,096 chunk slots = 16 MiB, rather than a texture array (the default 256-layer limit is below our visible-chunk count). One quad per chunk, Bevy-style.
- **Per-tile randomness, variants, and dithering cost zero bytes:** derived in the shader from an integer hash of tile coordinates.
- **Entities are not stored in chunks.** They live in global, type-segregated stores keyed by `EntityId`. Chunks only index them.
- **Multi-tile buildings across borders:** the entity is stored once with an anchor tile (min corner) and a footprint from its prototype. Every covered tile sets its occupancy bit and `(local_index, EntityId)` entry in whichever chunk owns that tile, and the entity is listed in each overlapped chunk's `ChunkIndex` (at most 4 if footprint <= chunk size, which the engine should assert). Placement and removal update all overlapped chunks within one tick. **An entity is relevant to a client if any overlapped chunk is subscribed**, not just its anchor chunk.
- Overlay promotion: when an overlay reaches 512 entries (its size equals a dense chunk), it may be promoted to an owned dense chunk. Optional optimization; not for v1.

Back-of-envelope:

| Scenario (32x32 chunks) | Tiles across | Visible chunks | + ring 1 |
|---|---|---|---|
| Phone 430x932 CSS px at 8 px/tile | 54 x 117 | 3 x 5 = 15 | 5 x 7 = 35 |
| Phone at 4 px/tile | 108 x 233 | 5 x 9 = 45 | 7 x 11 = 77 |
| Desktop 2560x1440 at 8 px/tile | 320 x 180 | 11 x 7 = 77 | 13 x 9 = 117 |
| Desktop 2560x1440 at 4 px/tile | 640 x 360 | 21 x 13 = 273 | 23 x 15 = 345 |
| 4K 3840x2160 at 8 px/tile | 480 x 270 | 16 x 10 = 160 | 18 x 12 = 216 |

So the worst plausible subscription is about 350 chunks, or 1.4 MB of dense terrain. 1,024 cached chunks = 4 MiB; 16,384 chunks (a 4096x4096-tile area) = 64 MiB. **Terrain is not the memory problem; entities will be.**

**Rejected:** SoA layers with game-declared element widths (more flexible, but more plumbing, several uploads per chunk, worse locality for point lookups; revisit if a game needs more than 32 bits per tile); a dense `u32` occupant layer per chunk (doubles chunk size for data that is sparse in this genre's early game; hide the choice behind `occupant_at(tile)` so it can change).

### 3.6 Traits ("cannot be built on")

**Recommendation (confidence: high).** Data-driven bit sets, Factorio collision-mask style:

- `TraitSet(u64)`. The game declares trait constants (`NOT_BUILDABLE`, `NOT_WALKABLE`, `COLLECTABLE`, ...). The engine defines the mechanism and no trait meanings.
- The game registers lookup tables at startup: one `TraitSet` per value of each tile field (`base_traits[256]`, `resource_traits[256]`) and one per entity prototype.
- The engine provides `world.traits_at(tile) -> TraitSet` = OR of the tile's field traits and the occupant's prototype traits. Cost: two or three table lookups and a bit test.
- The reference rule becomes: every tile of the footprint satisfies `!traits_at(t).contains(NOT_BUILDABLE)`. Water's table entry carries the bit; so does the furnace prototype, so "not on water" and "not on other buildings" are the same query, and neither names a tile type.
- The same tables exist in the client's WASM instance, so placement ghosts and prediction use the identical query with no TypeScript duplicate.

**Rejected:** Rust trait objects or per-tile-type `impl`s (dynamic dispatch per tile, not data, unusable from tables or the GPU); ECS-style component queries on tiles (tile-as-entity overhead).

### 3.7 Which chunks tick

**Recommendation (confidence: high).** Everything that exists simulates, regardless of who is watching. With viewports unlogged, "only subscribed chunks tick" is no longer merely undesirable; it would make the sim depend on non-replayable input. And since chunks are terrain caches plus indexes, **chunks do not tick at all; entities do.**

- Per-system **active lists** in deterministic order (by activation order, with wake-ups queued and applied at a fixed point in the tick, as Factorio does).
- **Sleep/wake:** an entity with nothing to do leaves the active list and registers a wake condition with whatever it waits on.
- **Timer wheel** keyed by `(tick, EntityId)` for "wake me at tick T". A furnace with fuel and ore computes its finish tick and sleeps; an idle world costs about zero per tick.
- Tick cost is O(active entities), never O(chunks). No scan exists to optimize.
- If a game later needs area effects (pollution-like), use Factorio's bucketed per-chunk registration (FFF-421), keyed by chunks that contain registrants, never by materialized chunks.

**Rejected:** Minecraft-style ticking radius around players.

### 3.8 The cap, eviction, and the memory ceiling

**Recommendation (confidence: medium).** Split "max world size" into two budgets with different natures:

1. **Cache budget (bytes; per host; invisible).** Pristine/dense chunks. LRU eviction; "touch" on sim read or on visibility. Exploration is never refused, because exploring consumes only evictable cache. Slabs come from a fixed pool and are reused, which suits WASM memory that never shrinks.
   - Sim host default: 1,024 chunks = 4 MiB. Client default: 2,048 chunks = 8 MiB CPU, plus a 16 MiB GPU atlas.
2. **State budget (deterministic units; part of world params; sim-visible by design).** Limits such as `max_entities` and `max_modified_tiles`, stamped into the world's params and therefore identical in every replay. When reached, the action that would add state is rejected through the normal action-rejection path. This is deterministic because it counts sim state, never allocator bytes or cache pressure. Defaults: `max_entities = 262,144` (about 32 MiB at about 128 B each), `max_modified_tiles = 1,048,576` (about 8-16 MiB).

This answers "what if modified chunks alone exceed the cap": modified chunks are not pinned dense chunks at all, only sparse overlays, so the limit is far away, and when reached it is a deterministic rule about *building*, never about *looking*.

**Default ceiling for a phone:**
- Declare every instance's `WebAssembly.Memory` with **`maximum` = 256 MiB**, and prefer allocating the world arena up front at a fixed size so memory never grows mid-session (no detached views, no iOS growth failures).
- Default **sim world budget = 64 MiB**. Whole-tab target **under 300 MB** (baseline: iPhone 12-class, per 1.1), covering sim instance, client/prediction instance, generation worker, JS, and GPU.
- Desktop and server can raise both via config; the state budget must be the same value everywhere for a given world because it is sim-visible.

**Rejected:** spilling modified chunks to storage (async I/O inside the sim path, contradicts "fits in memory"); refusing exploration at the cap (makes memory pressure sim-visible, and viewports are not even sim input now); a single byte-denominated cap (bytes are not deterministic across allocators and builds).

## 4. Cross-domain interactions

**Sync**
- Chunk-enter message = overlay + entities overlapping the chunk. Chunk-leave frees client-side entity state; the pristine cache is independent and persists, so panning back is free.
- Entity relevance must consider every chunk a footprint overlaps.
- Per-chunk desync hash = hash(canonical overlay + entities). Pristine terrain is covered by the build hash in the handshake and optional sampled hashes.
- Viewport clamp: recommend clamping by *tiles across* (default 640 x 384 tiles, about 345 chunks with ring 1) rather than by pixel scale, since tiles across is what bounds cost.
- Subscriptions are host-side, unlogged, non-sim state. Nothing in the sim may read them.

**Simulation**
- `world.tile()` and `world.traits_at()` are total on the sim. On the predicting client, terrain is total too; only entity/overlay knowledge is partial, so the prediction API needs "unknown" only for occupancy outside the subscription.
- Snapshots hold params + overlays + entities, no dense terrain: small and cheap. But a snapshot is only meaningful against the same worldgen; stamp `worldgen_version` next to the sim version.
- State hashing must exclude all caches and LRU bookkeeping.
- A valuable test (`testing.md`): replay the same log with cache sizes 0, 1, and unlimited, and with generation order shuffled; state hashes must match. That mechanically proves cache invisibility.
- **Conflict to flag:** `reference-game.md` notes say the player follows the camera and that the spring runs in the sim "driven by the engine-defined camera action". Under the corrected spec, the camera cannot drive sim state. Player movement needs a game-defined action (e.g. a move-target), separate from the camera. Not this file's to resolve.

**Runtime and packaging**
- Supports "preallocate a fixed arena from the game's cap" over grow-on-demand; supports *not* using WASM threads.
- Worker topology gains a client-side generation worker; one compiled module instantiated per role.
- Moving 4 KiB slabs from a generation worker to the renderer needs either a SharedArrayBuffer ring or pooled transferable buffers. Naive `postMessage` copies create garbage.

**Client**
- Camera-relative transforms and integer-hash tile variation are requirements, not polish.
- Data-atlas slot allocation mirrors the client LRU; upload is one `writeTexture` per chunk from a cached view of WASM memory.
- The client applies overlays to generated chunks before upload, and patches single texels on tile deltas.

## 5. Needs a spike

1. **Cross-engine bit-identical worldgen and its cost.** Generate about 10,000 chunks with the reference simplex generator in Chrome (V8), Firefox (SpiderMonkey), Safari on macOS and on a real iPhone (JSC), and the candidate server runtime(s); compare hashes; record ms per chunk on the phone. Client regeneration (3.2) and the sync-miss budget (3.1) both hinge on this. Shared with the determinism question in `simulation.md`. If a native server is on the table, include a native build.

Not required for a decision, but cheap and belongs to runtime: an on-device "allocate until killed" probe on Tyler's phone to validate the 300 MB tab budget.

## 6. Questions for Tyler

1. **"Infinite" means +/-8.4 million tiles per axis** (i32 fixed-point positions; 4x Factorio), with movement clamped at the edge. OK? *Default: yes.*
2. **Worldgen ships to every client and the seed is known to players** (no hidden-map secrecy). OK for co-op? *Default: yes.*
3. **May a worldgen change invalidate existing saves during prototyping?** Saves store only modifications on top of generated terrain, so changing the generator changes terrain under old buildings. *Default: yes, saves may break; stamp a worldgen version and refuse mismatched loads.*
4. **Maximum zoom-out.** Proposed clamp: 640 x 384 tiles visible (about 4 CSS px per tile on a 2560-wide display; about 350 chunks). Taste: is that far enough out, or too far for pixel art? *Default: as proposed, per-game configurable.*
5. **Baseline phone.** Proposed: iPhone 12-class, implying a whole-tab budget under 300 MB and a 64 MiB default sim world budget. *Default: as proposed.*
6. **Does any planned game need generator-spawned entities (trees or enemies as entities rather than tile data) in v1?** The reference game does not. *Default: no; tile data only.*

## Spike results

- **Bit-identical worldgen:** confirmed for the restricted float subset across V8, JSC, SpiderMonkey and native aarch64/x86-64 Linux; ~0.1 ms per chunk. Not tested: a real iPhone, real x86 hardware. See `spikes/determinism-hash/RESULT.md`.
