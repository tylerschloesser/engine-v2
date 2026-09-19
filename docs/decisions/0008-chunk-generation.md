# 0008: Chunk generation: one pure function, run wherever it is needed

Status: Accepted (2026-09-19)

## Context

`0007-world-model.md` makes pristine terrain a pure function and dense chunks an invisible cache. That leaves the questions in `docs/spec/world.md` about generation itself: what the game writes, where it runs, whether clients regenerate terrain or the server streams it, and how requests follow the camera. Requirements fix that generation is async, deterministic, game-owned, tile-only in v1, and that worldgen code and the seed ship to clients. Forces:

- Every client already loads the game's `.wasm` for prediction, and the same `.wasm` runs on the server (`0002-determinism-same-wasm-everywhere.md`), so bit-identical generation on every machine is available, and `spikes/determinism-hash` measured it.
- The camera is client-side and unlogged (`0001-camera-and-presence.md`); the host learns of a viewport one RTT late. Reconnect is the common path on mobile.
- Stable Rust only: no WASM threads, no shared WASM memory (`0015-threads-memory-and-topology.md`).

## Decision

**1. The game writes one pure, synchronous, non-allocating function.**
```rust
pub trait Worldgen {
    type Params: Serialize + DeserializeOwned;      // stored in world params next to the seed
    /// Must write every element of `out` (row-major, CHUNK_AREA tiles). No other inputs exist.
    fn generate(seed: u64, params: &Self::Params, chunk: ChunkCoord, out: &mut [Tile]);
}
```
The signature is the enforcement: no `&self`, no world handle, no RNG, no clock. The engine supplies all asynchrony by choosing where and when to call it. Rules the engine documents and tests:
- No reading or writing neighbor chunks. Features that cross borders come from the continuous noise field or from a per-region hash that each touched chunk evaluates independently.
- Randomness only from the engine's stateless coordinate hash `hash2(seed, x, y) -> u64`; never the sim PRNG. No entity ids, no sim-visible event, no entities in v1.
- One chunk is generated single-threaded; parallelism exists only across chunks.
- **Noise coordinates are f64** (or an integer lattice coordinate plus a float fraction). f32 coordinates are equally deterministic but misclassify about 1.4% of tiles near ±8M tiles, and f64 measured the same speed. The allowed float operations, the ban on std transcendentals, and the NaN rules are in `0002-determinism-same-wasm-everywhere.md`; worldgen is sim-grade code under those rules.
- Per-chunk, not per-tile: the generator can hoist per-chunk setup, and the engine never pays a call per tile. `world.tile(pos)` is answered from the dense cache.

**2. Where it runs.** The same function, in three places, all feeding caches that nothing deterministic can observe:

| Place | When | Notes |
|---|---|---|
| **Client worldgen workers** | async, ahead of the camera | 1 worker by default, 2 when `navigator.hardwareConcurrency >= 8`; per-game config. Each is an instance of the one compiled module in a `gen` role with a tiny arena and no world state. Requests and 4,096-byte result slabs move over SAB rings (`0015`). Worker count cannot affect results, only latency: the opposite of FFF-415. |
| **Sim host, synchronous on cache miss** | inside the tick, when a rule or `apply` reads an uncached chunk | The semantic backstop. Also used by the client-role instance when prediction reads a subscribed chunk its workers have not delivered yet. Full-speed replay generates everything this way. |
| **Sim host warmer** | in the idle gap between ticks, budget **2 ms** | Warms uncached chunks inside each client's *visible* rectangle (where actions will land), nearest to the view center first. It may read subscriptions because the cache is invisible to the sim. No extra threads on the server; identical in the single-player sim worker. The host never receives chunks from workers. |

**3. Clients regenerate pristine terrain; the server sends only overlays and entities.** Single-player uses the identical path. On chunk enter, inside frame T, the host sends either an entry in a batched **pristine list** (coordinate only, about 3 bytes) or a **chunk snapshot** `{coord, version, overlay, entities whose footprint overlaps}` consistent as of the end of tick T; deltas start at T+1. Chunk leave frees the client's overlay and entity state; its pristine cache is separate and survives, so panning back costs nothing. Encoding is owned by `0011-wire-format-and-deltas.md`, which reserves a section id for a full tile payload; v1 does not build that path. A generated chunk is uploaded as pristine immediately and patched when its snapshot arrives; until then reads of it are `Unknown` to prediction (`0012-prediction-and-reconciliation.md`).

**4. Prioritization and cancellation.** The queue lives in the client worker (the requester), in a preallocated array of a few hundred entries sorted in place.
- Priority = ring class (visible, then ring 1, then ring 2), then distance to the look-ahead point `camera + velocity * 0.5 s`. Re-sort when the camera crosses a chunk boundary or a zoom change alters the chunk set.
- At most 2 jobs in flight per worker, so re-prioritization takes effect within about 1 ms of work.
- Cancellation = dropping not-yet-dispatched requests that fall outside ring 3. In-flight jobs are never cancelled (they cost well under 1 ms) and a late result is cached anyway.

**5. Pregeneration margin** (rings of chunks around the visible rectangle; subscription rings are decided in `0010-rates-and-subscriptions.md`): **ring 1 = generate + upload; ring 2 = generate only, direction of motion first; retain through ring 3**, then LRU. The generation set is always a superset of the subscription set, because both use the shared look-ahead function. At the view bound (256 tiles per axis, at most 9x9 visible chunks) that is at most 13x13 = 169 generated and 15x15 = 225 retained, against a 1,024-chunk client cache. No Factorio-style 20-chunk ring: that is a gameplay feature.

**6. Measured cost and the budgets it implies.** `spikes/determinism-hash`: a 32x32 chunk at 8 simplex evaluations per tile (5-octave height + 3-octave moisture) plus a scatter hash costs **0.09-0.11 ms in every engine** (V8, JSC, SpiderMonkey), 1.1-1.3x native release, with 12 KiB of hashing inside the timed region; f64 costs the same as f32. A phone core is *extrapolated* (not measured) at 0.3-0.5 ms.

| Case | Chunks | Desktop | Phone (est.) |
|---|---|---|---|
| Join at full zoom-out, visible set | 81 | 8 ms | 25-40 ms |
| Join, through ring 2 | 169 | 17 ms | 50-85 ms |
| Fling at 2 view-widths/s (16 columns x 13 rows per second) | 208/s | 21 ms/s | 60-105 ms/s |
| Sim miss under a 2x2 footprint on a chunk corner | 4 | 0.4 ms | 1.2-2 ms of a 50 ms tick |

One worker suffices everywhere. **Generator budget: at most 1 ms per chunk on the baseline phone**, policed as a desktop benchmark that warns above 0.25 ms per chunk. Within that budget a worst-case miss stays under a tenth of a tick, and the warmer covers about 20 chunks per tick on a server.

## Alternatives rejected

- **Server streams full chunks** (Minecraft): feasible (a 4 KiB chunk compresses to a few hundred bytes) but slower to first pixel, makes every reconnect scale with zoom, and makes the host generate and hold chunks merely because someone looks at them. Minecraft streams because its generation is expensive, neighbor-dependent, and secret; none apply (no map secrecy is a Requirement).
- **Generate only inside the sim and hand slabs to the renderer:** adds a hop and makes the sim host pay for viewing.
- **A worker pool feeding the sim host:** needless at 0.1 ms per chunk; a second code path between browser and server.
- **WASM threads / shared-memory generation pool:** not on stable Rust, fragile on iOS, and the ordering hazards of FFF-415.
- **A per-tile `pristine(pos) -> Tile` game function:** repeats per-chunk setup 1,024 times and invites calling it outside the cache.
- **Async generation visible to the sim (a tick waits for, or skips, a missing chunk):** rejected in `0007-world-model.md`.
- **f32 noise coordinates:** visible terrain degradation far from the origin for no speed gain.

## Consequences

- Worldgen correctness rests on the same-`.wasm` rule plus the handshake build hash (`0013-sessions-and-integrity.md`) and the worldgen fingerprint (`0007-world-model.md`). `0020-testing-strategy.md` keeps the spike as a permanent golden-hash test across Node, Bun, Chromium, Firefox, and WebKit, hashing raw tile bytes.
- A slow game generator degrades tick time on cache misses; the benchmark budget is the only guard.
- The client holds worldgen workers and a pristine cache even in multiplayer; the server holds no chunk merely because it is viewed (only the small warmed set).
- Deferred to Phase 2: measuring ms per chunk on a real iPhone and mid-range Android, because no dev server exists to serve the driver page; the 1 ms budget and worker count are revisited with that number.
- Deferred to Phase 2: a sampled pristine-hash check between client and server, because under one `.wasm` a divergence is a toolchain bug that the golden-hash test catches first.
- Deferred to Phase 2: whether noise helpers (f64 simplex fBm) move from the reference game into the engine crate, because the spec makes the algorithm the game's and only one game exists.

## Sources

- `spikes/determinism-hash/RESULT.md` (hashes, timing table, f32 precision at ±8M tiles, rules for a deterministic crate).
- `docs/research/world.md` sections 1.2-1.4, 3.1-3.3; `docs/research/sync.md` 3.1, 3.3 (chunk enter/leave, pacing); `docs/research/client.md` 3.6, 3.10 (look-ahead, view bound).
- Factorio: pure noise and cost per chunk https://factorio.com/blog/post/fff-390 ; desync from parallel map generation https://www.factorio.com/blog/post/fff-415 ; far generation ring https://wiki.factorio.com/Map_structure
- Minecraft chunk streaming: https://minecraft.wiki/w/Java_Edition_protocol/Chunk_format
- WebAssembly nondeterminism (NaN bits, relaxed SIMD): https://github.com/WebAssembly/design/blob/main/Nondeterminism.md
- iOS shared growable memory regression: https://github.com/emscripten-core/emscripten/issues/25905
