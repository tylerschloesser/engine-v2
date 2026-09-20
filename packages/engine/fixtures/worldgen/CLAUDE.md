# fixtures/worldgen (`fx-worldgen`)

The `Worldgen` fixture (docs/decisions/0008-chunk-generation.md §1): `FixtureGen` (five-octave
height + three-octave moisture `fbm2`, a `hash2` scatter for resources, the low 16 mantissa bits
of the height sample packed into `aux`) and `FixtureParams` (currently empty). `gen`-role only:
`Instance::init` rejects any other role. Chunk edge is fixed at 32 (`ChunkDims::new(5)`), matching
the default of docs/decisions/0007-world-model.md §3.

Consumed by docs/plan/08b-gen-workers-and-queue.md too (Seams of `08-worldgen-and-gen-worker.md`):
the worldgen fixture for gen workers and the client pristine-cache feed.

## Golden

- `golden/scenario.json`: `{ kind: "worldgen", role: "gen", config, chunks: [[cx, cy], ...] }`, 256
  chunks (origin block, all four sign quadrants, both edges of the valid chunk-coordinate range,
  far diagonal) -- listed once, read by the Rust test (`serde_json`) and every TS leg. Rebless with
  `pnpm golden worldgen` (writes `golden/golden.json` from the `.wasm` under Node, one checkpoint
  per 64 chunks, each the `fnv1a64Hex` of the concatenated `GenOut` bytes).
- `golden/bench.json`: a second, separate golden (`config` + a single `hash`) for
  `worldgen-bench` -- the warm-up (200) + timed (2,000) chunk sequence of
  `tests/support/bench-worldgen.ts`, shared by the Node slow test and `worldgen-bench.html`. Not
  written by `pnpm golden`; rebless by hand from a passing run's printed hash if the fixture's
  generation ever changes on purpose.

## Tests

`tests/scenario.rs` (native leg of the cross-runtime golden), `tests/contract.rs`
(`worldgen_contract_fixture`: `engine::testing::assert_worldgen_contract` plus a zero-allocation
check of `FixtureGen::generate` -- no `#[global_allocator]` of its own, since
`engine::export_instance!(FixtureGen)` already installs `engine::abi::Arena` for this crate's own
test binaries), `tests/cache_invisible.rs` (`cache_invisible_real_worldgen`: `assert_cache_invisible`
over a `TerrainStore` backed by `Pristine<FixtureGen>`, proving M07's generate-on-miss path stays
invisible with real worldgen).
