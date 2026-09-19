# packages/engine (TypeScript side)

The one publishable package (working name `engine`, private for now). Layout and package fields: `docs/decisions/0017-packaging-and-build.md` §1–§2. The Rust crate inside it has its own file: `crates/engine/CLAUDE.md`.

## Layout

- `src/abi.ts` mirrors the ABI registry; `src/loader.ts` (`instantiate`, internal, no exports-map entry) is the one loader for every runtime; `src/build-game.ts` is `buildGame()` (re-exported by `src/vite.ts` as `engine/vite`); `src/server-node.ts` is `engine/server/node` (`loadGame`).
- `scripts/` (repo-only, plain Node): `build-fixtures.mjs` is the `fixtures` build step of `pnpm test`; `golden.mjs` is `pnpm golden`. Both import `dist/`, so they run after `tsc`.
- `tsconfig.json` adds `lib: dom` because only `lib.dom` and `lib.webworker` declare `WebAssembly`; keep `loader.ts` and `abi.ts` free of DOM-only globals all the same (they run in workers, Node, Bun and workerd). `tests/tsconfig.json` type-checks `tests/` (`allowImportingTsExtensions`).

## The ABI

`crates/engine/src/abi/registry.rs` is the single owner and states the rule. Adding to the ABI is one commit: the extern in `export_instance!` plus a defaulted `Instance` method there, the row in `ABI_EXPORTS` (or the constant) in `src/abi.ts`, and `ABI_VERSION` bumped in both. Numbers are appended, never reused. `pnpm test wasm -t "abi registry"` compares the two files and every built fixture; a new *import* is an ADR amendment (0014 §3).

## Commands

- `pnpm --filter engine build`: `tsc -p tsconfig.build.json`, `src/` → `dist/`. No bundler. `pnpm test` runs this as its first build step.
- `pnpm --filter engine typecheck`: `tsc --noEmit` over `src/` including its tests, then over `tests/` (`tests/tsconfig.json`). `pnpm lint` runs it.
- `pnpm test unit [-t pattern]`: the Vitest `unit` suite (this package's `src/**/*.test.ts` plus `scripts/**/*.test.mjs`).
- `pnpm test wasm [-t pattern]`: Vitest project `wasm` (`tests/wasm/*.test.ts`, run against `src/`) plus the Bun leg (`tests/wasm/bun-leg.mjs`, run against `dist/`), reported on one line. The `fixtures` build step has built every fixture's dev-profile `.wasm` first.
- `pnpm golden [fixture]`: rebuilds, runs `golden/scenario.json` on the `.wasm` under Node and rewrites `golden/golden.json`. The only writer of a golden (0020 §5); review the diff, because a changed golden is a changed sim.

## Conventions

- Zero runtime dependencies, and no devDependencies here: every tool (`tsc`, Vitest, Biome) is pinned in the root `package.json` and resolves from there.
- Add an `exports` subpath only together with the file that backs it. The final map is 0017 §2; M35 audits it.
- `tsconfig.json` type-checks everything in `src/`; `tsconfig.build.json` extends it and excludes `*.test.ts` from `dist/`. Base options are in the root `tsconfig.base.json` (`types: []`: a tsconfig that needs Node types opts in).
- TypeScript must be erasable (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Relative imports carry the `.js` extension (`nodenext`).
- No ambient time or randomness in `src/` outside `src/test/`: `src/clock.ts` is the only file allowed to name `Date`, `performance`, `setTimeout`/`setInterval`, `requestAnimationFrame` (Biome `noRestrictedGlobals`, `biome.json`), and `Math.random`/`getRandomValues`/`randomUUID` fail `pnpm test unit -t no_ambient_random`; take a `Clock`/`Scheduler` by injection instead (docs/decisions/0020 §8).

## Where tests live

- `unit`: `*.test.ts` beside the source in `src/`. No globals: import `test`, `expect` from `vitest`.
- `wasm`: `tests/wasm/`. `netcode`, `browser` (later milestones): `tests/<suite>/`; browser pages under `tests/browser/pages/`. Shared helpers in `tests/support/`: `fixtures.ts` (find and load a built fixture), `scenario.ts` (the determinism driver shared by Node, Bun, `pnpm golden` and the browser page; its only runtime import is `src/abi.ts`, so plain runtimes load it unbuilt), `wasm-sections.ts` (signatures and memory limits, which the JS API does not expose).
- Fixture game crates: `fixtures/<name>/`, package `fx-<name>`, `crate-type = ["cdylib", "rlib"]`, `publish = false`, `[lints] workspace = true`, `engine = { path = "../../crates/engine" }`; every directory there is a crate and a cargo workspace member. Low-level fixtures call `engine::export_instance!`. Optional `golden/scenario.json` + `golden/golden.json` (Rust, Node/Bun and browser suites read the same files; hashes are 16-digit lowercase hex). `buildGame()` output lands in `fixtures/<name>/target/engine/dev/` (gitignored). The allowlist and registry tests iterate the directory, so a new fixture is covered by existing.
- `tests/` and `fixtures/` are outside `files`, so neither is published.
- Slow tier: put `@slow` in the Vitest test title. `pnpm test` skips it; `pnpm test:slow` runs only those.
- New suites and build steps are registered in `scripts/suites.mjs`, nowhere else.

## Browser test pages

`tests/browser/pages/` is the page host for every browser test from M03 on (`engine()` on
`fixtures/hash`, `profile: 'dev'`; test-only `fixturesPlugin()` serves the rest). Add a page: add
`<name>.html` at its root plus `src/<name>.ts` (the config globs `*.html` into the build input). A
page for any fixture other than `hash` loads it through `fixtureWasm(name)` (`fixture-wasm.ts`),
shaped exactly like `virtual:engine/wasm`'s `EngineWasm`; `wiring.html` is the only page importing
the real virtual module, so the public path stays tested. Port: `ENGINE_TEST_PORT` (default 4517,
`strictPort`), so two worktrees can run the browser suite at once.

## Adding a browser spec

A `*.spec.ts` under `tests/browser/` (one level up from `tests/browser/pages/`), importing `test`
and `expect` from `@playwright/test` and `openPage` from `./support/page.js` (navigates, asserts
`crossOriginIsolated`, fails the test on any page error or console error). Put `@engines` in a
test's title to also run it in WebKit and Firefox (`playwright.config.ts`'s `webkit`/`firefox`
projects grep for it; chromium runs everything); put `@slow` in the title to move it to
`pnpm test:slow` (0020 §4). `engine/test` (`createHarness`, `createManualClock`) is what a spec
drives through `page.evaluate` against a page's `window.__harness`; `src/test/harness.ts`'s own
doc comment has the exact contract (`resume`/`park`/`untilQuiescent`/`stepTick`/`stepFrame`/`hash`/
`admit`/`memoryBytes`/`memGrows`/`errors`).
