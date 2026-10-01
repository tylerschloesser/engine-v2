# 0045: Build profiles, measured

Status: Accepted (2026-09-30). Settles the Phase 3 deferral bullet of [0017](0017-packaging-and-build.md) Consequences (real release build time and size, an intermediate profile, `debug = "line-tables-only"`); amends [0015](0015-threads-memory-and-topology.md) §6 (engine JS budget: scope and number); closes [0034](0034-provisional-render-exports-subpath.md); records the Tier 1 browser-version policy. Implemented by M35. §3 amended by [0048](0048-fast-tier-budgets-dev-loop-and-wire-measurements.md) (`split-debuginfo = "packed"`).

## Context

[0017](0017-packaging-and-build.md) §6 and §9 fixed the profiles and the size budgets from a spike with a stub engine and a trivial game, and deferred the numbers that need a real sim. M35 builds the reference game (`games/reference/sim`, 712 KB release module) on the real profiles. All timings: Apple M3 Max, rustc 1.93.0, cargo, shared machine (1-minute load average 3 to 4 at the start of each build, 14 to 20 during the browser runs: foreign sessions); each is the median of 3 unless said otherwise. Rebuild timings are floors for this sim, not for a game with third-party crates.

## Decision

**1. Release profile: `opt-level = 3` stays; `wasm-opt` stays opt-in.** Reference game, release (`lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = true`), brotli 11:

| `opt-level` | raw | brotli | with `wasm-opt -O3` raw | with, brotli |
|---|---|---|---|---|
| 3 | 712,262 | 194,529 | 633,917 | 191,654 |
| `"s"` | 615,510 | 166,972 | 523,212 | 171,380 |
| `"z"` | 629,679 | 161,954 | 507,205 | 165,541 |

The module at `opt-level = 3` is 19 % of the 1 MB brotli warn budget, so the rule of 0017 ("stays 3 unless over the warn budget") holds. `"s"` is 14 % smaller in brotli but its speed cost is M36's to measure (benchmarks), not decided here. `wasm-opt` costs 0.55 to 0.57 s and saves 11 % raw and 1.5 % brotli at 3; at `"s"`/`"z"` it makes brotli larger (it re-inlines). So it is off by default and is a deploy choice. `buildGame({ wasmOpt })` runs `wasm-opt -O3` with the seven `--enable-*` flags of 0017 §5 when found on `PATH`, hashes afterwards, and `game.json` always carries `wasmOpt: boolean` so the deploy skew of 0017 Consequences (client and server built with and without it hash differently) is readable from the file. Requested but missing: the named warning `wasm-opt-missing`, the build proceeds. Cold build 11.1 s (11,131 / 11,072 / 11,146 ms), one-line edit rebuild 5.9 s (5,873 / 5,865 / 6,083 ms), load 3.75 / 3.28 / 2.97. `[profile.release-names]` (`inherits = "release"`, `strip = false`) exists only for the size tests: with names kept, `ts-rs zero bytes` finds no `ts_rs` symbol in the reference module, so 0017 §7's "LTO removes it" is verified, and the release-only behaviours are tested on it.

**2. No intermediate profile.** Rule from the M35 brief: add a thin-LTO incremental profile only if the `browser` suite exceeds its 0020 §3 budget on the dev profile *and* a CDP profile attributes at least 30 % of its wall clock to WASM execution. The suite runs in 43 s (43, 43, 42; one further run failed once on `browserContext.newPage` under a foreign load average of about 20, and passed on the retry) against 48 s, so the first condition is not met and no profile was added.

**3. `debug = "line-tables-only"` is adopted for `[profile.dev]`.** Rule: adopt unless it fails to cut the dev module's raw size by 25 % or lengthens the one-line-edit rebuild. Reference game, dev: 19,048,965 B with the current debug info, 7,338,727 B with line tables (-61.5 %); cold dev build 12.6 s against 10.4 s; one-line-edit rebuild median 400 ms (1,220 / 400 / 394) against 358 ms (935 / 358 / 356), load 3.0 to 4.0 throughout. Panic `file:line` ([0014](0014-js-wasm-boundary.md) §6) needs only line tables: `loader: panic marks instance dead with message` still sees `src/lib.rs` in the message. The root `Cargo.toml` carries it.

**4. `./render` stays its own subpath ([0034](0034-provisional-render-exports-subpath.md), outcome (a)).** Five files of `games/reference` (`game.ts`, `ui/collect.ts`, the `gc` and `test` entries) assemble the render loop from its pieces, under different clocks (real rAF, the stepped `ClientOptions.test` clock). Folding the assembly into `createClient` would make it take a clock and a drain policy it deliberately does not know ([0018](0018-renderer.md) §1). The exports map is final: 0017 §2 plus `./render`, pinned by the `exports-map` unit test; 0017 §2 should list it as ordinary surface.

**5. Engine JS budget: scope and number (amends [0015](0015-threads-memory-and-topology.md) §6).** "Engine JS ≤ 50 KB brotli across all entrypoints" was set before the renderer existed and without a measurement. Read literally it covers every `dist/*.js` reachable from a non-test subpath (82 files, 836,447 B raw, 247,962 B brotli), most of which is Node-only (`engine/server/*`, `engine/vite`) and never downloaded. The budget now measures what a player downloads: the browser entrypoints (`engine`, `engine/render`, and the worker chunk `client.js` reaches, each counted once), bundled and minified by Vite, brotli 11. Measured 52,853 B at the decision (main chunk 32,264 + worker 20,589); ceiling **58,000 B** = ceil(52,853 x 1.1), the repo's headroom precedent. `budgets.json` `size.engineJsBrotli` is 58,000 and `size.engineJsBrotliExact` 52,853; the test asserts the ceiling and prints the exact value and the delta (53,251 at the end of M35: checkSupport's limits and the module fallback). The `.wasm` budgets (1 MB warn, 2 MB fail, Requirements) are unchanged. Attribution, the basis of the number (each module's rendered code brotli'd alone, scaled so the groups sum to the chunk; bytes):

| Main chunk (32,239) | | Worker chunk (20,767) | |
|---|---|---|---|
| render (device, terrain, atlas, drawables, upload, frame loop) | 9,984 | sim host (`server.js`, `host/`, `storage/`) | 9,285 |
| camera, input, overlay | 8,022 | worker roles and shell | 5,111 |
| WGSL strings | 5,784 | net/link | 2,723 |
| client | 5,278 | sab and clock block | 1,670 |
| sab and clock block | 2,641 | abi, loader | 997 |
| abi, loader, config | 348 | test-only hooks (`worker/test-call`, `gc-hook`, `gen-record`) | 474 |
| other | 183 | camera block, other | 509 |

Nothing shipped is dev-only except the roughly 0.5 KB of worker test hooks, which the `browser` suite needs through the setup message. Largest single modules: `wgsl.generated` 9,158 alone, `client.js` 7,425, `server.js` 4,583, `host/persistence` 4,103. Revisit when the number moves by 10 % or the renderer or a worker kind is added.

**6. Browser-version policy (Tier 1, `docs/spec/client.md`).** "Current and previous major version" is met by policy, not by a pinned browser. Support is feature-detected by `checkSupport` and never by version; Playwright ships one build per engine and phones run what they run, so only current engine versions are tested, and a report from an older version is handled as a bug against the failing probe. Whether Tyler accepts this is Q12 (`docs/plan/questions-for-tyler.md`), listed again in M39's audit.

**7. The shipped crate carries no workspace inheritance.** `packages/engine/crates/engine/Cargo.toml` has literal `version`, `edition`, `publish` and inline `[lints.clippy]`, because no workspace root exists inside `node_modules`; the `exports-map` test fails on any `workspace = true` and on drift from the root's values. Found by the tarball test (`error inheriting publish from workspace root manifest`).

## Alternatives rejected

- **`opt-level = "s"` or `"z"` now:** a 14 to 17 % brotli saving on a module at 19 % of its warn budget buys nothing yet, and its speed cost is unmeasured.
- **A thin-LTO incremental profile for the browser suite:** the suite is inside its budget; a second build costs rebuild time and a second hash.
- **Keep 50 KB over every reachable file, or shrink to 50 KB:** the first cannot be met by any engine with a server and a Vite plugin in the same package; the second means removing about 3 KB from a renderer and a worker that are all in use, for a number nobody measured.
- **Folding `./render` into `createClient`:** see §4.
- **Always running `wasm-opt` when present:** the same source would hash differently per machine; opting in keeps the skew visible.

## Consequences

- CI installs binaryen `version_132` (SHA-256 pinned) and sets `REQUIRE_WASM_OPT=1` on the slow step; a developer machine without it prints `wasm-opt-missing` and passes.
- 0015 §6 should point here for the engine JS number; 0017's Consequences bullet on Phase 3 measurements is closed by this ADR. Snapshot, reload, restore is M37's. `wasm-opt` and `+simd128` safety for the sim stay M36b's; the release golden replay is M36's.
- Windows is neither tested nor claimed (`fs.watch` recursion in particular).
- Revisit the profile decisions when a game with third-party crates changes the rebuild numbers (M36b owns that verdict) or the `browser` suite leaves its budget.

## Sources

- `test-results/wasm/size.json` and `packages/engine/tests/wasm/size.test.ts`; `docs/plan/35-packaging-and-adapters.md` Deviations (all measurements, load averages, red lines).
- binaryen `version_132` release, checked 2026-09-30: https://github.com/WebAssembly/binaryen/releases/tag/version_132 (tarball SHA-256 195ddc94...c30572).
- [0017](0017-packaging-and-build.md) §5-§9, [0015](0015-threads-memory-and-topology.md) §6, [0034](0034-provisional-render-exports-subpath.md), [0014](0014-js-wasm-boundary.md) §6.
