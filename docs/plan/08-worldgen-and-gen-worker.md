# M08: Worldgen and the gen role

Status: not started · After: 05, 07 · Tyler-dependent: no (device page assumes Q5 default: iPhone + desktop Chrome)

**Split.** The PLAN row for M08 broke the sizing rule (about 1,900 lines across Rust, worker TypeScript and browser tests). This brief keeps everything that needs no SharedArrayBuffer: the `Worldgen` trait, the `gen` role, the fixture worldgen, the cross-runtime golden and the benchmark. Gen workers over `genRequest`/`genResult`, the client generation queue and the client pristine-cache feed are `docs/plan/08b-gen-workers-and-queue.md` (After: 06b, 08). M06 is therefore not a prerequisite here (M12 needs only this brief); M09 waits on 08b.

## Goal
A game can implement `Worldgen`; the one `.wasm` instantiated in the `gen` role turns `gen_chunk(cx, cy)` into a slab of tile bytes; and a fixture worldgen's raw tile bytes hash to one checked-in golden natively, under Node, under Bun and in Chromium, WebKit and Firefox. `TerrainStore` (M07) runs on real worldgen through `Pristine<W>`, and a slow-tier benchmark polices the per-chunk budget of 0008 §6, with a page Tyler can open on a phone.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0008-chunk-generation.md` (§1, §2 table, §6, Consequences)
3. `docs/decisions/0007-world-model.md` (§2 range, §3, §9 worldgen stamping)
4. `docs/decisions/0014-js-wasm-boundary.md` (§4 exports, regions and the config path; §5)

Mine from spikes: `spikes/determinism-hash/src/lib.rs` (`coord_hash` → `hash2`; the `simplex_impl!` f64 instance, `fbm`, `classify`, `finish_tile`, `gen_chunk_f64`, `chunk_coord` for far-coordinate sampling), `driver/run-js.mjs` (warm-up + timed loop), `RESULT.md` Timing and the f32-precision table. Rules that apply: `.claude/rules/determinism.md`. The rule for adding an export is in `packages/engine/CLAUDE.md` (from M02); follow it in step 5.

## Scope
- `Worldgen` trait exactly as 0008 §1; `hash2`; `Pristine<W>` adapting it to M07's `PristineSource`; `worldgen_fingerprint` and `WorldgenStamp` (0007 §9).
- `engine::noise`: f64 simplex and fBm helpers (Planning decisions 1).
- `gen` role: `GenCore<W>`, the `gen_chunk` export added by M02's ABI rule, `RegionId::GenOut` sized `ChunkDims::slab_bytes()`.
- `engine::testing::assert_worldgen_contract`: the rules of 0008 §1 that can be tested mechanically.
- Fixture `packages/engine/fixtures/worldgen/` (`fx-worldgen`) with a `worldgen` scenario kind and its golden; native, Node, Bun and three-browser golden tests.
- Slow-tier benchmark and the phone-openable bench page.

## Non-scope
- Gen workers, `genRequest`/`genResult` records, `GenQueue`, client pristine-cache feed, worker count, zero-GC of the gen isolate: **M08b**.
- **Host-side generate-on-miss** is not new code: it is `TerrainStore`'s miss path (M07) and becomes real worldgen here through `Pristine<W>`; this brief only tests it (`cache_invisible_real_worldgen`). **The 2 ms between-tick warmer belongs to M13** (`sim_warm_one`, `host::warm`, `WARM_BUDGET_MS`): WASM has no clock (0014 §3), so the budget can only be enforced by the TS sim host against the injected clock, and its rectangles arrive with M15. M13 consumes `TerrainStore::{is_cached, materialize}` from M07.
- The `Game` trait and `type Worldgen` on it: M12. Stamping `WorldgenStamp` into world params, snapshots and log headers, and `SaveIncompatible`: M22/M24. `Welcome` carrying seed + params: M28. Texel conversion: M09. The reference game's worldgen: M20 (reuses `engine::noise`, `hash2`, `assert_worldgen_contract`).

## Files, packages and crates touched
- `packages/engine/crates/engine/`: `src/worldgen.rs`, `src/noise.rs`, `src/testing/worldgen_contract.rs`, `src/abi/registry.rs` (one export, one `Instance` method), `tests/worldgen_*.rs`, `tests/golden/`.
- `packages/engine/fixtures/worldgen/`: `Cargo.toml`, `src/lib.rs`, `scenario.json`, `golden.json`, `CLAUDE.md`.
- `packages/engine/` TS: `src/abi.ts` row, `tests/support/scenario.ts` (`kind` dispatch), `scripts/golden.mjs`, `tests/wasm/worldgen*.test.ts`, the Bun leg, `tests/app/{determinism (list), worldgen-bench.html, src/worldgen-bench.ts}`, `budgets.json` key.

## Seams
**Provides:**
- `engine::worldgen::Worldgen` (0008 §1 signature, unchanged), `worldgen::hash2(seed: u64, x: i32, y: i32) -> u64`, `worldgen::Pristine<W: Worldgen>` (`new(seed: u64, params: W::Params)`, implements `PristineSource`), `worldgen::worldgen_fingerprint(&dyn PristineSource, ChunkDims) -> u64`, `worldgen::WorldgenStamp { version: u32, fingerprint: u64 }` (`Codec`), `worldgen::GenCore<W>` (`new(ChunkDims, seed, params)`, `gen_chunk(&self, cx: i32, cy: i32, out: &mut [u8]) -> Status`: tiles as little-endian bytes, row-major).
- `engine::noise::{simplex2(seed: u32, x: f64, y: f64) -> f64, fbm2(seed: u32, x: f64, y: f64, octaves: u32) -> f64}`.
- `engine::testing::assert_worldgen_contract::<W>(seed, &params, ChunkDims)`.
- ABI (role `gen`): export `gen_chunk(cx: i32, cy: i32) -> status`, `Instance::gen_chunk` (defaulted `Unsupported`), `ABI_EXPORTS.gen_chunk`, `ABI_VERSION` bumped; `RegionId::GenOut` (id reserved by M02) is laid out by gen-role `init` with `slab_bytes` (4,096 at the default chunk size; consumers read `region(RegionId.GenOut).len`, never a literal).
- Gen-role `InstanceConfig.game` keys: `seed` (`HexU64`), `params` (the game's `Worldgen::Params` JSON). M12b/M13 keep these key names in `WorldParams`.
- Fixture `fx-worldgen` (`FixtureGen`, `FixtureParams`; `export_instance!`), the terrain fixture for M08b, M09 and M15. `scenario.json`: `{ kind: "worldgen", config, chunks: [[cx, cy], ...] }`; `runHashScenario` dispatches on `kind` (absent = M02's sim scenario) and returns one checkpoint per 64 chunks, each the `fnv1a64Hex` of the concatenated `GenOut` bytes.
- Slow-tier test `worldgen-bench` (`pnpm test:slow wasm -t worldgen-bench`); `budgets.json` key `worldgenMsPerChunkWarn`; page `worldgen-bench.html` in the fixture app.

**Consumes:** M02: `abi::registry` + the ABI rule, `Instance`, `RegionLayout`, `export_instance!`, `Status`, `RegionId::GenOut`, `abi::config::HexU64`, `instantiate`/`EngineInstance.region`/`call2`, `buildGame` (incl. `profile: 'release'`), `loadFixture`, `runHashScenario`, `pnpm golden`, `engine::testing::assert_golden`, `abi::Arena` counters, `hash::Fnv64`. M02b: the fixture app and `fixtureWasm(name)`. M03: `determinism.html` + its `@engines` spec, `pnpm device:serve [--tunnel]`, warning annotations. M04: `budgets.json`. M05: `mix64`, `Codec`, `assert_golden_hash!`, `fnv1a64Hex`. M07: `Tile`, `ChunkCoord`, `ChunkDims`, `PristineSource`, `TerrainStore`, `assert_cache_invisible`. M01: `pnpm test:slow`.

## Planning decisions
1. **Deferred item, decided: noise helpers live in the engine crate** as `engine::noise`, optional and unprivileged. There are already two consumers that cannot share code any other way (engine tests must use fixtures, never the reference game), 0017 §7 already lists noise helpers as owned code, and float code under the 0002 rules is better golden-tested once. The spec's split is kept: octaves, frequencies, thresholds, biomes and scatter are the game's; a game may ignore the module and LTO drops it. f64 only (0008 §1).
2. **Deferred item, decided: no sampled pristine-hash check between client and server in Phase 3.** Under one `.wasm` plus the handshake build hash, a divergence is an engine or JIT bug, and three cheaper nets exist: this milestone's six-runtime golden (also shown on the phone by `determinism.html`), the fingerprint in saves (0007 §9), and M07's `insert_pristine` debug assertion, which compares gen-worker output with the instance's own generation in every dev build. If a field report ever calls for it, it is one more entry kind in the `Hashes` section (0011) beside M31's per-chunk hashes; M31 only has to keep that entry-kind byte extensible.
3. **Float bits reach the golden through the tile.** 0020 §5 asks the worldgen golden to cover raw float bits, but `generate` emits only tiles. `FixtureGen` packs the low 16 mantissa bits of its height value into `aux`, so last-bit drift changes tile bytes. This needs one `#[allow]` for `to_bits` with the comment 0002 §3 requires (finite by construction, `debug_assert!`ed). `engine::noise` also has its own native golden over raw f64 bits.
4. **Golden size and sampling.** 256 chunks in the fast tier (origin block, all four sign quadrants, both edges of the valid range from `ChunkDims`, far diagonal), listed once in `scenario.json` and read by the Rust test (`serde_json`) and every TS leg, never mirrored by hand. `golden.json` is written only by `pnpm golden worldgen` from the `.wasm` under Node (0020 §5).
5. **The fixture is benchmark-representative**: five-octave height + three-octave moisture + scatter, the spike's shape, so the number is comparable with 0008 §6.
6. **Benchmark placement.** Wall clock is slow-tier and warn-only (0020 §9, 0008 §6). `worldgen-bench` builds `fx-worldgen` on the release profile, runs 200 warm-up + 2,000 timed chunks in a `gen`-role instance under Node, prints median ms/chunk, checks a second golden over those chunks, and emits a runner `warn` line above `worldgenMsPerChunkWarn`.
7. **Deferred item, scheduled here: ms per chunk on real devices.** `worldgen-bench.html` runs the same loop in a plain worker and shows median ms/chunk, the golden match, the user agent and `navigator.hardwareConcurrency`. See Manual device checks for what each number changes.
8. **Seed text.** Instance config carries the seed as `HexU64` (M02). 0009's `WorldConfig.seed` is decimal text; the conversion belongs where `WorldConfig` becomes `InstanceConfig` (M13), not in Rust.
9. **Chunk size in the ABI.** 0014 and 0015 say 4,096 bytes because they assume the default; `GenOut` and every copy use `slab_bytes`.

## Order of work
1. `hash2` and `noise.rs` ported from the spike, pinned vectors, raw-bits golden. 2. `worldgen.rs`: trait, `Pristine<W>`, fingerprint, stamp, `GenCore`. 3. `assert_worldgen_contract`. 4. `fx-worldgen` crate; native `scenario_matches_golden`; rerun `assert_cache_invisible` over `Pristine<FixtureGen>`. 5. ABI: `gen_chunk` by the M02 rule (registry, `abi.ts`, version bump); `GenOut` laid out in gen-role `init`. 6. `runHashScenario` `kind` dispatch, `golden.mjs`, `pnpm golden worldgen`; Node and Bun legs; add the fixture to `determinism.html`'s list. 7. `worldgen-bench` slow test, `budgets.json` key, bench page. 8. `packages/engine/CLAUDE.md` (worldgen rules in three lines, link to 0008 §1) and the fixture's `CLAUDE.md`.

## Tests added
Rust: `hash2_vectors`, `noise_raw_bits_golden`, `noise_bounded`, `worldgen_contract_fixture` (every element written regardless of prior slab contents; chunk order and repetition do not change output; `abi::arena` shows zero allocation inside `generate`), `pristine_matches_generate`, `fingerprint_stable_and_sensitive`, `fingerprint_golden`, `fx-worldgen scenario_matches_golden`, `cache_invisible_real_worldgen`, `gen_core_wrong_len_is_bad_length`. `wasm` suite: `gen: gen_chunk fills GenOut`, `gen: sim role returns WrongRole`, `determinism: worldgen node matches golden`, the Bun leg, `abi registry` (now with `gen_chunk`). Browser: `determinism @engines` covers `worldgen`. Slow: `worldgen-bench`.

## Exit criteria
- [ ] `fixtures/worldgen/golden.json` is matched natively, under Node, under Bun and in the three browsers; `pnpm golden worldgen && git diff --exit-code` is clean.
- [ ] `worldgen_contract_fixture` and `cache_invisible_real_worldgen` pass.
- [ ] Import-allowlist, target-feature and ABI-registry tests pass for every fixture with the bumped `ABI_VERSION`.
- [ ] `pnpm test:slow wasm -t worldgen-bench` prints ms per chunk and exits 0; the number is recorded under Deviations.
- [ ] `pnpm device:serve` lists `worldgen-bench.html`, and it completes with a golden match in desktop Chromium.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t worldgen` · `pnpm test rust -t noise` · `pnpm test wasm -t worldgen` · `pnpm test browser -t determinism` · `pnpm test:slow wasm -t worldgen-bench` · `pnpm golden worldgen && git diff --exit-code` · `pnpm test && pnpm lint`.

## Budgets
Chunk generation row of `PRE-PLAN.md` §7 (owner 0008 §6): `worldgen-bench` against `worldgenMsPerChunkWarn`; phone figure by the device check. Download row: `engine::noise` must vanish from a module that does not use it (compare `fx-hash` release `.wasm` bytes before and after, once; M35 owns the permanent size test). Test-suite row: the fast-tier golden stays under the demotion threshold on the dev profile; shrink the chunk list before demoting.

## Context artifacts
Updates `packages/engine/CLAUDE.md`; adds `packages/engine/fixtures/worldgen/CLAUDE.md` (what the fixture is for, scenario kind, bless command). `determinism.md` globs already cover both.

## Manual device checks
`docs/plan/device-checks.md#m08-worldgen-ms-per-chunk` (PLAN should mark M08 **D**; never blocking). Tyler runs `pnpm device:serve --tunnel`, opens `worldgen-bench.html` on the iPhone (Android over `adb reverse` if Q5 is answered yes) and records median ms/chunk and the golden result. Reading it: golden mismatch → stop, determinism bug (0002's deferred device run). At or below 0.5 ms → 0008's estimate holds. Above 0.5 ms → record the phone/desktop factor F; if F > 5, set `worldgenMsPerChunkWarn` to 1 ms / F. Above 1 ms with this fixture → the budget of 0008 §6 is broken: open a plan edit revisiting the default gen worker count on phones (M08b) and M13's warmer yield per gap.

## Deviations
(filled in during Phase 3)
