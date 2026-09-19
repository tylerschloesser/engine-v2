# M03: Browser harness: Playwright, fixture pages, `engine/test` skeleton, determinism in three browsers

Status: not started · After: 02b · Tyler-dependent: how the determinism page reaches a phone (default assumed: Cloudflare quick tunnel for iPhone, `adb reverse` for Android; see Planning decisions)

## Goal
`pnpm test` runs a fifth suite, `browser`, under the same output contract: Playwright Test against the built fixture app, cross-origin isolated. A test-only worker runs the fixture `.wasm` through the M02 loader, stepped from the main thread through the first version of `engine/test` (injectable `Clock`/`Scheduler`, `stepTick`, `stepFrame`, an awaitable quiescence point). The M02 golden hashes are reproduced in Chromium, WebKit and Firefox. The `run-tests` skill exists.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0020-testing-strategy.md` (§1–5, §8, §10)
3. `docs/decisions/0015-threads-memory-and-topology.md` (§1, §2 "Wake-ups" paragraph, §3)
4. `docs/decisions/0002-determinism-same-wasm-everywhere.md` (§3 "Cross-engine golden hashes"; Consequences)

Mine from spikes: `spikes/zero-gc-webgpu/public/worker.js` (`armedLoop`: the `Atomics.wait` lockstep and the leave-the-loop-for-CDP idea) and `public/main.js` (`run(n)`: all frames in one task, spin on the ack, the "await armed before starting" caveat), `spikes/zero-gc-webgpu/playwright.config.mjs`, `spikes/determinism-hash/driver/run-browsers.mjs` (three-engine loop), `spikes/vite-lib-worker-wasm/engine/src/{client.ts, worker.ts, protocol.ts}` (compile on main, post the `Module`, instantiate in the worker), `spikes/cross-origin-sab/src/isolation.ts` + `isolation-worker.ts` (what to assert for isolation on both sides).
Rules that apply: `.claude/rules/hot-paths.md` (the step path is measured in M04; write it allocation-free now).

## Scope
- `@playwright/test` (root devDependency, pin: 0017 §10), `packages/engine/playwright.config.ts`; in M01's runner: a `playwright` adapter (`scripts/lib/adapters.mjs`), suite `browser` and build step `pages` (`vite build` of the fixture app, dev profile) in `scripts/suites.mjs`, the Playwright browsers as a `TOOLS` row (`pnpm setup:tools` installs them).
- Production module `src/clock.ts`: `Clock`, `Scheduler`, the system implementations, and a lint that forbids ambient time anywhere else.
- `engine/test` (`src/test.ts` → `src/test/*`): manual clock, `createHarness`, the test-only harness worker, the step block.
- Pages: `wiring.html` (extended), `determinism.html`; specs for wiring, stepping and determinism.
- `pnpm device:serve` (serves the built fixture app for phones) and the `run-tests` skill.

## Non-scope
The zero-GC instrument, negative controls, `budgets.json` (M04). The production worker entry `worker.ts` / `run()`, `createClient`, rings, the production control block and `yield` flag (M06, M06b). Render targets, input injection, counters, device-loss flag from 0020 §8 (M09, M11, M15b/M31, M37b: each adds its piece to `engine/test`). WebGPU. CI (M10). Packaging smoke of the reference game (M20/M35).

## Files, packages and crates touched
`packages/engine` only (plus root `package.json` scripts and `biome.json`).
```
packages/engine/playwright.config.ts
packages/engine/src/clock.ts
packages/engine/src/test.ts
packages/engine/src/test/{manual-clock.ts, harness.ts, harness-worker.ts, step-block.ts, protocol.ts}
packages/engine/src/test/manual-clock.test.ts               (unit tests sit beside the source: M01 decision (a))
packages/engine/tests/browser/pages/{determinism.html, src/determinism.ts, src/wiring.ts (extended), src/stepping.ts, stepping.html}
packages/engine/tests/browser/{wiring,stepping,determinism}.spec.ts
packages/engine/tests/browser/support/page.ts
packages/engine/scripts/device-serve.mjs
scripts/suites.mjs, scripts/lib/{adapters,report}.mjs, scripts/setup-tools.mjs, biome.json, package.json (root: `device:serve`)
packages/engine/package.json (exports: add `./test`)
.claude/skills/run-tests/SKILL.md
```

## Seams
**Provides (production):** `src/clock.ts`:
- `interface Clock { now(): number }` (ms, monotonic).
- `interface Scheduler { setTimer(cb: () => void, delayMs: number): number; clearTimer(id: number): void; requestFrame(cb: (tMs: number) => void): number; cancelFrame(id: number): void }`.
- `systemClock`, `systemScheduler`: **the only file in `packages/engine/src/` (outside `src/test/`) allowed to name `Date`, `performance`, `setTimeout`, `setInterval`, `requestAnimationFrame`**; enforced by Biome `noRestrictedGlobals` with an override for this file, `src/test/**` and `tests/**`. Every later subsystem takes `{ clock, scheduler }` by injection (0020 §8). The sim worker's `Atomics.wait` timeout (0015 §2) is computed from `clock.now()`; M13 owns that.

**Provides (`engine/test`):**
- `createManualClock(startMs = 0): ManualClock` where `ManualClock extends Clock, Scheduler` plus `advance(ms)` (fires due timers in `(deadline, id)` order) and `frame(dtMs)` (advances, then runs the frame callbacks registered so far exactly once).
- `createHarness(opts: { wasm: EngineWasm | WebAssembly.Module, workers: HarnessWorkerSpec[], clock?: ManualClock }): Promise<Harness>`; `HarnessWorkerSpec = { name: string, role: Role, config: InstanceConfig }`. The `name` is the **isolate name** used by M04's budgets and controls; `'main'` is reserved.
- `Harness`: `clock`; `stepTick(): void` (every sim-role worker runs one `sim_tick`; returns when all have acknowledged); `stepFrame(dtMs: number): void` (`clock.frame(dtMs)` on main, then one step of every client-role worker: none exist before M06b, so it is main-only for now); both are synchronous and allocation-free once resumed. `resume(): Promise<void>` (workers enter their blocking wait loop; resolves when all report blocked-and-ready), `park(): Promise<void>` (workers return to their event loops so messages and CDP reach them), `untilQuiescent(): Promise<void>` (**the awaitable cross-thread quiescence point of 0020 §8**: resolves when every worker has acknowledged every request and is parked).; `hash(worker: string): Promise<string>`, `admit(worker, bytes: Uint8Array): Promise<Status>` (setup-rate, not for the measured window), `memoryBytes(): Promise<Record<string, number>>`, `memGrows(): Promise<Record<string, number>>`, `errors(): string[]`, `dispose()`. `park` / `resume` / `untilQuiescent` match the names M06b adds for the production topology (`parkWorkers`, `resumeWorkers`, `untilQuiescent`).
- Page contract used by every spec: a test page builds a harness and assigns `window.__harness` plus a page-specific result object; Node-side `tests/browser/support/page.ts` gives `openPage(page, path)` which navigates, asserts `crossOriginIsolated`, and fails the test on any `pageerror`, console `error`, or worker `error` event.
- Registering a browser test: a `*.spec.ts` under `tests/browser/`; tag `@engines` in the title to run it in WebKit and Firefox as well as Chromium; tag `@slow` to demote (0020 §4). Chromium launch args already include `--enable-unsafe-webgpu` (0020 §6) so M09 changes no config.
- `pnpm device:serve [--tunnel]`: builds the fixture app (dev profile) and runs `vite preview` on `127.0.0.1:4173`; `index.html` lists every page.

**Internal, replaced later:** `step-block.ts`, a test-only `Int32Array` over a small SAB per worker (`REQ`, `ACK`, `STATE`, `YIELD`, `CONTROL`, `ERR`). **M06/M06b** own the production control block, its `yield` flag and the ring sequence/ack counters, and add the same three operations for real workers; the `Harness` API above stays as it is for ABI-level tests; M13 moves `stepTick` onto the real sim worker.

**Consumes:** M02: `instantiate`, `Role`, `Status`, `RegionId`, `InstanceConfig`, fixture `hash` (`golden/scenario.json`, `golden/golden.json`), `runHashScenario`. M02b: `engine()`, `EngineWasm`, the fixture app, `fixtureWasm(name)`, `ENGINE_TEST_PORT`. M01: `scripts/suites.mjs`, the adapter interface, `report.mjs`, `TOOLS`, the `@slow` tag, the `unit` project glob.

## Planning decisions
**The harness worker is its own module under `src/test/`, not a kind of the production worker.** 0020 §8 requires the test entrypoint to be absent from production bundles, and M06b owns `worker.ts`. `harness.ts` spawns it with `new Worker(new URL('./harness-worker.js', import.meta.url), { type: 'module', name })` (pattern A shape, 0017 §3). It receives the compiled `Module` by `postMessage` (0015 §1), instantiates with the M02 loader, sets `self.__engineIsolateName = name`, and serves: `resume`, `hash`, `admit`, `memory`, and the blocking loop. When M06b lands real worker kinds, the harness gains the ability to drive them; this worker stays for ABI-level tests.

**Served build, not dev server** (decided in M02b): build step `pages` runs `vite build` of `tests/browser/pages` on the dev profile (so its time counts as build, with a captured log); Playwright's `webServer` only runs `vite preview` on `ENGINE_TEST_PORT`, `reuseExistingServer` locally.

**Browsers and projects.** Project `chromium` runs everything; projects `webkit` and `firefox` run only `@engines` specs (0020 §4 lists multi-engine repeats as the first thing to demote, so keep that set to the determinism spec). One browser per Playwright worker, new context per test, `fullyParallel`.

**Output contract.** Playwright runs with `--reporter=json` into `test-results/browser/report.json`; the new `playwright` adapter parses it into M01's `{ tests, failures }` shape (failure artefacts: trace, attachments). One extension to M01's contract: adapters may return `warnings: string[]`, and `report.mjs` prints each as a `warn` line under the suite line; the adapter fills it from test annotations of type `warning`. M04 uses this for the `Tracing.start` stall. Fast tier greps out `@slow`, slow tier greps for it (M01's tag).

**Determinism on a physical iPhone and Android phone (0002 deferred, 2→3).** Closed by hand from the device checklist using `determinism.html`, which shows each checkpoint hash next to the golden with a single PASS/FAIL banner, the user agent, and `crossOriginIsolated`. `crossOriginIsolated` needs a secure context, so `http://<LAN IP>` cannot work. Mechanism: `pnpm device:serve` (static preview, plugin headers on every response, no HMR socket), then
- **iPhone:** `pnpm device:serve --tunnel`, which also runs `cloudflared tunnel --url http://127.0.0.1:4173` (quick tunnel: HTTPS, no account) and prints the `https://….trycloudflare.com/determinism.html` URL; the app config adds `.trycloudflare.com` to `preview.allowedHosts` only when `ENGINE_DEVICE=1`.
- **Android:** `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/determinism.html` (`localhost` is a secure context).
- Fallback if Tyler prefers no third-party tunnel: an `mkcert` certificate given to `preview.https` with `--host`, which costs installing and trusting a root certificate on the phone.
This is Tyler's call (it installs `cloudflared` and exposes the fixture page on a random public URL while running); the default above is assumed. Real x86-64 is closed by M10.

**What `stepFrame` means before a client worker exists.** It advances the manual clock and runs main-thread frame callbacks. That is enough for M04's main-thread loop and fixes the signature M06, M09 and M17 build on.

## Order of work
1. `clock.ts`, manual clock, unit tests, the Biome restriction.
2. `step-block.ts`, `harness-worker.ts`, `harness.ts`; `stepping.html`.
3. Playwright config, `webServer`, `support/page.ts`, the adapter and `warnings`; register `pages` and `browser`; `TOOLS` row (`pnpm exec playwright install chromium webkit firefox`).
4. `wiring.spec.ts`, `stepping.spec.ts`.
5. `determinism.html` + spec in three engines.
6. `device-serve.mjs`; try the Android or tunnel path once if a phone is at hand (not an exit criterion).
7. Write `run-tests` from what was actually run.

## Tests added
- `unit`: `manual clock: timers fire in deadline order`, `manual clock: frame runs callbacks once`, `manual clock: cancel`.
- `browser` / `wiring.spec.ts` (Chromium): `crossOriginIsolated` and `SharedArrayBuffer` on main and in the worker; `Atomics.wait` works in the worker; wasm `Content-Type` and hashed `/assets/*.wasm` URL from `virtual:engine/wasm`; `buildHash` equals `game.json`; ABI version matches; an `engine.log` line arrives through `onLog`; a deliberate panic (`panicAtTick`) surfaces as `EngineTrap` with the Rust message and the harness reports it in `errors()`.
- `browser` / `stepping.spec.ts` (Chromium): 1,000 `stepTick()` in one task give the same hash as the scenario's checkpoint; `untilQuiescent()` resolves only after the last ack (assert `REQ === ACK` and `STATE === idle` at resolution); `park()` then `hash()` then `resume()` round-trips; `memGrows()` is 0.
- `browser` / `determinism.spec.ts` `@engines`: every checkpoint in `golden/golden.json` (read in Node, not trusted from the page) equals the page's in Chromium, WebKit and Firefox; on mismatch the message names the first divergent checkpoint (0020 §5).

## Exit criteria
- [ ] `pnpm test browser` passes and prints one line; `pnpm test` runs five suites in parallel.
- [ ] `pnpm test browser -t determinism` shows the golden reproduced in three engines (project names in the JSON report).
- [ ] Editing one checkpoint in `golden/golden.json` by hand makes native, `wasm` and all three browser projects fail naming that checkpoint (check, then revert).
- [ ] Adding `Date.now()` to `src/loader.ts` makes `pnpm lint` fail (check, then revert).
- [ ] `grep -r "test/" packages/engine/dist/{loader,clock,vite,server-node}.js` finds no import of test code.
- [ ] `pnpm device:serve` serves `determinism.html` showing PASS in a desktop browser.
- [ ] `.claude/skills/run-tests/SKILL.md` exists and its commands were each run once in this session.
- [ ] `browser` suite time recorded under Deviations.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm test browser` · `pnpm test browser -t determinism` · `pnpm test unit -t "manual clock"` · `pnpm lint` · `pnpm device:serve`

## Budgets
- Test suite row (`PRE-PLAN.md` §7; 0020 §3): `browser` suite line; record cold (first `vite build`) and warm numbers. Three browser launches run in parallel; if the suite's share exceeds a third of its row already, say so under Deviations so M04 knows its headroom.
- Dev loop row: unchanged; note the added `vite build` milliseconds.

## Context artifacts
- `.claude/skills/run-tests/SKILL.md`: `pnpm test [suite] [-t pattern]`, suite names, reading `test-results/`, `pnpm golden`, running one Playwright project, `ENGINE_TEST_PORT`, browser install, when to use the `playwright-cli` skill for a look at a page (0020 §1), `pnpm device:serve`.
- `packages/engine/CLAUDE.md`: the ambient-time rule in one line; how to add a browser spec and tag it.

## Manual device checks
[device-checks.md, M03: Determinism page](device-checks.md#m03-determinism-page). Not gating.
This milestone builds `determinism.html` and `pnpm device:serve [--tunnel]` (procedure: Planning decisions above); the first scheduled run is in M11's sitting.

## Deviations
(filled in during Phase 3)
