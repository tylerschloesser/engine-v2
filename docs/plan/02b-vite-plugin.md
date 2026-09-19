# M02b: Vite plugin, `virtual:engine/wasm`, fixture app

Status: done · After: 02 · Tyler-dependent: no

Split out of M02 (see the split note there). Nothing is scheduled between 02, 02b, 03 and 04.

## Goal
`engine/vite` exports the `engine()` plugin of 0017 §5: it drives `buildGame`, serves the `.wasm` as data through `virtual:engine/wasm` in dev and in build, sets COOP/COEP, rebuilds on Rust edits and reports rustc errors. A small multi-page Vite app under `packages/engine/tests/browser/pages/` consumes it and is the page host for every later browser test. Everything here is verified from Node (Vite's JS API + `fetch`), so no browser is needed yet.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0017-packaging-and-build.md` (§3, §4 browser bullet, §5, Consequences "untested")
3. `docs/decisions/0015-threads-memory-and-topology.md` (§3 only: the exact headers and why every response needs them)
4. `docs/decisions/0020-testing-strategy.md` (§2, §3, §4 for the `slow` tag)

Mine from spikes: `spikes/vite-lib-worker-wasm/engine/src/vite.ts` (whole file: port it, replacing the regex over `Cargo.toml` and the inline cargo call with M02's `buildGame`; drop the `exclude` and `workerFormat` spike toggles), `.../game/src/env.d.ts` (virtual module declaration), `.../game/test/overlay.mjs` (error → overlay → recovery sequence), `spikes/cross-origin-sab/vite.config.ts` (header block). Rules that apply: `.claude/rules/hot-paths.md` does not (build-time code).

## Scope
- `packages/engine/src/vite.ts`: `engine(opts)`; `src/virtual.d.ts`.
- Dev: `buildStart` build once, middleware serving the file as `application/wasm` with a `?v=N` cache-buster, recursive `fs.watch` on the game crate and the engine crate (`.rs`, `Cargo.toml`, 30 ms debounce, `target/` ignored), `full-reload` on success, rustc stderr to the error overlay on failure and recovery after the fix.
- Build: `this.emitFile` + `import.meta.ROLLUP_FILE_URL_<ref>`, hashed and never inlined.
- Config injected: COOP/COEP on `server.headers` and `preview.headers`, `worker.format: 'es'`, the engine package's real directory appended to `server.fs.allow` (Vite's default root kept). No `optimizeDeps.exclude` (0017 §5).
- The fixture app and its test-only `fixturesPlugin()`.

## Non-scope
The bindings step (M16). `wasm-opt` (M35). Any page logic, workers, Playwright (M03). The tarball-install test and pattern B (M35). Host recipes for production headers (M20 README, M38).

## Files, packages and crates touched
`packages/engine` only.
```
packages/engine/src/{vite.ts, virtual.d.ts}
packages/engine/tests/browser/pages/{vite.config.ts, fixtures-plugin.ts, index.html, wiring.html, tsconfig.json}   (location fixed by M01 decision (a))
packages/engine/tests/browser/pages/src/{wiring.ts, fixture-wasm.ts}
packages/engine/tests/wasm/{plugin-dev,plugin-build,plugin-rebuild-error}.test.ts
packages/engine/package.json   (exports: add `./virtual`)
```
Note from M02: `packages/engine/tests/tsconfig.json` already type-checks everything under `tests/` (extends the package tsconfig, which has `lib: dom` and `types: node`; `allowImportingTsExtensions`). Either let it cover the pages or add `exclude: ["browser/pages"]` there when the pages get their own `tsconfig.json`; the package's `typecheck` script must end up covering both.

## Seams
**Provides:**
- `engine(opts: { crate: string, profile?: 'dev' | 'release' }): Plugin` from `engine/vite`. Default profile per 0017 §4 (dev for `vite dev`, release for `vite build`), exposed as `api.profile` on the returned plugin once the config is resolved.
- `import wasm from 'virtual:engine/wasm'` → `{ url: string, buildHash: string }` (type `EngineWasm`, declared in `engine/virtual`). This object is what `createClient({ wasm })` takes (M06b) and what `engine/test` takes (M03).
- The fixture app. Root `packages/engine/tests/browser/pages/`; **adding a page = adding `<name>.html` at the app root plus `src/<name>.ts`**; the config globs `*.html` into `build.rollupOptions.input`. Config: `engine({ crate: '../../../fixtures/hash', profile: 'dev' })`, `build.minify: false` (M04 attributes allocations by function name), `build.target: 'es2022'`, port from `ENGINE_TEST_PORT` (default 4517, `strictPort`), so two worktrees can run at once.
- `fixturesPlugin()` (test-only, in the app): serves, in dev and in the built output, `/fixtures/<name>/game.wasm` (`application/wasm`) and `/fixtures/<name>/game.json` for every directory in `packages/engine/fixtures/` from its `target/engine/dev/` output (already built by `pnpm test`'s build step). `src/fixture-wasm.ts`: `fixtureWasm(name): Promise<EngineWasm>`. Pages for any fixture other than `hash` use this; `wiring.html` uses the real virtual module so the public path stays tested.
- `wiring.html` / `src/wiring.ts`: for now only imports `virtual:engine/wasm`, fetches the URL and writes `{ url, buildHash, contentType, crossOriginIsolated }` to `window.__wiring`. M03 extends it with the worker.

**Consumes:** M02: `buildGame`, `CargoBuildError`, `game.json`, fixture `hash`, suite `wasm`, build step `fixtures`. M01: runner, `pnpm test:slow`, the `@slow` title tag, `toolEnv()`.

## Planning decisions
**One plugin instance = one crate; other fixtures come from `fixturesPlugin()`.** 0017 gives the plugin a single `crate`, which is right for games. Tests need many fixtures on one server, so a 50-line test-only plugin serves prebuilt fixture outputs under the same `{ url, buildHash }` shape instead of widening the public option.

**The browser suite will run against `vite build` + `vite preview` of this app, not `vite dev`** (decided here because it shapes the config; M03 wires it). Reasons: no HMR client or websocket on the measured page (M04), the emitted hashed asset path is exercised on every run, and the output is static like production. The dev-server path is covered by this milestone's Node-level tests.

**`server.fs.allow` and recursive `fs.watch` on Linux (0017 "untested", PRE-PLAN §10).** `fs.allow`: implemented here and asserted only at config level (`resolvedConfig.server.fs.allow` contains the engine package's real directory), because the failing layout cannot occur inside this workspace (0017 §3). Behavioural proof is handed to **M35**: its tarball-install test must add the spike's failing case (`link:` dependency, no workspace-root marker, `vite dev`, pattern A) and see it pass. Recursive `fs.watch`: first exercised by `plugin-dev: touch triggers rebuild and full-reload` below, on macOS now and on Linux in **M10**'s first CI run; if it fails there, M10 replaces the single recursive watcher with one watcher per directory from a walk at start-up (the plugin keeps the watcher behind one function, `watchCrate(dir, onChange)`, for that reason).

**Rebuild tests must not edit tracked files.** The fast test changes only the mtime of `fixtures/hash/src/lib.rs` (`utimes`), which fires the watcher and makes cargo rebuild that one crate with no content diff. The rustc-error → overlay → recovery test needs broken source, so it copies `fixtures/hash` to an OS temp dir with an absolute path dependency and an empty `[workspace]` table (own target dir, cold build), and carries `@slow` in its title (M01's tag convention), which moves it to `pnpm test:slow`.

## Order of work
1. Port the plugin onto `buildGame`; `virtual.d.ts`; `watchCrate`.
2. Fixture app + `fixturesPlugin()`; run `vite dev` by hand once and open `wiring.html` in any browser to see `crossOriginIsolated: true`.
3. `plugin-dev.test.ts` with Vite's `createServer` on an ephemeral port: headers on `/`, on `/src/wiring.ts` and on the wasm route; wasm `Content-Type`; `server.transformRequest('virtual:engine/wasm')` yields a URL with `?v=` and the `buildHash` of `game.json`; resolved `fs.allow`; touch → a `full-reload` payload observed on a WebSocket client (Node's global `WebSocket`, subprotocol `vite-hmr`) and `?v` incremented.
4. `plugin-build.test.ts` with Vite's `build` into a temp `outDir`: one `assets/*.wasm` whose name carries a hash, bytes equal to `game.wasm`, no `data:` URL in any chunk, `fixtures/hash/game.wasm` present; then `preview` on an ephemeral port: both headers on the HTML, a JS chunk and the wasm.
5. Slow test for the overlay path: `{ type: 'error' }` payload carries rustc's message; after restoring the source a `full-reload` follows.

## Tests added
`wasm` suite: `plugin-dev: headers on every response`, `plugin-dev: wasm served as application/wasm`, `plugin-dev: virtual module carries url and buildHash`, `plugin-dev: fs.allow contains engine dir`, `plugin-dev: touch triggers rebuild and full-reload`, `plugin-build: hashed non-inlined wasm asset`, `plugin-build: preview sends COOP/COEP`, `plugin: default profile follows the Vite command` (0017 §4; no `profile` option: Vite's `resolveConfig` with command `serve` then `build`, reading the chosen profile from the plugin's `api.profile`, gives `dev` then `release`; no cargo call, so the fast tier pays no release build). Slow tier (same suite, `@slow` title): `plugin: rustc error reaches overlay and recovers @slow`, `plugin-build: default profile writes a release game.json @slow` (a real `vite build` with no `profile` option; `game.json.profile === 'release'`).

## Exit criteria
- [x] All tests above pass by name (`pnpm test wasm -t plugin`, `pnpm test:slow wasm -t "rustc error"`, `pnpm test:slow wasm -t "default profile"`).
- [x] `pnpm --filter engine exec vite build -c tests/browser/pages/vite.config.ts` succeeds and `vite preview` serves `wiring.html` with `crossOriginIsolated === true` (checked by hand in one browser; automated in M03).
- [x] `packages/engine/src/vite.ts` imports Node built-ins and types only (`vite` stays a types-only optional peer, 0017 §2).
- [x] `wasm` suite still inside its budget with the plugin tests added; number recorded under Deviations.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test wasm -t plugin` · `pnpm test:slow wasm -t "rustc error"` · `pnpm test` · `pnpm lint`

## Budgets
- Dev loop row of `PRE-PLAN.md` §7: the touch test records watcher-fire → `full-reload` milliseconds; compare with the spike floor in 0017 §5 and record it.
- Test suite row: `wasm` suite total.

## Context artifacts
`packages/engine/CLAUDE.md`: add "how to add a test page" and "fixtures other than `hash` load through `fixtureWasm(name)`".

## Manual device checks
None.

## Deviations

No split: steps 1–5 fitted one session. No decision changed, so no ADR. Exact shapes and findings:

- **`server.fs.allow` gets the whole engine package directory,** not just `crates/`: `enginePackageDir()` = `resolve(dirname(fileURLToPath(import.meta.url)), '..')` (works from `src/` or `dist/`). A real `resolveConfig` shows Vite's own default entries survive alongside it (arrays concatenate through `mergeConfig`): `['/…/packages/engine', '/…/node_modules/.pnpm/vite@8.3.0_…/vite/dist/client']`. `watchCrate(dir, onChange): FSWatcher | undefined` is exported (the hand-over point named in the planning decision); it watches `crateDir` and a separate `engineCrateDir()` (`<package>/crates`).
- **A route that terminates its own response must set COOP/COEP itself.** Found by `plugin-dev: headers on every response`: the wasm dev route and `fixturesPlugin()`'s fixture routes call `res.end()` directly, which never reaches Vite's own header-setting middleware (it runs later in the default chain). Vite's `server.headers`/`preview.headers` still cover every response that continues through `next()` (`/`, `/src/*.ts`, built assets under `vite preview`), but a plugin's own terminal middleware does not inherit them. Fixed by setting both headers explicitly wherever a middleware calls `res.end()`.
- **`engine/virtual`'s ambient module needs a top-level-import/export-free file.** `declare module 'virtual:engine/wasm' { … }` inside a file that already has its own top-level `import`/`export` *augments* an existing module rather than creating one, so `Cannot find module 'virtual:engine/wasm'` even though the file is on the program (confirmed with a minimal two-file `tsc` repro). `src/virtual.d.ts` therefore declares `EngineWasm` *inside* the `declare module` block only; both `import wasm from 'virtual:engine/wasm'` and `import type { EngineWasm } from 'virtual:engine/wasm'` work from any file that has the declaration in scope (the pages app's own `tsconfig.json` adds it via `"include"` since it isn't a package consumer of `engine/virtual`).
- **tsc does not copy a hand-written `.d.ts` input file into `outDir`.** `dist/virtual.d.ts` (what `package.json`'s `"./virtual"` types condition points at) needed `packages/engine/scripts/copy-virtual-dts.mjs`, run after `tsc` in the package's `build` script.
- **The fixture app's `vite.config.ts` and `fixtures-plugin.ts` import each other and `../../../src/vite.ts` with explicit `.ts` extensions,** not the `.js`-pointing-at-`.ts` convention `src/` uses internally. Untested here: whether Vite 8's Rolldown-based config bundler resolves a `.js` specifier to a sibling `.ts` file the way Vite's dev/build module graph does (confirmed working for `src/wiring.ts`'s `virtual:engine/wasm` import and for Vitest's own `../../src/*.js` imports elsewhere in this package) — explicit extensions sidestep the question entirely for the config-loading path.
- **The slow overlay test needed `realpath()` on its `mkdtemp` result.** `buildGame`'s `artifactPath()` (M02) matches `cargo metadata`'s `manifest_path` by exact string; macOS's `$TMPDIR` is itself a symlink (`/var/folders/… → /private/var/folders/…`), so an un-realpath'd copy's crate is never found (`"…/Cargo.toml has no cdylib target"`, the generic error `buildGame` gives when the manifest lookup itself fails). Worked around in the test (out of M02b's scope to change `build-game.ts`); flagged here in case a later milestone hits the same thing on a bare `$TMPDIR` path elsewhere.
- **`EnginePluginApi = { profile: Profile }`**, read off `plugin.api` once `configResolved`/`config` has run; set in the `config` hook so `resolveConfig` alone (no `buildStart`) is enough to read it.
- **Measurements** (Tyler's Mac, warm):
  - `wasm` suite: 23 tests (15 from M02 + 8 here), ~0.9–1.0 s of its 7 s budget.
  - Dev loop row: watcher-fire → `full-reload` on the wasm dev route, mtime-only touch, no content diff: **~200–235 ms** (200.85 ms inside the suite, 233.5 ms isolated), against the spike floor of 220 ms (trivial crate, save → page, 0017 §5) — consistent, since this is the same shape of change.
  - `plugin: rustc error reaches overlay and recovers @slow`: ~4.8–5.1 s (a real cold build: fresh `[workspace]`, its own `target/`, no shared incremental state).
  - `plugin-build: default profile writes a release game.json @slow`: ~4.6 s cold (first run, release profile never built for `fx-hash` before), ~1 s once its `target/engine/release` incremental state is warm.
- **Exit criterion 2, done by hand (this session):** `pnpm --filter engine exec vite build -c tests/browser/pages/vite.config.ts` (and separately `vite dev`) then `vite preview`, opened in Chromium via the `playwright-cli` skill: `window.__wiring.crossOriginIsolated` read `true` in both the build+preview and the dev-server case; a `utimes` touch to `fixtures/hash/src/lib.rs` under `vite dev` bumped the dev route's `?v=` from 1 to 2 on reload.
- **Orchestrator gate (2026-09-19):** `pnpm gate 2debfab` clean (18 files, +756/−7, no goldens or markers changed); `pnpm test` (rust 16, unit 44, wasm 23 in 1 s/7 s) and `pnpm lint` green. Exit criterion 2 re-run by the orchestrator: `vite build` then `vite preview` on port 4519, `playwright-cli --raw eval` of `window.__wiring` in Chromium gave `{"url":"/assets/game-D8nkzLPz.wasm",…,"contentType":"application/wasm","crossOriginIsolated":true}`, and `curl -I /wiring.html` showed both COOP/COEP headers. Files outside the brief list, accepted: `packages/engine/scripts/copy-virtual-dts.mjs` (10 lines) and the `exclude` in `tests/tsconfig.json`. The symlinked-crate-path fix for `buildGame` is assigned to M35 (its brief, Planning decisions).
