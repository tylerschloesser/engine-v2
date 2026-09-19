# World

## Requirements

- An infinite 2D grid world, split into chunks.
- How the world is generated (e.g. noise and octaves) and the tile art are the game's responsibility.
- The engine manages the viewport, knows which chunks are visible, and requests chunk generation. Chunk generation is async.
- Generation is deterministic: the same seed, parameters, and chunk coordinates produce the same chunk everywhere.
- Chunk size and max world size (chunk count or bytes) are configurable per game.
- The world can be assumed to fit in memory.

- "Infinite" means about ±8.4 million tiles per axis (±2^23 = 8,388,608).
- Worldgen code and the seed ship to clients; there is no map secrecy.
- In v1, worldgen emits tile data only: no generator-spawned entities.

**Reading of "infinite" + "max world size":** coordinates are unbounded; the cap applies to *materialized* chunks held in memory.

## Open questions

- **Behavior at the cap.** Decided in [0007](../decisions/0007-world-model.md).
- **Client regeneration vs. server streaming.** Decided in [0008](../decisions/0008-chunk-generation.md).
- **Chunk data layout.** Decided in [0007](../decisions/0007-world-model.md); GPU texel format in [0018](../decisions/0018-renderer.md).
- **Tile and entity traits.** Decided in [0007](../decisions/0007-world-model.md).
- **Where generation runs, prioritization, cancellation, margin.** Decided in [0008](../decisions/0008-chunk-generation.md).
- **Coordinate types and far-from-origin precision.** Decided in [0007](../decisions/0007-world-model.md); camera-relative rendering in [0018](../decisions/0018-renderer.md).
- **Async generation vs. determinism.** Decided in [0007](../decisions/0007-world-model.md) and [0008](../decisions/0008-chunk-generation.md).
- **Which chunks tick.** Decided in [0007](../decisions/0007-world-model.md).
- **Memory ceiling.** Decided in [0007](../decisions/0007-world-model.md); instance arenas in [0015](../decisions/0015-threads-memory-and-topology.md).
