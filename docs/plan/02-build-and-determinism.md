# M02: Engine ABI, loader, `buildGame`, first fixture, determinism hash (native / Node / Bun)

Status: done (2026-09-19) · After: 01 · Tyler-dependent: no (Q1 answered: `serde_json`, `ts-rs` and `libm` approved, as 0014 §4 and 0017 §7 state)

**Split note.** The PLAN row for 02 did not fit the sizing rule (about 2,100 lines with the Vite plugin). It is split: this brief (crate ABI, loader, `buildGame()`, fixture, allowlist, hash golden in three non-browser runtimes) and `02b-vite-plugin.md` (the `engine()` plugin, `virtual:engine/wasm`, the fixture Vite app). Order is 01 → 02 → 02b → 03 → 04 with nothing between.

## Goal
The engine crate exposes the minimal fixed ABI of 0014 through one macro, a TypeScript loader instantiates any game-built `.wasm` in any JS runtime, and `buildGame()` turns a game crate into `game.wasm` + `game.json` with a build hash. One fixture game runs a deterministic scenario whose checkpoint hashes are equal natively, as `.wasm` under Node and under Bun, against a committed golden. The import-allowlist and ABI-registry tests guard the boundary from now on.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0014-js-wasm-boundary.md` (all; it is short)
3. `docs/decisions/0017-packaging-and-build.md` (§1, §4, §5 first paragraph, §6 profiles, §7, §10)
4. `docs/decisions/0002-determinism-same-wasm-everywhere.md` (§2 table, §3)

Cited by section below, open only if needed: 0015 §5 (arena), 0020 §3 and §5 (suite placement, golden rule).
Mine from spikes: `spikes/vite-lib-worker-wasm/engine/crates/engine/src/lib.rs` (import block, `Slot`, macro skeleton, edition-2024 notes), `.../engine/src/worker.ts` (import object, panic/log decode), `.../engine/src/vite.ts` lines 26–37 (`cargoBuild`), `.../game/test/node-bun.mjs` (one loader shape under Node and Bun), `.../game/test/sizes.mjs` (the `wasm-opt` flag list), `spikes/determinism-hash/src/lib.rs` (f32 spring sim, 16.16 fixed-point sim, SplitMix64, FNV-1a: port these, not the noise or the "risky" rows), `spikes/determinism-hash/driver/run-js.mjs` and `src/main.rs` (driver shape).
Rules that apply: none exist yet; this milestone creates `determinism.md` and `hot-paths.md`.

## Scope
- Rust crate `engine` (`packages/engine/crates/engine`), module `abi`: the two imports, boot region, region table, `engine_init` with config parse and arena reservation, panic hook, `log`, the `Instance` trait, `export_instance!` / `export_game!`, the registry of roles, statuses, region ids and exports.
- `engine::hash::Fnv64` (64-bit FNV-1a, 0002 §3 last bullet). M05 builds the state hash on it.
- TypeScript: `src/abi.ts` (mirror of the registry), `src/loader.ts` (`instantiate`), `src/build-game.ts` (`buildGame`), `src/vite.ts` re-exporting `buildGame` only, `src/server-node.ts` with `loadGame(dir)` only.
- Fixture game `packages/engine/fixtures/hash/` with scenario and golden.
- Tests: import allowlist + target-feature check, ABI registry consistency, loader behaviour (ABI mismatch, init failure, panic, wrong role, growth detach), determinism golden natively, under Node (Vitest) and under Bun (plain script).
- Runner registration in `scripts/suites.mjs` (M01): build step `fixtures` (after `tsc`: `buildGame` for every fixture, dev profile) and suite `wasm`; a `script` adapter in `scripts/lib/adapters.mjs` for the Bun leg; Bun added to `TOOLS` in `scripts/setup-tools.mjs`.
- `packages/engine/package.json` `exports`: add `./vite` and `./server/node` (shape: 0017 §2). `src/client.ts` stays M01's placeholder (M06b owns it).
- `clippy.toml`: fill the `disallowed-methods` / `disallowed-types` lists of 0002 §3 (M01 created the empty file and turned the lints on).
- Memory declaration and the dev half of the exhaustion policy (0015 §5, "Growth is tolerated but counted"): the module exports its memory, imports none and declares no `maximum`; under `debug_assertions` an allocation that would take `Arena`'s live bytes past the reserved `arenaBytes` panics with a message naming the requested and reserved bytes (the panic hook does not allocate). Stepped growth on release builds is not built here. So that the two fixture switches do not collide, `growAtTick` calls `memory_grow` directly and a new `exhaustAtTick` allocates past the arena.
- Engine-crate dependency policy as a test (0017 §7; the spec's crate policy): `crate-policy` below. M35 consumes it and adds no second test.

## Non-scope
- The Vite plugin, `virtual:engine/wasm`, COOP/COEP, any page (M02b, M03). Workers, rings, the production control block (M06, M06b). `Codec`, snapshot bytes, the real state hash (M05). The `Game` trait of 0003 (M12). `createWorldServer` (M27); Bun/Deno adapters (M35b). `wasm-opt` execution (option is accepted and ignored with a warning until M35). Bindings step (M16).

## Files, packages and crates touched
`packages/engine` (TS), crate `engine`, crate `fx-hash`. New paths:
```
packages/engine/crates/engine/src/{lib.rs, hash.rs, testing.rs}
packages/engine/crates/engine/src/abi/{mod.rs, registry.rs, boot.rs, regions.rs, arena.rs, panic.rs, config.rs}
packages/engine/src/{abi.ts, loader.ts, build-game.ts, vite.ts, server-node.ts}
packages/engine/fixtures/hash/{Cargo.toml, src/lib.rs, golden/scenario.json, golden/golden.json}
packages/engine/scripts/{build-fixtures.mjs, golden.mjs}
packages/engine/tests/wasm/{allowlist,abi-registry,loader,determinism}.test.ts, bun-leg.mjs
packages/engine/tests/support/{fixtures.ts, scenario.ts, wasm-sections.ts}
scripts/lib/crate-policy.test.mjs
scripts/suites.mjs, scripts/lib/adapters.mjs, scripts/setup-tools.mjs, vitest.config.ts (project `wasm`), clippy.toml, packages/engine/tsconfig.json (`types: ["node"]`: the first Node-API code lands here; `@types/node` is already pinned by M01)
packages/engine/CLAUDE.md (M01 created it; extend), .claude/rules/{determinism.md, hot-paths.md}, CLAUDE.md (root: two invariant lines)
```
Root `Cargo.toml`: add workspace member glob `packages/engine/fixtures/*` (every directory there is a crate; non-crate test assets live under `packages/engine/tests/`).

## Seams
**Provides (Rust, crate `engine`):**
- `abi::registry`: `ABI_VERSION: u32`; `#[repr(u32)] enum Role { Sim = 0, Client = 1, Gen = 2 }`; `enum Status` and `enum RegionId` (tables below); the extern list inside `export_instance!`. **This file is the single owner of the ABI.**
- `trait abi::Instance: Sized + 'static` with `fn init(role: Role, game_cfg_json: &str, layout: &mut RegionLayout) -> Result<Self, Status>` and one defaulted method per hot export returning `Status::Unsupported` (`sim_admit(&mut self, conn: u32, rx: &[u8]) -> Status`, `sim_tick(&mut self) -> Status`, `sim_build_frame(&mut self, conn: u32, tx: &mut [u8]) -> Result<u32, Status>`, `sim_hash(&mut self) -> u64`).
- `abi::RegionLayout::region(&mut self, id: RegionId, bytes: u32)`; regions are leaked boxed slices, never moved (0014 §4).
- `engine::export_instance!(T)` for any `T: Instance`: emits every export for every role, the `#[global_allocator]`, the panic hook, the single-threaded instance slot. `engine::export_game!(T)` exists from now with the final name and forwards to `export_instance!`; M13 re-points it to `export_instance!(Host<G>)` for `G: Game` (M12's trait, M12b's `Sim<G>`). Low-level fixtures call `export_instance!` and never churn.
- `abi::Arena` (`GlobalAlloc`), `abi::arena::{live_bytes, high_water_bytes}`; `abi::config::HexU64` (serde helper: u64 as `"0x…"` string); `engine::log(level, &str)`; `engine::hash::Fnv64 { new, write(&[u8]), write_u32, write_u64, finish() -> u64 }`.
- `engine::testing` (feature `testing`, dev-only): `assert_golden(fixture_dir, checkpoints: &[u64])`, reading `<fixture>/golden/golden.json`.

**Provides (TypeScript):**
- `src/abi.ts`: `ABI_VERSION`, `Role`, `Status`, `RegionId` (const objects, same names and numbers as Rust), `ABI_EXPORTS: Record<string, { role: 'all' | 'sim' | 'client' | 'gen', params: number, result: 'status' | 'len' | 'ptr' | 'u32' | 'void' }>`, `statusName(n)`.
- `src/loader.ts` (internal module, no exports-map entry): `instantiate(module: WebAssembly.Module, role: Role, config: InstanceConfig, hooks?: LoaderHooks): EngineInstance` (synchronous). `InstanceConfig = { arenaBytes: number, game: unknown }` (JSON keys camelCase; later milestones add keys). `LoaderHooks = { onLog?(level, text), onPanic?(text) }`. `EngineInstance`: `role`, `x` (raw exports, typed from `ABI_EXPORTS`), `call0(fn)`, `call1(fn, a)`, `call2(fn, a, b)` (the only way to call an export: trap capture, dead check, detach check; fixed arity so no rest array is allocated), `mem: { u8, u32 }` (whole-memory views, replaced on growth; read through `inst.mem` every time), `region(id): RegionView` (`{ ptr, len, u8 }`, a stable holder whose `u8` is rebuilt on growth; `null` if the role has no such region), `onViewsRebuilt(cb)`, `memoryBytes()`, `memGrows()`, `dead`, `panicMessage`, `readU64Hex(id, offset)`. Errors: `AbiMismatchError { expected, actual }`, `EngineInitError { status }`, `EngineTrap { role, panicMessage }`.
- `buildGame({ crate, profile?: 'dev' | 'release', wasmOpt?: boolean, env?: NodeJS.ProcessEnv }): Promise<{ dir, wasmPath, jsonPath, buildHash, abiVersion, profile, cargoMs }>` from `engine/vite`; output files per 0017 §4. Throws `CargoBuildError { stderr }`.
- `loadGame(dir): Promise<{ wasm: WebAssembly.Module, buildHash: string }>` from `engine/server/node` (0017 §4). M27 extends this file; M35b adds the Bun and Deno files.
- Test support: `tests/support/fixtures.ts` `fixtureDir(name)`, `loadFixture(name) -> { wasm, buildHash }`; `tests/support/scenario.ts` `runHashScenario(inst, scenario) -> string[]` (shared by Node, Bun and, in M03, the browser page); `tests/support/wasm-sections.ts` `readSections(bytes) -> { types, imports, funcs, exports, memories }` (a LEB128 section walk of under 100 lines; the JS API exposes neither signatures nor memory limits). **Hashes are 16-char lowercase hex strings everywhere in TS and JSON.**
- Conventions: a fixture game is `packages/engine/fixtures/<name>/` with package name `fx-<name>`, `crate-type = ["cdylib", "rlib"]`, `publish = false`, `[lints] workspace = true` (so the 0002 §3 bans reach every fixture), `engine = { path = "../../crates/engine" }`, optional `golden/scenario.json` + `golden/golden.json` (directory fixed by M01 decision (a)). `pnpm golden [fixture]` (root script → `packages/engine/scripts/golden.mjs`) is the only writer of `golden.json` and writes from the `.wasm` run under Node (0020 §5). The allowlist and registry tests iterate every directory in `fixtures/`, so a new fixture is covered by adding the directory.

**Consumes:** M01: workspaces, root profiles and lints, pins; `scripts/suites.mjs` (`buildSteps`, `suites`: the registration point), `scripts/lib/adapters.mjs` (`vitest`, `nextest`), `scripts/lib/env.mjs` `toolEnv()` (every cargo spawn in `buildGame`'s callers uses it; `buildGame` itself takes `env` so the package stays free of repo scripts), `TOOLS`, the `-t` substring rule, `test-results/<suite>/`, test placement (M01 decision (a)), the empty `clippy.toml`.

## Planning decisions
**Initial registry (PRE-PLAN §10, 0014 deferred: export list, region ids, status codes).**

| Export | Role | Notes |
|---|---|---|
| `engine_abi_version`, `engine_boot`, `engine_init`, `engine_region`, `engine_region_len`, `engine_mem_grows` | all | signatures: 0014 §4 |
| `sim_admit(conn, len) -> status` | sim | input bytes are in `Rx` |
| `sim_tick() -> status` | sim | |
| `sim_build_frame(conn) -> len` | sim | output in `Tx` |
| `sim_hash() -> status` | sim | writes the u64 as two LE u32 (lo, hi) at offset 0 of `Result` |

Exports that return `len` return `i32`; a negative value is `-(status)`. `RegionId`: `0 Rx`, `1 Tx`, `2 Result` (64 B, every role: multi-word numeric outputs), and reserved now so parallel briefs share names, each sized by the milestone that first uses it: `3 DrawList` (M17), `4 ChunkTexels` (M09), `5 Ui` (M16), `6 Persist` (M22), `7 Camera` (M06b), `8 GenOut` (M08). `engine_region` returns 0 for a region the role does not have. `Status`: `0 Ok`, `1 WrongRole`, `2 NotInitialised`, `3 AlreadyInitialised`, `4 BadConfig`, `5 BadLength`, `6 Decode`, `7 OutOfMemory`, `8 Unsupported`. Client and gen exports, `sim_snapshot`, and everything else are added by their milestones (M06/M08/M13/M15/M22).

**Rule for adding to the ABI.** One commit that (1) adds the extern to `export_instance!` and a defaulted `Instance` method in `abi/registry.rs`, (2) adds the row to `ABI_EXPORTS` (or the constant) in `src/abi.ts`, (3) bumps `ABI_VERSION` in both. Numbers are appended, never reused or renumbered. Because every module carries every export and new methods default to `Unsupported`, old fixtures need no edit. `abi-registry.test.ts` enforces it: the function exports of every built fixture equal the keys of `ABI_EXPORTS` exactly (ignoring `memory`, `__data_end`, `__heap_base`), and the `Name = N,` lines of each enum in `registry.rs` (keep one variant per line in that form; the test parses them) equal the TS objects. A new *import* is an ADR amendment (0014 §3), not this rule.

**Why `Instance` under `export_game!`.** M08 needs `gen_chunk` behind the ABI before the `Game` trait exists (M12), and ABI tests need modules smaller than a game. So the macro is generic over a small ABI-level trait, and the engine's generic host implements it later. No ADR text changes: a game still writes one line.

**Where `engine.log` text is decoded (0014 deferred).** In the instance's own isolate, by the loader, with one module-level `TextDecoder` (WASM memory is non-shared, so `decode` accepts the view), then handed to `LoaderHooks.onLog`; the default hook writes to `console` by level. Same for `engine.panic`. No forwarding to main: worker consoles already reach DevTools and Playwright, a server has one isolate, and a log call inside a measured window is meant to fail 0016 on the isolate that made it.

**Arena (0015 §5) without owning an allocator.** `abi::Arena` wraps `std::alloc::System`, counts live and high-water bytes, and `engine_init` reserves the arena by allocating and freeing one block of `arenaBytes`, which makes std's allocator perform the single `memory.grow`; it then records the page count. `engine_mem_grows()` = pages grown since. This meets the observable contract (one growth at init, none after, asserted by 0016) in about 40 lines and no dependency. Question handed to **M07**: do the world pools need their own sub-allocator on top, or is reserve-and-free enough under the cache-churn tests? Fixtures use a small `arenaBytes` so tests stay fast.

**`+simd128` and `wasm-opt` for the sim module (0002 deferred, 2→3).** Both stay off through Phase 3's fast tier; `buildGame` never passes target-feature flags. **M36b** measures: replay every golden on the release module built (a) plain, (b) with `wasm-opt -O3` and the flag list of 0017 §5, (c) with `+simd128`, in Node, Bun and the three browsers, locally and on M10's x86-64 runner, and reports tick-time and brotli deltas. Equal goldens everywhere plus a gain worth having → M36 writes the ADR amending 0002; otherwise they stay off. The allowlist test's feature assertion is the guard until then.

**Target-feature assertion (0002 §3, second assertion).** On dev-profile modules read `WebAssembly.Module.customSections(module, 'target_features')`; every `+feature` must be in a committed allowlist captured from the pinned toolchain's default output, and `simd128`, `relaxed-simd`, `atomics` are named failures. Release modules are stripped (0017 §6) and are covered by building with the same flags.

**Wrong-role calls return `Status::WrongRole` on every profile.** 0014 §5 adds "(traps in debug)"; 0024 §16 drops that: the fast tier builds fixtures on the dev profile only, a trap marks the instance dead, and `loader: wrong-role export returns WrongRole` must run there and go on using the instance. Recorded as 0024 §16.

**Config numbers.** u64 values in config JSON (seeds) are `"0x…"` strings (`HexU64`); JS numbers cannot carry them.

**Rebuild and suite numbers; sccache vs shared `CARGO_TARGET_DIR` (0020 deferred).** Decision: neither for now. A shared target dir serialises parallel worktrees on cargo's build lock and thrashes fingerprints when sources differ; sccache caches neither incremental crates nor the cdylib link, so it helps only cold dependency builds. Trigger to revisit: a cold build in a fresh worktree over 3 minutes on Tyler's Mac, or M10's cached CI build over 5 minutes; then adopt sccache. This milestone records the first real numbers (see Budgets); every later harness milestone records its suite's; M36 records the final table and M39 audits it.

## Order of work
1. Crate skeleton: `abi/registry.rs` (constants, enums, `Instance`, macro with the six universal exports), boot region, `RegionLayout`, config parse (`serde_json`), arena, panic hook that formats into the boot-region tail without allocating, `log`. Do not set `panic = "abort"` on `[profile.dev]` (native tests unwind); `wasm32-unknown-unknown` aborts by default, and the panic test proves it.
2. `hash.rs`; fixture `hash`: f32 spring sim + 16.16 fixed-point sim + integer PRNG from the spike, `sim_admit` folds `Rx` bytes into the next tick's forces, `sim_build_frame` writes 64 state bytes to `Tx`, `sim_hash` hashes raw state bits. Config: `{ seed: HexU64, entities, panicAtTick?, growAtTick? }`.
3. `build-game.ts`: locate the artifact with `cargo metadata --format-version 1 --no-deps` (`target_directory` + the cdylib target name; the workspace has one root `target/`), `cargo build`, SHA-256, read `abiVersion` by instantiating with stub imports, write `game.wasm` + `game.json`. `scripts/build-fixtures.mjs`; wire into the `pnpm test` build step after `tsc`.
4. `abi.ts`, `loader.ts`, `server-node.ts`.
5. Tests in the order listed below; then `scripts/golden.mjs`, generate `golden.json`, native test, Bun leg.
6. Register in `scripts/suites.mjs`: Vitest project `wasm` over `packages/engine/tests/wasm/*.test.ts`, and the Bun leg through the new `script` adapter (`bun packages/engine/tests/wasm/bun-leg.mjs`; its one JSON line is parsed into test results) as part of the same suite line. The tool probe fails with the `pnpm setup:tools` hint, never skips, if `bun --version` is not the pin of 0017 §10.
7. Context artifacts; measurements into Deviations.

## Tests added
- `unit`: `crate-policy` (`scripts/lib/crate-policy.test.mjs`; `cargo metadata --format-version 1` through `toolEnv()`): the `engine` package's normal dependencies are a subset of the 0017 §7 list (the test holds the five names with a comment citing that section as owner; a new name arrives with its ADR); `postcard` and `serde_json` have `uses_default_features: false` and `serde_json`'s declared features are `alloc` only, and `cargo tree -p engine --target wasm32-unknown-unknown -e normal,features` shows no `serde_json` `std` feature (0003); any `libm` requirement in any workspace manifest starts with `=` (0002 §2).
- Rust native (nextest): `abi::` unit tests (region table, config errors → `BadConfig`, `Fnv64` vectors); `fx-hash` `scenario_matches_golden` (drives the same `Instance` methods with the same input bytes as the JS driver, all checkpoints).
- `wasm` suite: `import allowlist` and `target features` (every fixture; failure text per 0014 §3; `import allowlist` also asserts, through `readSections`, that `memory` is an export of kind `memory`, that no import has kind `memory`, and that the memory section declares no `maximum`: 0014 §3, 0015 §5); `abi registry` (also fails on any export or import whose signature has an `i64`, an `externref` or more than one result: 0014 §2); `loader: abi mismatch`, `loader: init failure carries status`, `loader: panic marks instance dead with message` (`panicAtTick`), `loader: wrong-role export returns WrongRole`, `loader: views survive memory growth` (`growAtTick`; also asserts `memGrows() > 0` there and `=== 0` in the golden run), `loader: arena exhaustion traps with message` (`exhaustAtTick` on the dev profile: `EngineTrap` whose `panicMessage` names the arena, and `memGrows() === 0`), `build: game.json matches bytes` (hash recomputed, `abiVersion`, `profile`); `determinism: node matches golden`; Bun leg prints one JSON line the runner compares with the same golden.
- Scenario (in `golden/scenario.json`): fixed seed, 256 entities, 10,000 ticks, checkpoint every 1,000, 16 input bytes admitted every 7th tick derived from the tick number with integer ops only. Shrink the tick count if any runtime exceeds 0.2 s; never drop a runtime.

## Exit criteria
- [x] `pnpm test wasm` passes; the golden has ≥ 10 checkpoints and is identical natively, under Node and under Bun.
- [x] `pnpm test rust -t scenario_matches_golden` passes.
- [x] Temporarily adding `getrandom` with its JS backend to `fx-hash` makes `import allowlist` fail naming the module (done by hand once, result noted under Deviations, not committed).
- [x] Temporarily adding an `f32::sin` call, a `HashMap` field and a `std::time::Instant` to `fx-hash` makes `pnpm lint` fail naming `clippy::disallowed_methods` and `clippy::disallowed_types` (check, then revert); the `clippy.toml` lists match 0002 §3.
- [x] `pnpm test unit -t crate-policy` passes; temporarily adding `rand` to the engine crate's `[dependencies]` makes it fail naming `rand` (check, then revert).
- [x] Root `CLAUDE.md` has one line each for determinism and hot paths naming its rule file, and `pnpm test unit -t context-artifacts` (M01) passes with both rule files present.
- [x] `pnpm golden hash` rewrites an identical `golden.json` (no diff).
- [x] `WebAssembly.Module.imports` of `fx-hash` is exactly `engine.panic`, `engine.log`.
- [x] Rebuild time and `wasm` suite time recorded under Deviations.
- [x] `run-tests`-relevant commands work by name: `pnpm test wasm -t "import allowlist"` runs one test.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm test wasm` · `pnpm test rust` · `pnpm golden hash && git diff --exit-code packages/engine/fixtures/hash/golden/` · `pnpm lint`

## Budgets
- Test suite (`PRE-PLAN.md` §7, 0020 §3): `wasm` suite within its row; measured by the runner's per-suite line.
- Dev loop: one-line edit in `crates/engine/src/hash.rs` → `pnpm test` reaches its first test; record the runner's build duration (target: the Dev loop row). Also record the no-op cost of `build-fixtures` per fixture; above 2 s total, switch it to one `cargo build -p … -p …` invocation.
- Allocation per isolate: not measured here; `call0/1/2` and `region()` are written to the rule in `hot-paths.md` and first measured in M04.

## Context artifacts
- `.claude/rules/determinism.md` (paths: `packages/engine/crates/**`, `packages/engine/fixtures/*/src/**`; M20 adds `games/reference/sim/**` with the first file there): one screen linking 0002 §2–3.
- `.claude/rules/hot-paths.md` (paths: `packages/engine/src/**` except `src/test/**`): no allocation per frame or tick, views created once, fixed-arity calls; links 0014 §4 and 0016. M04 adds how to verify.
- Root `CLAUDE.md`: one line per invariant (determinism; no allocation in hot paths), each naming its rule file as `.claude/rules/<file>.md` (0021 §1); still within the cap. M01's `context-artifacts` test requires the link and that every `paths:` glob matches a file, so list a glob only once a file exists under it (`games/*/sim/**` is added by M20).
- `packages/engine/CLAUDE.md`: layout, fixture convention, the ABI rule above in three lines, where goldens live.

## Manual device checks
None.

## Deviations
No split: steps 1–7 fitted one session. No decision changed, so no ADR. Small corrections and exact shapes:

- **Additions to the registry** (both sides, covered by `abi registry`): `enum LogLevel { Error = 0, Warn = 1, Info = 2, Debug = 3 }` (the `level` of `engine.log`; release builds drop everything below `Warn`, 0014 §3), and the constants `BOOT_BYTES = 65536`, `BOOT_TEXT_BYTES = 4096` (the boot-region tail the panic hook formats into; config may use the rest) and `RESULT_BYTES = 64`. `engine::log(level: LogLevel, &str)`. `ABI_VERSION` is 1.
- **Who declares which region.** `engine_init` declares `Result` for every role before `Instance::init`; the implementor declares the rest through `RegionLayout::region` (fx-hash: `Rx` 64 B, `Tx` 64 B). Regions are 8-aligned and zero-filled; declaring one twice or with 0 bytes panics. `RegionLayout` also has `ptr`, `len`, `bytes`, `bytes_mut`, and is what a native test passes to `Instance::init`. An unknown role number is `BadConfig`; a `cfg_len` past the config part of the boot region is `BadLength`.
- **`Instance::sim_hash` defaults to `0`,** not `Unsupported`: its seam signature returns `u64`, and the role check has already run.
- **Arena exhaustion does not use `panic!`.** std formats a panic message into a `String` before the hook runs (`FormatStringPayload`), so a formatted `panic!` inside the allocator would re-enter it. `abi::panic::fatal(fmt::Arguments)` formats into the boot tail, calls `engine.panic` and executes `unreachable`; the arena uses it. The ordinary hook is allocation-free itself, as 0014 §6 asks. Message: `arena exhausted: requested N bytes with L live, reserved R bytes (arenaBytes)`.
- **For M07 (the hand-over question).** Probe, not a test: with `arenaBytes` 1 MiB, a 900 KiB allocation after init reused the freed reservation (`memGrows() === 0`, memory stayed 2,359,296 B). So reserve-and-free does give std's allocator the block back for large requests; fragmentation under cache churn is still M07's to measure.
- **`tsconfig.json` needs `lib: ["es2023", "dom"]`,** not only `types: ["node"]`: `@types/node` 22.20.3 does not declare `WebAssembly`; only `lib.dom` and `lib.webworker` do. `loader.ts` and `abi.ts` still use no DOM-only global. New `packages/engine/tests/tsconfig.json` (`allowImportingTsExtensions`) type-checks `tests/`; the package's `typecheck` script runs both.
- **Tests run against `src/`, plain scripts against `dist/`.** Vitest imports `../../src/*.js`. `bun-leg.mjs` and `scripts/golden.mjs` import `dist/` (Node's type stripping does not map `.js` to `.ts`), plus `tests/support/scenario.ts` directly, whose only runtime import is `src/abi.ts` (no imports of its own). `pnpm golden` runs `tsc` first and passes `--disable-warning=ExperimentalWarning`.
- **`buildGame` stubs every function import** when it reads `abiVersion`, whatever the import's name. With stubs for `engine.*` only, the `getrandom` module failed in the `fixtures` build step with a bare `LinkError` and the allowlist test never ran to say why.
- **Runner: `legs`.** A suite may carry `legs: [{ name, kind, ... }]`, extra runs reported on the suite's line (log: `test-results/<suite>/<leg>.log`). An adapter's `command` may return `null` (nothing to run). The `script` adapter takes `{ cmd, args, tests }`: `tests` names what the script reports so `-t` can skip it; the script prints one JSON line last, `{ tests: [{ name, ok, message? }] }`, and exits non-zero on failure; it has no slow tier. **The Bun leg compares with the golden itself** (`diffCheckpoints` in `scenario.ts`) and reports the verdict, rather than the runner comparing; the line also carries `checkpoints` and `runtime` for the log. It refuses to pass when not run under Bun, and carries the `script` adapter's permanent negative control (`--self-check-fail`). `scripts/lib/adapters.test.mjs` covers the adapter.
- **Test-support additions:** `fixtureNames()`, `fixtureBuildDir(name)`, `fixtureBytes(name)`, `readGolden(name, file)`; `scenario.ts` exports `HashScenario`, `Golden` (`{ checkpoints: string[] }`) and `diffCheckpoints`; `wasm-sections.ts` exports `funcType(sections, index)`. `scenario.json` is `{ role, config: InstanceConfig, ticks, checkpointEvery, input: { everyTicks, bytes, rule } }`; input byte `i` before tick `t` is `(t*31 + i*17 + (t>>3)) & 0xff`.
- **`clippy.toml` also bans `powi`** with the transcendentals (Rust documents its precision as unspecified too); every entry carries a `reason` citing 0002 §2.
- **Target-feature allowlist** captured from Rust 1.93.0: `bulk-memory`, `bulk-memory-opt`, `call-indirect-overlong`, `multivalue`, `mutable-globals`, `nontrapping-fptoint`, `reference-types`, `sign-ext`.
- **Hand checks (done once, reverted, nothing committed):**
  - `getrandom = { version = "0.2", features = ["js"] }` called from `sim_tick`: `import allowlist` failed with `fx-hash imports outside the allowlist: __wbindgen_placeholder__ (27: __wbg_crypto_…, …): a crate pulled in wasm-bindgen (getrandom's JS backend, …)` and `__wbindgen_externref_xform__ (2: …)`. The list is in the assertion message because Vitest elides a long array.
  - `f32::sin`, a `HashMap` field and `std::time::Instant::now()` in `fx-hash`: `pnpm lint` failed on clippy with "use of a disallowed method" for `f32::sin` and "use of a disallowed type" for `std::collections::HashMap` and `std::time::Instant`, each with its reason (lints `clippy::disallowed_methods`, `clippy::disallowed_types`).
  - `rand = { version = "0.9", default-features = false }` in the engine crate: `crate-policy` failed with `engine crate dependencies outside docs/decisions/0017 §7: expected [ 'rand' ]`. With default features `rand` fails earlier and as loudly: `getrandom` 0.3 does not compile for `wasm32-unknown-unknown`, so the `fixtures` build step fails.
- **Measurements** (Tyler's Mac, warm; one fixture):
  - `wasm` suite: 0.5–0.6 s of its 7 s (14 Vitest tests + the Bun leg). The scenario itself (10,000 ticks, 256 entities, dev profile) takes 11 ms under Node; nothing needed shrinking.
  - No-op build: `tsc` 0.34 s, `fixtures` 0.13 s (one fixture; far below the 2 s trigger for a single cargo invocation), `cargo-tests` 0.16 s.
  - One-line edit in `crates/engine/src/hash.rs` → tests starting: `tsc` 0.33 s + `fixtures` 0.27 s + `cargo-tests` 1.26 s ≈ 1.9 s of the 30 s Dev loop row.
  - Cold wasm build of `fx-hash` with `serde`, `serde_json`, `serde_derive`: 7.4 s. The sccache trigger is not near.
  - Dev-profile `game.wasm`: 3.7 MB (DWARF; never measured against the size budget).
