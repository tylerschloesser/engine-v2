# M03: Browser harness: Playwright, fixture pages, `engine/test` skeleton, determinism in three browsers

Status: done · After: 02b · Tyler-dependent: no (Q7 answered: a Cloudflare quick tunnel is OK; Q5 answered: iPhone only, so the `adb reverse` path is documented but unused; see Planning decisions)

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
packages/engine/src/no-ambient-random.test.ts
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
- Ambient randomness gets the same treatment (spec `testing.md`, "Everything random is seeded"). `Math.random` is a member, which `noRestrictedGlobals` cannot name, and banning the whole `crypto` global would also ban WebCrypto hashing (M28), so the equivalent lint is a `unit` source scan, `lint.no_ambient_random`, over `packages/engine/src/**` outside `src/test/**`: it fails on `Math.random`, `getRandomValues` and `randomUUID`. Its allowlist has one documented entry, `src/client/secret.ts`, the device-secret module M28 adds; no other entry without an ADR.

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

**Determinism on a physical phone (0002 deferred, 2→3).** Tyler's device is an iPhone only (Q5), so the Android row of the checklist is "not run: no device". Closed by hand from the device checklist using `determinism.html`, which shows each checkpoint hash next to the golden with a single PASS/FAIL banner, the user agent, and `crossOriginIsolated`. `crossOriginIsolated` needs a secure context, so `http://<LAN IP>` cannot work. Mechanism: `pnpm device:serve` (static preview, plugin headers on every response, no HMR socket), then
- **iPhone:** `pnpm device:serve --tunnel`, which also runs `cloudflared tunnel --url http://127.0.0.1:4173` (quick tunnel: HTTPS, no account) and prints the `https://….trycloudflare.com/determinism.html` URL; the app config adds `.trycloudflare.com` to `preview.allowedHosts` only when `ENGINE_DEVICE=1`.
- **Android (unused option; no device, Q5):** `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/determinism.html` (`localhost` is a secure context). It needs nothing from the script and is not tried.
- Fallback if the tunnel ever stops working: an `mkcert` certificate given to `preview.https` with `--host`, which costs installing and trusting a root certificate on the phone.
Tyler approved the tunnel (Q7: it installs `cloudflared` and exposes the fixture page on a random public URL while running). Real x86-64 is closed by M10.

**What `stepFrame` means before a client worker exists.** It advances the manual clock and runs main-thread frame callbacks. That is enough for M04's main-thread loop and fixes the signature M06, M09 and M17 build on.

## Order of work
1. `clock.ts`, manual clock, unit tests, the Biome restriction.
2. `step-block.ts`, `harness-worker.ts`, `harness.ts`; `stepping.html`.
3. Playwright config, `webServer`, `support/page.ts`, the adapter and `warnings`; register `pages` and `browser`; `TOOLS` row (`pnpm exec playwright install chromium webkit firefox`).
4. `wiring.spec.ts`, `stepping.spec.ts`.
5. `determinism.html` + spec in three engines.
6. `device-serve.mjs`; try the tunnel path once if the iPhone is at hand (not an exit criterion).
7. Write `run-tests` from what was actually run.

## Tests added
- `unit`: `manual clock: timers fire in deadline order`, `manual clock: frame runs callbacks once`, `manual clock: cancel`, `lint.no_ambient_random` (`src/no-ambient-random.test.ts`; Seams).
- `browser` / `wiring.spec.ts` (Chromium): `crossOriginIsolated` and `SharedArrayBuffer` on main and in the worker; `Atomics.wait` works in the worker; wasm `Content-Type` and hashed `/assets/*.wasm` URL from `virtual:engine/wasm`; `buildHash` equals `game.json`; ABI version matches; an `engine.log` line arrives through `onLog`; a deliberate panic (`panicAtTick`) surfaces as `EngineTrap` with the Rust message and the harness reports it in `errors()`.
- `browser` / `stepping.spec.ts` (Chromium): 1,000 `stepTick()` in one task give the same hash as the scenario's checkpoint; `untilQuiescent()` resolves only after the last ack (assert `REQ === ACK` and `STATE === idle` at resolution); `park()` then `hash()` then `resume()` round-trips; `memGrows()` is 0.
- `browser` / `determinism.spec.ts` `@engines`: every checkpoint in `golden/golden.json` (read in Node, not trusted from the page) equals the page's in Chromium, WebKit and Firefox; on mismatch the message names the first divergent checkpoint (0020 §5).

## Exit criteria
- [x] `pnpm test browser` passes and prints one line; `pnpm test` runs its four registered suites (`rust`, `unit`, `wasm`, `browser`) in parallel. (Orchestrator correction: the brief said five; the fifth row of 0020 §3, `netcode`, is registered by M27.)
- [x] `pnpm test browser -t determinism` shows the golden reproduced in three engines (project names in the JSON report).
- [x] Editing one checkpoint in `golden/golden.json` by hand makes native, `wasm` and all three browser projects fail naming that checkpoint (check, then revert).
- [x] Adding `Date.now()` to `src/loader.ts` makes `pnpm lint` fail, and adding `Math.random()` there makes `pnpm test unit -t no_ambient_random` fail naming the file (check, then revert).
- [x] `grep -r "test/" packages/engine/dist/{loader,clock,vite,server-node}.js` finds no import of test code.
- [x] `pnpm device:serve` serves `determinism.html` showing PASS in a desktop browser.
- [x] `.claude/skills/run-tests/SKILL.md` exists and its commands were each run once in this session.
- [x] `browser` suite time recorded under Deviations.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm test browser` · `pnpm test browser -t determinism` · `pnpm test unit -t "manual clock"` · `pnpm lint` · `pnpm device:serve`

## Budgets
- Test suite row (`PRE-PLAN.md` §7; 0020 §3): `browser` suite line; record cold (first `vite build`) and warm numbers. Three browser launches run in parallel; if the suite's share exceeds a third of its row already, say so under Deviations so M04 knows its headroom.
- Dev loop row: unchanged; note the added `vite build` milliseconds.

## Context artifacts
- `.claude/skills/run-tests/SKILL.md`: `pnpm test [suite] [-t pattern]`, suite names, reading `test-results/`, `pnpm golden`, running one Playwright project, `ENGINE_TEST_PORT`, browser install, when to use the `playwright-cli` skill for a look at a page (0020 §1), `pnpm device:serve`.
- `packages/engine/CLAUDE.md`: the ambient-time and ambient-randomness rules in one line; how to add a browser spec and tag it.

## Manual device checks
[device-checks.md, M03: Determinism page](device-checks.md#m03-determinism-page). Not gating.
This milestone builds `determinism.html` and `pnpm device:serve [--tunnel]` (procedure: Planning decisions above); the first scheduled run is in M11's sitting.

## Deviations

No split: steps 1–7 fitted one session. No decision changed and no seam under **Provides** was
renamed, so no ADR. Exact shapes, findings and small corrections:

- **`biome.json`'s `noRestrictedGlobals` override excludes `src/vite.ts` and `src/build-game.ts`**,
  not only `src/clock.ts` and `src/test/**` as the Seams text says ("the only file in
  `packages/engine/src/` outside `src/test/`"). Both are build-time Vite/cargo tooling (0017 §5),
  outside what 0020 §8 means by "main thread, workers and server"; `vite.ts` already used
  `setTimeout` for its rebuild debounce and `build-game.ts` already used `performance.now()` for
  `cargoMs` before this milestone. Denied globals: `Date`, `performance`, `setTimeout`,
  `setInterval`, `requestAnimationFrame`, each with a reason citing 0020 §8.
- **`step-block.ts` field layout** (5 `Int32Array` slots, not the six named in Seams —
  `CONTROL`/`ERR` collapsed into one `Op` field and a `Status`/message never needed a slot of its
  own): `Req`, `Ack`, `State` (`WorkerState`: `Idle 0`, `Armed 1`, `Busy 2`), `Yield`, `Op`
  (`StepOp`: `Tick 1`, `Frame 2`). `park()` wakes the worker by `Atomics.notify`-ing `Req` **without
  changing its value**: `Atomics.wait` returns `"ok"` on any `notify` regardless of whether the
  waited word changed, so this keeps `Req === Ack` true across a park (verified: this is exactly
  what `stepping.spec.ts`'s `untilQuiescent` test relies on). `resume()`/`park()` are `postMessage`
  round trips (`'resume'` → `'armed'`, then a `Yield`-flag wake → `'parked'`); `stepTick`/`stepFrame`
  are the SAB path (`wake` + a busy-spin `awaitAck`, capped at the spike's `2e9`-iteration guard
  before throwing "did not ack a step (resume() first?)").
- **`hash`/`admit`/`memoryBytes`/`memGrows` require the worker parked**, checked with a clear throw
  (`harness: worker '<name>' is armed; call park() first (<what>)`) rather than silently queueing a
  `postMessage` a blocked worker cannot receive (would hang forever). This is why the seam text pairs
  `park()`/`hash()`/`resume()` as an explicit round trip rather than having `hash()` park
  automatically: automatic parking would silently change every other armed worker's state too on a
  multi-worker harness.
- **`untilQuiescent()` is implemented as parking every worker** (same code path as `park()`). "Every
  worker has acknowledged every request and is parked" (Seams) reduces to this once `stepTick`/
  `stepFrame` are synchronous and already ack before returning: nothing but the park itself is ever
  outstanding when it is called. `stepping.spec.ts`'s quiescence test therefore proves `Req === Ack`
  and `STATE === idle` indirectly, through the public API: `hash()` only succeeds once truly parked
  (a worker blocked in `Atomics.wait` cannot receive the `postMessage`), so a following `hash()` call
  succeeding is the proof, rather than reading the internal `Int32Array` from the test (not exposed
  outside `src/test/`, and Seams marks the whole step block "Internal, replaced later").
- **`determinism.spec.ts` does not go through `createHarness`.** Reproducing the golden needs
  `sim_admit` on every 7th tick across all 10,000 ticks; the harness's `admit` is explicitly
  setup-rate/park-required (Seams), so driving it per-admit would mean ~1,400 park/resume round
  trips per engine. Instead `tests/browser/pages/src/determinism-worker.ts` is a bare module worker
  (0020 §5's own phrase, "a bare page with the .wasm in a worker") that runs
  `tests/support/scenario.ts`'s `runHashScenario` — the same driver the native, Node and Bun legs use
  — in one `postMessage` round trip. `harness.ts`/`harness-worker.ts` stay generic; this fixture-
  specific driving logic has no reason to live under `src/test/`.
- **`page.goto`'s `load` event does not reliably wait out a page's top-level `await` chain** (fetch +
  `compileStreaming` + `instantiate`), measured under three parallel Playwright workers: the first
  tests to start sometimes read `window.__wiring`/`window.__harness` before the module script's last
  line ran (`window.__createHarness` was still `undefined`, so `?.()` silently no-op'd and a
  `page.waitForEvent('worker')` then timed out at 30 s; a fetched header read `undefined`). Fix, not
  in the brief's Files list: every page ends with `window.__pageReady = true`, and
  `tests/browser/support/page.ts`'s `openPage` waits for it before returning. Confirmed by three
  consecutive full three-engine runs with zero flakes after the fix (zero before, on the same
  machine, under load).
- **`wiring.ts` fetches the wasm bytes once, not twice.** `res.headers` does not consume the
  `Response` body, so the same `res` feeds `WebAssembly.compileStreaming`; the original draft (one
  fetch for headers, a second for `compileStreaming`) roughly doubled network load under three
  parallel browsers and was a contributing factor to the flake above.
- **Every page has `<link rel="icon" href="data:,">`.** Without it, Chromium's automatic
  `/favicon.ico` request 404s, which `openPage`'s console-error guard (correctly) fails the test on;
  not in the brief's Files list, but needed for `support/page.ts`'s console-error contract to be
  usable at all.
- **`wiring.ts` gets its `onLog` line for free.** `crates/engine/src/abi/mod.rs`'s `try_init` already
  calls `panic::log(LogLevel::Debug, "engine_init ok")` on every successful `engine_init` (added in
  M02, not seen as a `Tests added` item there); dev-profile builds keep `Debug` (release drops below
  `Warn`, 0014 §3). No fixture change was needed for "an engine.log line arrives through `onLog`":
  `wiring.ts` instantiates the fixture directly on the main thread (no worker, no isolation needed
  for this one check) purely to observe it.
- **`playwright` adapter**: `PLAYWRIGHT_JSON_OUTPUT_FILE` (not `_NAME`; found by reading
  `playwright`'s own `resolveOutputFile`, since 1.63.0's docs describe the config option, not the
  env var name) resolves relative to `cwd`, matching the vitest adapter's `outputFile` path
  convention (`test-results/browser/report.json`). Running the raw `playwright test` CLI without
  this env var instead writes to `packages/engine/test-results/browser/report.json` (the config's
  own `outputFile`, resolved relative to the config file's directory) — a different path, noted in
  the `run-tests` skill so it isn't confused with the runner's own report.
- **`scripts/test.mjs`, not just `scripts/suites.mjs`/`scripts/lib/{adapters,report}.mjs`, changed**
  (outside the brief's Files list): the `warnings` extension to the output contract (Planning
  decisions "Output contract") needed `runSuite`/`main` to aggregate and print a line per warning
  (`formatWarning`, new in `report.mjs`) under each suite's line; nothing else there changed.
- **`playwright-browsers` TOOLS row probes via `scripts/lib/playwright-browsers-probe.mjs`**, not a
  single regex against `playwright install --version`: `playwright install --dry-run` always
  describes the full install plan whether or not the browsers are already present (measured — ran it
  against an already-populated cache and got the same four-browser listing as a first run), so it
  cannot say what is missing. `playwright install --list` prints one block per Playwright version
  found in the shared `~/Library/Caches/ms-playwright` (or platform equivalent) cache; the probe
  finds the block for the pinned version and checks it names all three engines, printing the pin
  string on success (so it composes with `setup-tools.mjs`'s existing `match`-a-version mechanism)
  and nothing otherwise.
- **`pnpm device:serve`'s port is 4173, fixed**, distinct from `ENGINE_TEST_PORT` (4517 default): it
  sets `ENGINE_TEST_PORT=4173` for the `vite preview` child so the existing app config's `port`/
  `strictPort` (0017/M02b) serves it without a second config. `--host 127.0.0.1` is passed explicitly
  to both this script's `vite preview` and `playwright.config.ts`'s `webServer` command: Vite's
  default preview host resolves to `localhost`, which on this machine binds `::1` only and refuses a
  `127.0.0.1` connection (measured; `baseURL`/the device URL are both literal `127.0.0.1`).
- **Measurements** (Tyler's Mac, warm caches unless noted):
  - `browser` suite: **13 tests, ~4.2–4.4 s of its 25 s budget (~17 %)** — well under a third of the
    row, so M04 has the headroom 0020 §3's demotion rule assumes. 13 = chromium's 11 (6 `wiring` + 4
    `stepping` + 1 `determinism`, all untagged or not, chromium runs everything) plus the
    `@engines`-tagged `determinism` test again in `webkit` and `firefox`. Three consecutive full
    `pnpm test browser` runs showed no flakiness after the `__pageReady` fix.
  - `pages` build step in isolation (`vite exec vite build --config .../vite.config.ts`, the same
    command `scripts/suites.mjs` runs): **~150–180 ms internal Vite time, ~470–490 ms wall** (`pnpm
    exec` + Node startup accounts for most of the gap), cold (no `dist/`) and warm alike — added to
    every `pnpm test` build phase, so about 1.6 % of the 30 s Dev-loop budget (0020 §3).
  - `pnpm test browser` end to end (`rm -rf test-results packages/engine/tests/browser/pages/dist`,
    then two consecutive runs): cold **6.7 s wall**, warm **5.9 s wall** (both include the `tsc`,
    `fixtures`, `cargo-tests --no-run` and `pages` build steps, not `pages` in isolation, plus the
    `browser` suite's own ~4.2 s); the runner's own `browser pass 13 tests` line was identical
    (4.2 s) in both.
  - Dev-profile `game.wasm` served to the pages app: unchanged from M02b (3.7 MB, DWARF; never
    measured against the release-only size budget, 0015 §6). One consequence, not a regression: two
    fetches of it (the pre-fix `wiring.ts`) under three parallel Playwright workers was itself a
    contributing factor to the `__pageReady` flake above, at this size; noted for M04, which will
    also fetch it.
- **Exit criterion wording vs. what exists: "`pnpm test` runs five suites in parallel."** After this
  milestone `pnpm test` runs **four**: `rust`, `unit`, `wasm`, `browser` (`browser pass 13 tests
  4.2s/25s`, alongside the other three). The 0020 §3 table names five rows (`rust`, `unit`, `wasm`,
  `netcode`, `browser`), and `browser` is the fifth *named* suite in that table, but `netcode` is not
  registered until its own milestone — nothing in this brief's Scope builds it. Read literally
  against the actual suite count, this criterion is **not met**; read as "the fifth row of 0020 §3's
  table now runs," it is. Flagged rather than silently reworded (the checkbox itself is not mine to
  touch); no code changed to chase the literal count.
- **Exit criterion 5 (`grep -r "test/" packages/engine/dist/{loader,clock,vite,server-node}.js`
  finds no import of test code) by hand:** the grep is not empty — `dist/clock.js`'s own doc comment
  names `src/test/manual-clock.ts` and `src/test/` descriptively (carried over from the `.ts` source
  comment). Confirmed by hand that neither match is an `import`/`require` line
  (`grep -n "^import\|require(" ... | grep -i test` on the same four files: no output). The claim the
  criterion is checking — no import of test code from these four production entrypoints — holds;
  the literal command's output is not empty.
- **Exit criteria 3 and 4, done by hand, reverted, nothing committed except the fix each surfaced:**
  - Checkpoint 0 of `fixtures/hash/golden/golden.json` set to `"0000000000000000"`: `pnpm test rust
    -t scenario_matches_golden` failed with `assertion `left == right` failed: checkpoint 0 differs
    from .../golden.json` (`left: "29e92bc3f1e72c2c"`, `right: "0000000000000000"`); `pnpm test wasm
    -t determinism` failed both `determinism: node matches golden` and the Bun leg, the latter
    printing `checkpoint 0: got 29e92bc3f1e72c2c, golden has 0000000000000000`; `pnpm test browser -t
    determinism` failed in `[chromium]`, `[webkit]` and `[firefox]`, each with `checkpoint 0: got
    29e92bc3f1e72c2c, golden has 0000000000000000`. Reverted; `git diff --exit-code` on the file
    confirmed clean.
  - `Date.now()` added to `loader.ts`: `pnpm lint` failed on `biome`, `lint/style/noRestrictedGlobals`,
    "Do not use the global variable Date" at the new line, with the reason string from `biome.json`.
    `Math.random()` added instead: `pnpm test unit -t no_ambient_random` failed — but only after a
    real fix (see the standalone commit above this Deviations entry): the test originally used
    `expect(offenders).toEqual([])`, whose file list lives only in Vitest's separately-rendered diff,
    which the JSON-reporter-based runner (0020 §2) never captures. Changed to a plain `throw` when
    `offenders` is non-empty, kept (not part of the revert): `pnpm test unit -t no_ambient_random`
    now fails with `Error: ambient randomness outside src/test/:\nloader.ts: matches
    /\bMath\.random\b/`. `loader.ts` reverted; `git diff --exit-code` confirmed clean.
- **Context artifacts written:** `.claude/skills/run-tests/SKILL.md`; `packages/engine/CLAUDE.md`
  (ambient-time/randomness one-liner, "Adding a browser spec" section). Every command in the skill
  was run at least once in this session, **except `pnpm golden`**: the delegation prompt explicitly
  forbade running it against the existing `hash` fixture this milestone, so its section documents
  the command without executing it.
- **`pnpm setup:tools`** installed nothing new for Bun/nextest (already pinned from M01/M02); the
  Playwright browsers (chromium 153, webkit 26.6, firefox 155, matching the pin's bundled versions)
  were already present in the shared cache from other projects on this machine at the exact pin
  version, so `pnpm exec playwright install chromium webkit firefox` completed with no download —
  untested here: a genuinely cold install's download time.
- **Tunnel path: implemented, not run.** `cloudflared` is not on `PATH` on this machine;
  `pnpm device:serve --tunnel` printed the one-line install hint and exited 1, which is the whole of
  what was verified for that branch. `pnpm device:serve` (no `--tunnel`) was verified for real:
  built the fixture app, served `determinism.html` on `127.0.0.1:4173`, and a `playwright-cli` read
  of `#result` showed `PASS | crossOriginIsolated: true | userAgent: ...HeadlessChrome/153...`.
- **Orchestrator gate (2026-09-19):** `pnpm gate ddf879b` clean (44 files, +1860/−14, no goldens or markers changed); `pnpm test` green (`rust` 16, `unit` 51, `wasm` 23, `browser pass 13 tests 4.4s/25s`) and `pnpm lint` green, run by the orchestrator. `pnpm golden hash` re-run by the orchestrator: no diff. `dist/{loader,clock,vite,server-node}.js` contain no `import`/`export`/`require` of `test/` (the raw `grep "test/"` of the criterion also matches two doc-comment lines in `clock.js`; accepted). Accepted test substitutions, both technical decisions of the orchestrator: (1) `stepping: 1,000 stepTick()…` compares with a Node-side reference of 1,000 plain `sim_tick` calls on the same `.wasm` and config instead of a scenario checkpoint, because the scenario admits input between checkpoints and `stepTick` never admits; the tie to the golden is `determinism.spec.ts`. (2) `untilQuiescent` is asserted through the public API (a `hash()` that only a parked worker can answer) instead of reading `REQ`/`ACK`/`STATE`, because `stepTick` is synchronous (it returns after every ack) and the step block is internal; M06b re-asserts quiescence on the production control block. Exit criterion 1 reworded from five suites to four (`netcode` is M27). `window.__pageReady` added to the page contract in `packages/engine/CLAUDE.md`. Tunnel path of `pnpm device:serve --tunnel`: implemented, not run (Tyler-run, device checklist).
