# World

## Requirements

- An infinite 2D grid world, split into chunks.
- How the world is generated (e.g. noise and octaves) and the tile art are the game's responsibility.
- The engine manages the viewport, knows which chunks are visible, and requests chunk generation. Chunk generation is async.
- Generation is deterministic: the same seed, parameters, and chunk coordinates produce the same chunk everywhere.
- Chunk size and max world size (chunk count or bytes) are configurable per game.
- The world can be assumed to fit in memory.

- "Infinite" means at least ±8.4 million tiles per axis.
- Worldgen code and the seed ship to clients; there is no map secrecy.
- In v1, worldgen emits tile data only: no generator-spawned entities.

**Reading of "infinite" + "max world size":** coordinates are unbounded; the cap applies to *materialized* chunks held in memory.

## Open questions

- What happens at the cap? Unmodified chunks can be evicted and regenerated from the seed. What if modified chunks alone exceed it: refuse further exploration, spill to storage, or something else?
- In multiplayer, does the client regenerate pristine terrain locally from the seed (server sends only modifications) or does the server stream full chunk data? The first saves bandwidth but requires bit-identical generation on every client, and means worldgen code ships to clients.
- Chunk data layout: layers (base tile, resource, building occupancy), tiles vs. entities, multi-tile buildings that span chunk borders, memory layout friendly to both the sim and the GPU upload path.
- How tiles and entities declare traits such as "cannot be built on", so rules query traits instead of hard-coding tile types (see `reference-game.md`).
- Where generation runs (inside the sim, a worker pool, both client and server), and how requests are prioritized and cancelled as the camera moves. How far beyond the viewport to pre-generate.
- Coordinate types, and rendering precision far from the origin (camera-relative rendering).
- **Async generation vs. determinism.** Generation is async and triggered by viewports, but the sim must stay deterministic. The sim must never observe *whether* or *when* a chunk finished generating, or replay diverges. Define when a chunk "exists" to the sim: e.g. a rule that touches an ungenerated chunk (a 2x2 placement across a border, a collection-range query) either blocks the tick on synchronous generation or is defined to see pristine content as a pure function of the seed. The same applies to eviction at the cap: "refuse further exploration" would make memory pressure sim-visible.
- **Which chunks tick.** Does the sim update everything materialized (a furnace keeps smelting with nobody watching; Factorio's model) or only subscribed chunks? The first is assumed by the reference game; it needs an active-entity structure that doesn't scan every chunk each tick.
- **Memory ceiling.** "Fits in memory" means WASM linear memory: 4 GB hard limit on wasm32, far lower in practice on mobile Safari, memory never shrinks, and growth detaches JS views of the buffer (see `runtime-and-packaging.md`). The per-game cap in bytes needs a realistic default for a phone.
