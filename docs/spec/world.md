# World

## Requirements

- An infinite 2D grid world, split into chunks.
- How the world is generated (e.g. noise and octaves) and the tile art are the game's responsibility.
- The engine manages the viewport, knows which chunks are visible, and requests chunk generation. Chunk generation is async.
- Generation is deterministic: the same seed, parameters, and chunk coordinates produce the same chunk everywhere.
- Chunk size and max world size (chunk count or bytes) are configurable per game.
- The world can be assumed to fit in memory.

**Reading of "infinite" + "max world size":** coordinates are unbounded; the cap applies to *materialized* chunks held in memory.

## Open questions

- What happens at the cap? Unmodified chunks can be evicted and regenerated from the seed. What if modified chunks alone exceed it: refuse further exploration, spill to storage, or something else?
- In multiplayer, does the client regenerate pristine terrain locally from the seed (server sends only modifications) or does the server stream full chunk data? The first saves bandwidth but requires bit-identical generation on every client, and means worldgen code ships to clients.
- Chunk data layout: layers (base tile, resource, building occupancy), tiles vs. entities, multi-tile buildings that span chunk borders, memory layout friendly to both the sim and the GPU upload path.
- How tiles and entities declare traits such as "cannot be built on", so rules query traits instead of hard-coding tile types (see `reference-game.md`).
- Where generation runs (inside the sim, a worker pool, both client and server), and how requests are prioritized and cancelled as the camera moves. How far beyond the viewport to pre-generate.
- Coordinate types, and rendering precision far from the origin (camera-relative rendering).
