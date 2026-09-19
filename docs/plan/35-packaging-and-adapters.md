# M35: Packaging: final exports map, tarball and size tests, pattern B proven, `checkSupport` final, release profile

Status: not started · After: 29, 35b · Tyler-dependent: no (Q1 answered: `ts-rs` is a normal dependency; the size test watches that LTO removes it)

Split: the Bun and Deno server adapters are `35b-bun-and-deno-adapters.md`; with them the reading list was 0017 + 0020 + 0018 + 0009 + 0005. 35b runs **first**, so the exports map frozen here has a real file behind every subpath and the tarball test can start a Bun server.

## Goal
The engine package is provably installable and usable from a tarball, outside both workspaces, with worker patterns A and B, and its size budgets are enforced by a test. `checkSupport` has its final failure list and the reference game shows a capability screen. The release profile is measured on the real reference game, `wasm-opt` runs when asked, and the profile questions 0017 deferred are closed with numbers in an ADR.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0017-packaging-and-build.md` (§2 exports map, §3 patterns A/B, §4 how the `.wasm` travels, §5 `wasm-opt`, §6 profiles, §7 `ts-rs`, §8 tarball test, §9 size budgets and profiles, Consequences: the "untested" and "deferred to Phase 3" bullets)
3. `docs/decisions/0020-testing-strategy.md` (§2 output contract, §3 rows "TS unit" and "Browser", §4 demotion rule)
4. `docs/decisions/0018-renderer.md` (§7 support and no fallback: what `checkSupport` must explain)

Mine from spikes: `spikes/vite-lib-worker-wasm/game/test/run.mjs` (install + dev + build/preview matrix), `game/test/sizes.mjs` (brotli 11 and the exact `wasm-opt` flags), `game/src/worker.ts` (pattern B), `RESULT.md` "Failed / caveats" (the `link:` cell). Rules that apply: none (no per-frame or sim code is touched).

## Scope
- **Exports map freeze.** `packages/engine/package.json` equals 0017 §2 plus any subpath a later ADR added. `unit` test `exports-map` (extends M02's): every subpath's `types` and `default` exist in `dist`; `dependencies` is empty (the Rust side of the same policy, 0017 §7, is M02's `crate-policy`; main never instantiating WASM, 0015 §1, is M06b's `main.no_wasm_instantiate`: neither is repeated here); `files` is exactly 0017 §2's list; `dist/worker.js` has no bare import specifier and no `import(`; no production entry imports `test.js`; `pnpm pack --json` lists nothing from `tests/`, `fixtures/`, `baselines/`, nor `budgets.json`.
- **Tarball-install test** (`browser` suite, `tarball-install @slow`), per 0017 §8: `pnpm pack` → install the `.tgz` with `--ignore-workspace` into a scratch Vite app under `os.tmpdir()` (outside both workspaces, no lockfile) whose `sim/Cargo.toml` path-depends on `node_modules/engine/crates/engine` → `vite dev` and `vite build` + `preview`, each with pattern A and pattern B, Chromium → assert one action round trip, `content-type: application/wasm`, a hashed non-inlined `/assets/*.wasm`, `crossOriginIsolated`, and the import allowlist (0014 §3) on the built module. **Server leg** from the same install: `engine/server/node` `loadGame(dir)` on the build output, one in-process join, host hash equals the browser's; repeated under Bun through `engine/server/bun`.
- **Pattern B proven for every worker kind.** `createWorker` exists since M06b; here the scratch game's two-line `worker.ts` must serve client, sim, gen and **net** kinds (M29 left net under pattern B to this milestone), in dev and in build.
- **Size test** (`wasm` suite, `size @slow`): release `game.wasm` of `games/reference` at brotli 11 against the warn/fail budgets; engine JS brotli summed over every `dist/*.js` reachable from a non-test subpath (owners: PRE-PLAN §7 "Download"). Ceilings in `budgets.json` under `size.*`. Writes `test-results/wasm/size.json` (raw and brotli per file).
- **`ts-rs` adds zero bytes** (`wasm` suite, `ts-rs zero bytes @slow`; 0017 §7): build the reference game on profile `release-names` (release with `strip = false`, used only here) and assert the module bytes contain no `ts_rs` symbol. No feature-gating of derives.
- **Release-only behaviours, checked on a release module** (no earlier milestone builds one in a test; both on profile `release-names`, `wasm` suite, `@slow`): `log` below `warn` is compiled out (0014 §3), and the arena grows in the steps of 0015 §5 up to the ceiling with `memGrows()` counting them M02 built `Arena` with the dev-profile trap only and left stepped growth out, so the release half of the 0015 §5 policy lands here in `Arena` (a few lines on the grow path, outside steady state; `.claude/rules/hot-paths.md` applies to that edit); the test drives it with M02's `exhaustAtTick` fixture switch. A fixture that logs one distinct string per level is needed; add the lines to `fx-hash` if no fixture does.
- **`wasm-opt` execution.** M02 accepts `buildGame({ wasmOpt })` and ignores it; here it runs `wasm-opt` with the 0017 §5 flag list when found on `PATH`, hashes afterwards (0017 §4), and `game.json` gains `wasmOpt: boolean` so the deploy skew in 0017 Consequences is visible. Requested but missing: one named warning `wasm-opt-missing`, build proceeds (0017 §5 semantics).
- **Measurements for the ADR:** reference game release build, cold and after a one-line edit; raw and brotli size at `opt-level` 3, `"s"`, `"z"`, each with and without `wasm-opt`; dev module size and one-line-edit rebuild with and without `debug = "line-tables-only"`; `browser` suite wall clock on the dev profile.
- **`checkSupport` final.** Keeps M06b's shape and codes (`not-isolated`, `no-sab`, `no-wasm`, `no-module-worker`, `no-webgpu`, `no-adapter` from M09) and adds failure `limits-too-low` (names the limit; compared with what the renderer requests, 0018 §7) and a `warnings` array: `no-opfs` (the world will be `durable: false`, 0005 Storage), `no-web-locks`. Capability-screen contract: the game branches on `code`; `message` is developer English. `games/reference` shows the screen instead of a blank canvas.
- **Plugin paths the spike left untested** (PRE-PLAN §10 row on 0017): owners under Planning decisions.
- Fast tier: confirm the packaging smoke of 0020 §3 (Vite-built reference game, `profile: 'dev'`) is in the `browser` suite; add it if no earlier milestone did.

## Non-scope
Bun/Deno adapters (35b). Durable Object adapter (M38: a recipe package outside the engine, `games/reference-server-do/`; no exports-map entry, 0009 Consequences). Publishing, name, license (0017 §8). Release golden replay (M36); `wasm-opt`/`+simd128` safety for the sim (M36b, handed over by M02). Windows. ABI or worker-kind changes.

## Files, packages and crates touched
`packages/engine` (`crates/engine` `Arena` release growth, `package.json`, `src/client.ts` / support module, `src/vite.ts`, `budgets.json`, `tests/browser/packaging/*` incl. `scratch-app/` template, `tests/wasm/size.test.ts`, `src/exports-map.test.ts`); root `Cargo.toml` (`[profile.release-names]` and what the ADR decides); `games/reference` (capability screen).

## Seams
**Provides:** `checkSupport` final: `{ ok, failures: { code, message }[], warnings: { code, message }[] }`; `buildGame` executing `wasmOpt`, `game.json.wasmOpt`; tests `tarball-install @slow`, `size @slow`, `ts-rs zero bytes @slow`, `plugin-dev: nested touch triggers rebuild`; helper `createScratchApp({ pattern: 'A'|'B', install: 'tarball'|'link' })` in `tests/support/` (M38 may reuse it); `budgets.json` keys `size.wasmBrotliWarn`, `size.wasmBrotliFail`, `size.engineJsBrotli`; Cargo profile `release-names`; ADR "Build profiles, measured".
**Consumes:** `buildGame`, `CargoBuildError`, import-allowlist helper, `loadGame`, `crate-policy`, `Arena`, fixture switch `exhaustAtTick`, `memoryBytes()`/`memGrows()`, `LoaderHooks.onLog` (M02); `main.no_wasm_instantiate` (M06b); `engine()` plugin, `watchCrate`, config-level `fs.allow` assertion (M02b); `createWorker`, setup message, `workers.url_fallback`, `TestFlags.postModule`, `checkSupport` minimum (M06b); `no-adapter` (M09); `host.kind` local/remote, `attachWebSocketServer`, `startTestServer` (M29); `HeadlessClient` (M27); `engine/server/bun` (35b); runner, `@slow` tag, `scripts/suites.mjs` (M01).

## Planning decisions
- **Packaging-spike untested items, one owner each.** (a) *`server.fs.allow` behaviour* (handed over by M02b): one extra tarball-test cell, `install: 'link'` with no workspace-root marker + pattern A + `vite dev`, the spike's deterministic failure; it must pass through the plugin's appended entry. If Vite's semantics make that impossible, the cell asserts the Vite log line is surfaced, the nested `CLAUDE.md` documents pattern B as the fix (risk 9), and the ADR records it. (b) *Recursive `fs.watch` on Linux:* M02b's touch test already runs on M10's Linux runner; add the nested-directory case here (`.rs` two directories deep). Windows is neither tested nor claimed; the ADR says so. (c) *Real Safari with a posted `Module`:* M06b built the URL path and hands the device question to M11's checklist. Here: read that result; if Safari refused, or the check never ran, make `createClient` fall back automatically (`DataCloneError` on post or `messageerror` from the worker → re-send setup with `wasmUrl`), about twenty lines plus one test using `TestFlags`. Otherwise nothing. (d) *`ts-rs` zero bytes:* the symbol test. (e) *Sub-4 KB `.wasm`:* moot per 0017.
- **Intermediate profile: decided by rule, default "do not add".** Add a thin-LTO incremental profile for the `browser` suite only if that suite exceeds its 0020 §3 budget on the dev profile **and** a CDP profile attributes at least 30 % of its wall clock to WASM execution. A second fast-tier build costs rebuild time and makes a second build hash, so the bar is high. M36b's audit may reopen this with its numbers; nothing else may.
- **`debug = "line-tables-only"`: decided by rule, default "adopt for `[profile.dev]`".** Adopt unless it fails to cut the dev module's raw size by 25 % or lengthens the one-line-edit rebuild. Panic file:line (0014 §6) needs only line tables; nobody steps through WASM with variable-level DWARF here. M02's `loader: panic marks instance dead with message` must still show the location.
- **`opt-level` stays 3** (0017 §6) unless the release module is over the warn budget; then record `"s"`/`"z"` sizes and hand the speed side to M36's benchmarks.
- **Real release build time and size** are measured here and written, with the three decisions above, into one new ADR "Build profiles, measured" (next free number, `write-adr` skill), superseding the matching deferral bullet of 0017. Snapshot → reload → restore is decided in M37.
- **Tier 1 "current and previous major version" (spec `client.md`) is met by policy, not by a pinned browser.** Support is feature-detected by `checkSupport`, never by version; Playwright ships one build per engine and phones run what they run, so only current engine versions are tested. The ADR "Build profiles, measured" records this in one paragraph; whether Tyler accepts it is Q12 (`questions-for-tyler.md`), which M39's audit lists.
- **The shipped crate's manifest must not use workspace inheritance** (`*.workspace = true`, `[lints] workspace = true`): no workspace root exists inside `node_modules`. The tarball test is what catches it; fix the manifest, not the test.
- **Scratch location:** fixed `<tmpdir>/engine-tarball-test/`, recreated per run, with `CARGO_TARGET_DIR=<tmpdir>/engine-tarball-target/` kept between runs so the slow tier pays the cold dependency build once. Never inside the repo (0017 §6: an ancestor `[workspace]` would adopt the crate).

## Order of work
1. `exports-map` final. 2. `createScratchApp` + `tarball-install`: tarball cells, then the link cell, then the server leg. 3. `wasmOpt` execution, `release-names`, `size`, `ts-rs zero bytes`. 4. Nested-touch watch test. 5. `checkSupport` final + capability screen. 6. Safari item (c). 7. Measurements, decisions, ADR. 8. Context artifacts.

## Tests added
`unit`: `exports-map` (final), `checkSupport: each code` (each failure forced by stubbing the global it probes; the only stubs in this milestone). `browser` fast: `checkSupport ok on the harness page`, `reference: capability screen on failure`, packaging smoke if absent. `browser` slow: `tarball-install @slow` (4 tarball cells: dev and build+preview × A and B; 1 link cell; server leg Node + Bun). `wasm`: `plugin-dev: nested touch triggers rebuild`; slow: `size @slow`, `ts-rs zero bytes @slow`, `build: wasm-opt changes hash and sets game.json @slow`, `release module drops info logs @slow` (the `release-names` module holds the fixture's `warn` and `error` strings and neither its `info` nor its `debug` string, and `onLog` never fires below `warn`), `release growth steps 16 MiB and counts @slow` (a release instance allocating past its initial arena: every `memoryBytes()` delta is the 0015 §5 step, `memGrows()` equals the number of steps, growth stops at the ceiling).

## Exit criteria
- [ ] `pnpm test unit -t exports-map` passes; `pnpm --filter engine pack --json` lists only `dist/**`, `crates/**`, `package.json`.
- [ ] `pnpm test:slow browser -t tarball-install` passes every cell, all four worker kinds under pattern B, and the server leg.
- [ ] `pnpm test:slow wasm -t size`, `-t "ts-rs zero bytes"`, `-t "release module drops info logs"` and `-t "release growth steps"` pass; `test-results/wasm/size.json` exists; a warn-level size is recorded in Deviations, not hidden.
- [ ] `checkSupport` returns each code under its forced condition and `ok: true` on the harness page; the reference game shows the capability screen when `ok` is false.
- [ ] The ADR "Build profiles, measured" holds every number listed under Scope, the three profile decisions and the browser-version policy paragraph (Planning decisions); root `Cargo.toml` matches it.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test unit -t exports-map` · `pnpm test:slow browser -t tarball-install` · `pnpm test:slow wasm -t size` · `pnpm --filter engine pack --json`

## Budgets
PRE-PLAN §7 "Download": the `size` test (both `.wasm` thresholds, engine JS). "Dev loop": the one-line-edit rebuild numbers recorded here feed M36b, which owns the verdict. "Test suite": new fast tests stay under the 0020 §4 p95 limits; anything that builds release or installs a tarball is `@slow`.

## Context artifacts
`packages/engine/CLAUDE.md`: the packaging tests and how to run them, the no-workspace-inheritance rule, scratch-app location, pattern B recipe. `run-tests` skill: reading `size.json`. `games/reference` README: pattern B and `checkSupport` usage in five lines. No new rule file.

## Manual device checks
[device-checks.md, M35: Built reference game in real Safari](device-checks.md#m35-built-reference-game-in-real-safari) (this row carries **D**).
Items M35-safari-build-mac and M35-safari-build-iphone decide item (c) of Planning decisions; M35-capability needs the capability screen.

## Deviations
(filled in during Phase 3)
