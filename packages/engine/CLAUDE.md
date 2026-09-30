# packages/engine (TypeScript side)

The one publishable package (working name `engine`, private for now). Layout and package fields: `docs/decisions/0017-packaging-and-build.md` §1–§2. Deeper files: `crates/engine/`, `src/`, `src/host/`, `src/storage/`, `fixtures/`, `tests/netcode/`. Module detail: each module's doc comment, which names its brief.

## Layout

- `src/abi.ts` mirrors the ABI registry; `src/loader.ts` (`instantiate`, internal) is the one loader for every runtime. `build-game.ts`: `buildGame()` (`engine/vite`); `server-node.ts`: `engine/server/node`.
- `src/client.ts`: `createClient()`, main thread, never instantiates WASM (`main.no_wasm_instantiate`). `src/worker.ts`: one script for every worker kind (`src/worker/*.ts`) and one blocking-loop shell (`worker/shell.ts`); after setup, `postMessage` carries only `ready`/`fatal`/`resume`/`stop` (0015 §2).
- `src/render/` (0018); `src/camera/`, `src/input/`, `src/overlay/` (0019); `frame-loop.ts`: the per-rAF phase list. `src/net/link.ts`: the client's dead-timer/probe/backoff machine. `src/host/handshake.ts`'s `CloseCode` is the only signal a non-parsing net worker acts on; `src/host/sessions.ts`: session table; `src/client/secret.ts`: `loadOrMintSecret()`.
- `scripts/` (repo-only, plain Node): `build-fixtures.mjs` (`pnpm test`'s `fixtures` step), `golden.mjs` (`pnpm golden`); both import `dist/`, so run after `tsc`. `tsconfig.json` adds `lib: dom` only because `lib.dom`/`lib.webworker` declare `WebAssembly`; keep `loader.ts` and `abi.ts` free of DOM-only globals (they also run in Node, Bun, workerd).

## Worldgen

Rust (`engine::worldgen`, `engine::noise`; 0008 §1). Cross-runtime proof: `tests/support/scenario.ts`'s `kind: 'worldgen'` branch and `fixtures/worldgen`'s golden.

## Gen workers and the client queue

`worker/gen.ts` (gen role) and `worker/client-gen.ts` (the client's pump) move `genRequest`/`genResult` records (layout: `src/sab/layout.ts`); Rust side: `GenQueue`, `TerrainFeed` (0008 §4–5; M08b).

## Rendering, camera and input

Rules in force; the rest: briefs 09, 09b, 11, 17b, 18, `docs/plan/device-checks.md`.
- WGSL is edited in `src/render/wgsl/*.wgsl`, then `node scripts/embed-wgsl.mjs` regenerates the checked-in `wgsl.generated.ts` (a unit test fails when stale; `crates/engine/tests/main/wgsl.rs` runs `naga`).
- Probe, never screenshot (0020 §6): render into an offscreen `rgba8unorm` target with `engine/test`'s `renderTo`/`readPixels`/`expectPixel`. `tests/browser/support/gpu.ts`'s `expectAdapter` fails, never skips, on a null adapter. Keep "readback" in a GPU spec's file name (M10 greps `expectAdapter|readback`).
- **Listeners record, rAF integrates**: listeners only write fixed slots; every pan/zoom decision is made once per frame in `camera.ts`'s `integrate()`. A full `inputRing` drops and counts, never blocks or retries. `overlay/anchors.ts` never reads layout.
- Tests inject input with `engine/test`'s `injectPointer`/`injectWheel`/`injectKey` (after `attachCameraInputTestHooks`), never DOM dispatch. `tests/browser/pages/device.html` is the one page on real rAF and the production clock: Tyler's manual checks, `pnpm device:serve --tunnel`; parameters and HUD in `pages/src/device.ts`.

## The ABI

`crates/engine/src/abi/registry.rs` is the single owner and states the rule for adding to it (0014 §3). `pnpm test wasm -t "abi registry"` checks `src/abi.ts` and every fixture against it.

## Commands

- `pnpm --filter engine build`: `tsc`, `src/` → `dist/`, no bundler; `pnpm test`'s first step. `typecheck` covers `src/`, `tests/`, `tests/browser/pages/` (`pnpm lint` runs it).
- `pnpm test unit [-t pattern]`: `src/**/*.test.ts` plus `scripts/**/*.test.mjs`. `pnpm test wasm`: `tests/wasm/` against `src/`, plus the Bun leg (`bun-leg.mjs`) against `dist/`. `pnpm golden [fixture]`: the only writer of `golden/golden.json` (0020 §5). Review the diff: a changed golden is a changed sim.
- `pnpm golden:bytes [-- <nextest filter>]`: blesses native byte goldens, same review. One fixture crate: `GOLDEN_BLESS=1 cargo nextest run -p fx-<name> -E 'test(<test>)'` (the wrapper rejects `-p`/`-E`); then rebuild and retest the `.wasm` before committing.
- `pnpm bench:frame`: `bench.frame_worstcase`, the one frame-time exit criterion (0018 §9), gated against `baselines/frame.json` and never loosened to pass. Diagnosis and baseline updates: `profile-frame` skill.

## Conventions

- Zero runtime dependencies, no devDependencies here: tools are pinned in the root `package.json`. Add an `exports` subpath only together with the file that backs it. Final map: 0017 §2; M35 audits it.
- `tsconfig.build.json` excludes `*.test.ts` from `dist/`. Base options: root `tsconfig.base.json` (`types: []`: opt in to Node types). Erasable TypeScript (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Relative imports end in `.js`.
- No ambient time or randomness in `src/` outside `src/test/`: only `src/clock.ts` may name `Date`, `performance`, `setTimeout`/`setInterval`, `requestAnimationFrame` (Biome `noRestrictedGlobals`); `Math.random`/`getRandomValues`/`randomUUID` fail `-t no_ambient_random`. Inject a `Clock`/`Scheduler` (0020 §8).
- `src/sab/` (0015 §2): ring = reliable ordered stream, seqlock = small latest-wins record, triple buffer = large latest-wins frame.

## Where tests live

- `unit`: `*.test.ts` beside the source in `src/`; import `test`/`expect` from `vitest`. `wasm`, `netcode`, `browser`: `tests/<suite>/`. Helpers: `tests/support/` (`scenario.ts` imports only `src/abi.ts` at runtime, so it loads unbuilt).
- Fixture crates: `fixtures/` (`fixtures/CLAUDE.md`). `tests/` and `fixtures/` are unpublished. Slow tier: `@slow` in the title. New suites and build steps are registered in `scripts/suites.mjs` only.

## Browser test pages

`tests/browser/pages/` (default fixture `hash`, `profile: 'dev'`): add `<name>.html` plus `src/<name>.ts`. Other fixtures load through `fixtureWasm(name)`; `wiring.html` and `gc-loop.html` keep the real virtual module tested. A page ends with `window.__pageReady = true`, which `openPage` waits for. Port: `ENGINE_TEST_PORT` (default 4517).

## Adding a browser spec

- `tests/browser/*.spec.ts`: `test`/`expect` from `@playwright/test`, `openPage` from `./support/page.js` (fails on any page or console error). `@engines` in a title adds WebKit and Firefox, `pnpm test:slow` only (0020 §4); `@slow` moves a test there.
- Drive `window.__harness` via `engine/test` (contract: `src/test/harness.ts`; real-client counterparts: `src/test/client.ts`). Call `parkWorkers` before any CDP call into a worker (a blocked worker receives none); a production-topology page parks right after `client.ready`, before `__pageReady`.
- Zero-GC: `gc-test` skill; `burst` controls are `@slow` except on `gc-loop` ([0026](../../docs/decisions/0026-zero-gc-burst-controls-in-slow-tier.md)). `stepTick`/`untilQuiescent` never drain `client.uploadRing`: the page does (M20c).
