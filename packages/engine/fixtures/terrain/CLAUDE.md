# fixtures/terrain (`fx-terrain`)

The renderer data-path fixture (docs/plan/09-renderer-terrain.md, step 5): not real worldgen --
`FixtureTerrain::generate` is deterministic (chunk (0, 0) grass with one ore tile at local index 5,
chunk (1, 0) water, everywhere else void) so `terrain-readback.spec.ts`'s pixel probes stay exact
while exercising the real gen-worker -> `TerrainFeed` -> `TerrainStore` -> `Uploader` -> upload-ring
path instead of hand-filling the renderer's textures. `Gen` and `Client` roles both implemented
(`Sim` rejected). Base/resource layer ids double as visual ids (`ClientSide`'s default identity
table): no `Registry` calls needed, since 1/2/5 already match
`tests/browser/pages/public/terrain/tiles.json`'s grass/water/ore.

Chunk edge fixed at 32 (`ChunkDims::new(5)`, Planning decisions "`CHUNK_BITS` is 5 here").
`ChunkTexels`'s region size (`MAX_STAGE_BATCH * RECORD_BYTES`) must stay in step with
`src/worker/client-upload.ts`'s own per-pump request cap.
