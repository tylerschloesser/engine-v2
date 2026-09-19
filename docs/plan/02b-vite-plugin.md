# M02b: Vite plugin, `virtual:engine/wasm`, fixture app

Status: not started · After: 02 · Tyler-dependent: no

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

## Seams
**Provides:**
- `engine(opts: { crate: string, profile?: 'dev' | 'release' }): Plugin` from `engine/vite`. Default profile per 0017 §4 (dev for `vite dev`, release for `vite build`).
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
`wasm` suite: `plugin-dev: headers on every response`, `plugin-dev: wasm served as application/wasm`, `plugin-dev: virtual module carries url and buildHash`, `plugin-dev: fs.allow contains engine dir`, `plugin-dev: touch triggers rebuild and full-reload`, `plugin-build: hashed non-inlined wasm asset`, `plugin-build: preview sends COOP/COEP`. Slow tier (same suite, `@slow` title): `plugin: rustc error reaches overlay and recovers @slow`.

## Exit criteria
- [ ] All tests above pass by name (`pnpm test wasm -t plugin`, `pnpm test:slow wasm -t "rustc error"`).
- [ ] `pnpm --filter engine exec vite build -c tests/browser/pages/vite.config.ts` succeeds and `vite preview` serves `wiring.html` with `crossOriginIsolated === true` (checked by hand in one browser; automated in M03).
- [ ] `packages/engine/src/vite.ts` imports Node built-ins and types only (`vite` stays a types-only optional peer, 0017 §2).
- [ ] `wasm` suite still inside its budget with the plugin tests added; number recorded under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

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
(filled in during Phase 3)
