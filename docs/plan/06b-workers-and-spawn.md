# M06b: Worker kinds and the `createClient` spawn path

Status: not started · After: 06 · Tyler-dependent: no

Split out of M06 during planning (M06 alone would have been about 2,100 lines across two subsystems). M08b and M13 depend on this brief, not on M06 alone.

## Goal
`createClient` checks isolation, compiles the module once, creates the `SabSet`, spawns the worker set for the chosen topology, and posts each worker the `Module`, its SABs and its config. `engine/worker` `run()` hosts all four kinds in one script; WASM kinds instantiate, call `engine_init(role)`, reserve their arena, build views once and block in `Atomics.wait`. The `yield` protocol returns a blocked worker to its event loop for tests, CDP and shutdown. A zero-GC test covers the idle topology and the SAB → WASM → SAB copy in both directions.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§1, §2 "Wake-ups", §3, §5)
3. `docs/decisions/0014-js-wasm-boundary.md` (§4 regions and copy rules, §5, §6)
4. `docs/decisions/0017-packaging-and-build.md` (§2 the `worker.js` constraint, §3 patterns A and B, §4 "Browser")

Mine from spikes: `spikes/zero-gc-webgpu/public/worker.js` (`armedLoop`: arm, lockstep ack, disarm so CDP can reach the worker: the template for `yield`); `spikes/zero-gc-webgpu/public/main.js` (`Atomics.store` + `notify` + ack wait); `spikes/vite-lib-worker-wasm/` (posted `Module`, pattern A URL form). Rules that apply: `.claude/rules/hot-paths.md`.

## Scope
- `client.ts`: `createClient(options)` spawn path and `checkSupport()` minimum.
- `worker.ts` `run()`; `worker/shell.ts` (setup handshake, blocking loop, yield/park/resume, fatal reporting); `worker/{client,sim,gen,net}.ts` kind bodies, each a stub that later milestones fill: client (copy camera block into its region; call `frame(t_ms)` when `CB_FRAME_REQ` advanced; store `W_ACK`), sim (waits without timeout until M13), gen (waits until M08b), net (event-driven idle shell, no WASM; M29).
- Rust: `#[repr(C)] CameraBlock` matching M06's offsets; `RegionId::Camera` sized here (M02 reserved the id and guessed M11); the client-role `frame(t_ms: f64) -> status` export, added by M02's ABI rule (extern + defaulted `Instance` method + `ABI_EXPORTS` row + `ABI_VERSION` bump).
- `engine/test` additions: `parkWorkers`, `resumeWorkers`, `untilQuiescent`, `stepFrame(client, dtMs)`, `asHarness(client)`, `setCamera`, the `echo` and `gcHook` test flags.
- Readable start-up errors (0015 §3).

## Non-scope
Any ring traffic with meaning (M08b, M09, M13, M15b, M16). The rAF frame loop (M09). Sim host and tick pacing (M13). The WebSocket (M29). Pattern B documentation, final `checkSupport` and the exports-map test (M35). Panic recovery by re-instantiation (M24): here a trap marks the worker dead and rejects `client.ready` or fires the fatal path.

## Files, packages and crates touched
`packages/engine` (`src/client.ts`, `src/worker.ts`, `src/worker/*`, `src/support.ts`, `src/test/*`, `src/abi.ts`), `packages/engine/crates/engine` (`abi/registry.rs`, `client/camera.rs`), pages `topology.html` and `echo.html` in the fixture app (`tests/browser/pages/`) over M02's `fx-hash` fixture.

## Seams
**Provides**
- ```ts
  interface ClientOptions {
    canvas: HTMLCanvasElement
    wasm: { url: string; buildHash: string }                       // virtual:engine/wasm, 0017 §4
    host: { kind: 'local'; world: WorldConfig } | { kind: 'remote'; url: string; joinKey?: string }
    createWorker?: () => Worker                                    // pattern B
    arenas?: { sim?: number; client?: number; gen?: number }       // bytes; defaults 0015 §5
    genWorkers?: number                                            // default per 0008
  }
  interface Client { readonly ready: Promise<void>; destroy(): void }   // later milestones add members
  class EngineStartError extends Error { code: 'not-isolated' | 'worker-blocked' | 'compile-failed' | 'abi-mismatch' | 'arena-config' | 'worker-fatal' }
  checkSupport(): Promise<{ ok: boolean; failures: { code: 'not-isolated' | 'no-sab' | 'no-wasm' | 'no-module-worker' | 'no-webgpu' | 'no-adapter'; message: string }[] }>
  ```
  `host` closes the PRE-PLAN §10 gap "which option selects single-player": `local` spawns the sim worker and forwards `world` (0009), `remote` spawns the net worker. M13 consumes `local`; M29 makes `remote` (and its `joinKey`) real.
- Setup message (the only steady use of `postMessage` besides fatal and resume): `{ type: 'setup', kind: 'client' | 'sim' | 'gen' | 'net', index, module?: WebAssembly.Module, wasmUrl?: string, sabs: SabSet, config, test?: TestFlags }`. Replies: `{ type: 'ready' }`, `{ type: 'fatal', message }`. Main → worker afterwards: `{ type: 'resume' }`, `{ type: 'stop' }`.
- Worker shell API for later kinds: `runBlockingLoop(shell, body: (wokenBy: number) => void, timeoutMs: () => number)`, `shell.runAsync(fn: () => Promise<void>)` (leave the loop, await, re-enter: for Promise-only APIs such as opening an OPFS file, M23), `shell.fatal(message)`.
- Rust `engine::client::CameraBlock`; `RegionId::Camera` (80 bytes); ABI export `frame`.
- `engine/test` (the production-topology counterparts M03 names): `parkWorkers(client): Promise<void>`, `resumeWorkers(client): Promise<void>`, `untilQuiescent(client): Promise<void>` (`W_ACK == CB_FRAME_REQ` and every ring `PUSHED == POPPED`), `stepFrame(client, dtMs)`, `asHarness(client): Harness` (so M04's `installGcPage` and `zeroGcSuite` run unchanged on a real client), `setCamera(client, { x, y, tilesAcross })`, `TestFlags { echo?: boolean; postModule?: boolean; gcHook?: boolean }`. `createClient` takes `{ clock, scheduler }` (M03) through a test-only options field.

**Consumes** M06: everything under *Provides*. M02: `instantiate(module, role, config, hooks)`, `EngineInstance` (`call0/1/2`, `region(id)`, `memoryBytes()`, `memGrows()`, `onViewsRebuilt`), `InstanceConfig`, `AbiMismatchError`/`EngineInitError`/`EngineTrap`, the ABI rule, fixture `fx-hash`. M02b: `virtual:engine/wasm`, `EngineWasm`, the fixture app. M03: `Clock`/`Scheduler`, `Harness` (its API is the model for the helpers above; its test-only `step-block.ts` is not used by production workers), `openPage`, `@engines`. M04: `installGcPage`, `zeroGcSuite({ pageId, path })`, `budgets.json` `gc.pages`, `NegativeControl`; M04 requires its control hook in the production worker loop behind a setup-message flag: that is `TestFlags.gcHook`, and the control is selected by a message while the worker is parked.

## Planning decisions
- **`yield` protocol.** To park worker `i`: store `W_YIELD = 1`, then `wake(i)`. The loop checks `W_YIELD` first on every wake; when set it stores `W_PARKED = 1` and returns to the event loop, where `onmessage`, CDP and promises run. To resume: store `W_YIELD = 0`, post `{ type: 'resume' }`; the handler stores `W_PARKED = 0` and re-enters the loop. `parkWorkers` awaits `W_PARKED` by polling on a macrotask (tests only). A worker parks itself the same way through `shell.runAsync`. `destroy()` = `CB_LIFECYCLE = 2`, park all, `terminate()`. Rationale: a blocked worker receives no events (0015 §2), a posted "arm" takes effect only when the sender's task ends (spike caveat), and a flag plus one lifecycle message costs nothing in steady state.
- **Stepped frames in tests.** `stepFrame(dt)` advances the injected clock, writes the camera block, increments `CB_FRAME_REQ`, wakes the client worker and spins on `W_ACK` (the spike's lockstep). During a measured GC window workers stay in their loops; the harness parks them only before and after the window to attach CDP and read results.
- **Worker frame clock** (0018 deferred it to 0015). The client worker has no clock of its own: `frame(t_ms)` receives `frame_time_ms` from the camera block, and is called only when `CB_FRAME_REQ` differs from `W_ACK`. A wake from a ring producer without a new frame request drains rings and goes back to waiting. Frames never queue: a late worker serves the newest request once. This keeps the client instance free of ambient time and makes `stepFrame` exact.
- **Posted `Module` first, URL as fallback.** `module` is posted by default; if `wasmUrl` is present instead, the worker calls `instantiateStreaming` (0017 §4). `TestFlags.postModule = false` exercises it in one test so the fallback is real if the M11 device check finds that iOS Safari refuses a posted `Module`.
- **`createClient` is synchronous and returns `client.ready`.** PRE-PLAN §4 shows a synchronous call; spawn is asynchronous. Members that need workers before `ready` resolves are each later milestone's concern.
- **Arena config check on main.** Reject with `arena-config` when the arenas for the chosen topology sum past the tab target of 0015 §5 minus the fixed SAB and GPU shares; the numbers are read from 0015, the rule lives in `client.ts`.
- **`checkSupport` minimum.** Synchronous facts (`crossOriginIsolated`, `SharedArrayBuffer`, `WebAssembly`, `navigator.gpu` present) plus a module-worker probe; `no-adapter` is filled in by M09, the final list and the capability-screen contract by M35.
- **Worker script layout.** Kind bodies live in `src/worker/*.ts` and are imported relatively by `worker.ts`; 0017 §2's "self-contained" is read as "no bare imports, no dynamic `import()`". If M02's build already bundles `worker.js` into one file, follow M02.

## Order of work
1. Setup handshake and blocking loop with a no-op body; `ready`, fatal path, pre-ready `error` → `worker-blocked`. 2. WASM kinds: instantiate, `engine_init`, arena reservation, `W_MEM_PAGES`. 3. `yield`/park/resume and `destroy`. 4. Camera block copy and the `frame` call; `stepFrame` lockstep. 5. `echo` flag and the GC test. 6. `checkSupport`, arena check, URL fallback.

## Tests added
- Browser, Chromium: `workers.spawn_local` (client + sim + gen ready; `W_MEM_PAGES` equals each configured arena), `workers.spawn_remote` (client + net + gen), `workers.park_resume` (CDP `Runtime.evaluate` reaches a parked worker and not a blocked one), `workers.camera_block_reaches_wasm` (a test export returns the f64 centre bit-exactly), `workers.destroy_terminates`, `workers.url_fallback`, `start.not_isolated_error` (page without headers), `start.worker_blocked_error` (COEP missing on the worker script only), `start.arena_config_rejected`.
- `workers.spawn_local` is tagged `@engines` (WebKit and Firefox too).
- Zero-GC (`zeroGcSuite`, new `gc.pages` entries with isolates `main`, `client`, `sim`, `gen0`): page `topology` (600 stepped frames: camera-block write, wake, `frame`, ack) and page `echo` (10 KiB per frame main → `actionRing` → client receive region → transmit region → `uiRing` → main through preallocated view pairs), which closes 0014's "WASM → SAB unmeasured" and 0015's "only worker → main measured". The generated negative controls trip on each production isolate by name.
- `unit` suite: `support.report_shape`, `arena.sum_rule`, `main.no_wasm_instantiate` (source scan, 0015 §1 and §2: the static relative-import closure of `src/client.ts`, which never includes `worker.ts` or `src/worker/**` because those are reached only through `new Worker(new URL(…))`, contains no `WebAssembly.instantiate`, `instantiateStreaming` or `new WebAssembly.Instance`, imports neither `loader.ts` nor `worker/**`, and never names `waitForWake` or `Atomics.wait`; `WebAssembly.compileStreaming` is the one allowed use).

## Exit criteria
- [ ] All tests above pass by name; pages `topology` and `echo` within the budgets below with zero GC events and unchanged `memory.buffer.byteLength` on every instance.
- [ ] `grep -n postMessage packages/engine/src` shows only setup, ready, fatal, resume and stop.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test browser -t workers` · `pnpm test browser -t start.` · `pnpm test browser -t topology` · `pnpm test browser -t echo` · `pnpm test unit -t arena` · `pnpm test` · `pnpm lint`.

## Budgets
- Allocation per isolate (0016 §1): main and each worker at their budgets in `budgets.json`; measured by pages `topology` and `echo`.
- Memory per instance (0015 §5): arenas reserved by one `memory.grow` at init; measured by `workers.spawn_local` (`W_MEM_PAGES`) and `engine_mem_grows() == 0`.
- Download, engine JS (0015 §6): not asserted until M35; keep `client.js` free of worker-only code.

## Context artifacts
`packages/engine/CLAUDE.md`: lines for `src/worker/` (one script, kind in the setup message, never `postMessage` after setup) and for `parkWorkers` before any CDP call to a worker. Update the `gc-test` skill (M04) with the park/resume step if its procedure changes.

## Manual device checks
None here; the posted-`Module` and arena checks on a real iPhone are M11 items in `device-checks.md`.

## Deviations
(filled in during Phase 3)

### Steps 1-4 and 6 (partial), not recorded by that implementer -- verified against the code here

- **`frame(t_ms) -> status`** (`crates/engine/src/abi/mod.rs::frame`): camera and `Result` access is
  split through a raw pointer (`CameraBlock::ptr(&rt.layout)`, `client/camera.rs`) dereferenced
  after `rt.layout.bytes_mut(RegionId::Result)` is taken, to avoid a borrow conflict between an
  immutable read of `Camera` and a `&mut` of `Result` on the same `RegionLayout`. `fx-hash`'s own
  `frame()` writes `centre.x, centre.y, t_ms` (24 bytes LE) into `Result`, proven bit-exact against
  `camera/block.ts`'s layout by `workers.camera_block_reaches_wasm`.
- **`try_init` reserves `Camera`** (80 B) for every Client-role instance regardless of the game
  (`abi/mod.rs::try_init`); `tests/wasm/loader.test.ts`'s `RegionId.Camera` assertion is `len` is 80
  (not "region is null").
- **A kind's `setup()` returns `{ body, timeoutMs }`** instead of calling `runBlockingLoop` itself
  (`worker.ts::run()` posts `ready` first, then starts the loop -- otherwise the `setup()` promise
  never settles and `ready` never posts, since `runBlockingLoop` blocks synchronously).
- **Test hooks in production files**, now gated (this session, orchestrator decision 1; see below):
  `clientTestHandle` (`client.ts`, unconditional -- it is a `WeakMap` lookup, not a global), `self.
  __engineWorkerKind`/`self.__engineIsolateName` (`worker.ts`), `self.__engineInstance`
  (`worker/client.ts`).
- **Measured**: fixed per-role WASM footprint before arena reservation, 1,310,720 B (20 pages) for
  `sim`/`gen`/pre-echo `client` on the dev-profile `fx-hash` module (`workers.spec.ts`'s own
  comment). `arenaBudgetBytes()` = 256 MiB (0015 §5 tab target) − `sabBytesTotal()` (worst case, two
  gen workers) − 20 MiB GPU share.
- **A wake during `park()` is not replayed on `resume()`**: flagged by that implementer for M08b/M13
  (not independently re-verified here; carried forward as a flag, not a re-derived finding).
- **`abi-mismatch` vs `worker-fatal`** is chosen by string-matching the fatal message
  (`m.message.includes('ABI mismatch')`, `client.ts::setupWorker`).

### Steps 5-6 (this session)

- **Debug-global gate is the setup message's `test` field, not `test.flags`.** `SetupMessage.test`
  (`worker/protocol.ts`) is `TestFlags` -- it is populated from `options.test?.flags`, not the whole
  `ClientOptions.test` (which also carries `game`/`clock`/`scheduler`). Gating on `message.test !==
  undefined` (rather than requiring a specific flag) means: a production `createClient()` call
  (no `options.test` at all) gets none of the three globals; `topology.ts`'s own `__createClient`
  now defaults `flags` to `{}` (never omitted) so every worker it spawns still carries `test` and
  every existing `workers.spec.ts` assertion that reads `__engineWorkerKind`/`__engineInstance`
  keeps working. `self.__engineIsolateName` (new) is `'client' | 'sim' | 'gen0' | 'gen1' | 'net'`
  (`worker/protocol.ts::isolateName`, shared by `worker.ts` and `asHarness`).
- **`CB_TEST_CONTROL`**: global control word 4 (`sab/control.ts`; words 5-7 still reserved).
  Encoding: `0` = none, else `((workerIndex + 1) << 8) | kind` (`kind`: 1 = object, 2 = burst, same
  numbering as `src/test/step-block.ts`'s `StepControl`). `worker/gc-hook.ts::applyGcHook(control,
  index)` is the production-side reader: a duplicate of `src/test/controls.ts`'s two allocation
  shapes (production code cannot import `src/test/**`), read only when a kind's own `setup()` closed
  over `message.test?.gcHook === true`; the word itself is never loaded otherwise.
- **`sim`/`gen` kind bodies are no longer bare no-ops.** Each now stores `W_ACK = wokenBy` on every
  real wake (a single `Atomics.store`, unconditional, not gated by `gcHook`) so a test driver can
  lockstep a synthetic wake with them the same way `stepFrame` already locksteps the client role,
  since neither has ring traffic of its own to synchronise on before M13/M08b. This is a small
  addition beyond the brief's "no-op" wording for these stub bodies; flag for M13/M08b when real
  work replaces `body()` -- keep the `W_ACK` store (or an equivalent) if anything still needs to
  lockstep with these roles from outside.
- **`asHarness(client): Harness`** (`test/client.ts`). Mapping: `park`/`resume` → `parkWorkers`/
  `resumeWorkers`; `stepFrame` → this file's own `stepFrame`; `stepTick` → wakes every spawned
  `sim`/`gen` worker and spins on their own `W_ACK` (preallocated scratch array, built once, so the
  hot loop stays allocation-free on `main`); `setWorkerControl` → `CB_TEST_CONTROL`; `memoryBytes`/
  `memGrows` → `W_MEM_PAGES`/`W_MEM_GROWS` read directly (no message). `markIsolates` is a no-op (see
  the CDP-marking deviation below). `hash`/`admit`/`messageTick` reject: no production counterpart
  exists yet. `workerGcExposed()` returns `true` for every isolate: the `gc` Playwright project
  always launches Chromium with `--js-flags=--expose-gc` process-wide, so it is true in every real
  worker too, but there is no message to ask a production worker to confirm this itself. `errors()`
  is always `[]`: a running `Client` has no ongoing fault-reporting channel past `ready`/`fatal`
  (`setupWorker`'s `onmessage`/`onerror` stop listening once the spawn promise settles) -- a gap for
  whichever later milestone adds one.
- **New pages are `gc-topology.html`/`gc-echo.html`, not `topology.html`/`echo.html`.** `topology.html`
  already serves `workers.spec.ts`/`start.spec.ts`'s imperative debug API (a client created only on
  an explicit `__createClient()` call, so those specs can count exactly the workers *they* spawn); a
  zero-GC page must instead auto-create its client at load (`window.__gc.ready` has to resolve
  without any prior call), which would spawn extra, uncounted workers on the same page and break
  those specs' `expect.poll(() => created.length)` assertions. `budgets.json`'s `gc.pages` keys stay
  `topology`/`echo` as named (`zeroGcSuite`'s `pageId` is independent of the HTML file name).
- **`echo`'s round trip does not use the frame req/ack lockstep.** `worker/client.ts`'s `body()`
  stores `W_ACK` only when `CB_FRAME_REQ` changed, *before* the unconditional ring-echo block runs
  every call; two wakes issued back-to-back (a ring push, then a `stepFrame`) are not guaranteed not
  to coalesce into one `body()` invocation, in which case the statement order inside that one call
  (ack stored, *then* the ring drained) would let `main` observe the ack before the echoed message is
  actually pushed to `uiRing`. `gc-echo.ts` instead spins directly on `RingConsumer.peekLen() >= 0`:
  safe because `RingProducer.tryPush` writes the payload bytes before its atomic `HEAD` store, so
  observing `HEAD` advance (via `Atomics.load`) already guarantees the payload is visible, with no
  dependency on `body()`'s internal statement order.
- **`fixtures/hash`'s `Rx`/`Tx` are sized per role**, not per test flag: `CLIENT_RX_TX_BYTES = 10 *
  1024` for `Role::Client` (any Client instance, `echo` flag or not), unchanged 64 B for `Sim`/`Gen`.
  `golden/golden.json` is untouched (Sim-role only path; `pnpm golden` was not run) and `pnpm test
  rust`/`wasm` stayed green. This did grow the Client role's own fixed footprint past the shared
  1,310,720 B figure `workers.spec.ts` assumes uniform across roles by roughly 20 KB before rounding
  to the next 64 KB WASM page -- measured to still land inside the same 20-page bucket (every
  existing `workers.spec.ts` assertion using `FIXED_FOOTPRINT_BYTES` for the client role stayed
  green unmodified), but the page-boundary margin for `client` is now much smaller than for `sim`/
  `gen`; flagged for whoever next grows the Client role's own fixed data.
- **Isolate marks move to CDP for workers, stay `page.evaluate` for `main`** (`gc/instrument.ts`,
  orchestrator decision 3). A production worker cannot call `performance.mark` itself (`.claude/
  rules/hot-paths.md`) and this milestone adds no new `postMessage` type to ask one to, so `measure()`
  now sends each worker session a `Runtime.evaluate` of `self.performance.mark('gc-isolate:' + self.
  __engineIsolateName); undefined` (`returnByValue: true`, and the trailing `undefined`, so the
  `PerformanceMark` `.mark()` returns is never wrapped as a retained remote object) while workers are
  parked, exactly where the old `window.__gc.markIsolates()` call used to run. `main` still marks
  itself through the page's own `page.evaluate(() => performance.mark('gc-isolate:main'))`: routing
  `main` through the same CDP-session approach (a *second* CDP session on top of Playwright's own
  automation session) measurably moved `gc-loop`'s own `main` clean reading from ~45.5 B/frame to
  ~54 B/frame, tripping its existing 54 B budget -- found by running `gc-loop`'s suite after this
  change, not by inspection. `installGcPage`'s own `markIsolates()`/`Harness.markIsolates()` are
  unchanged and still callable; `measure()` just no longer calls them.
- **`zeroGcSuite` takes an optional `controlKinds`** (default every kind, `gc-loop`'s existing
  shape): `topology`/`echo` pass `['object', 'burst']`, skipping the generated `post-message`
  control (no spare `postMessage` type on a production worker to drive a message-round-trip tick,
  and none of the three pages' own kinds have one to test against).
- **`measure()`/`zeroGcSuite` take an optional `warmupFrames`** (default `WARMUP = 120`, `gc-loop`'s
  own tuned figure -- kept as the global default specifically so `gc-loop`'s entry stays untouched).
  `topology`/`echo` pass `warmupFrames: 8000`. Measured: at 120, and even at 3000, the production
  `yield`-protocol shell's deeper call chain (`ControlBlock`, `worker/shell.ts`, `asHarness`'s own
  lockstep) had not reached steady optimized code -- `main` read as high as ~51.8 B/frame (`topology`)
  with one run spiking to 53.86 B/frame (`echo`), and at that noise level the `object` negative
  control (one small object per frame) did not reliably separate from clean. At `warmupFrames: 8000`
  (adds tens of ms, never counted) `main` stabilised at 43.4-43.6 B/frame (`topology`) and 31.1-31.8
  B/frame (`echo`) with no further spikes across 20-run batches, and every generated negative
  control (including `object`) then tripped only its own named isolate.
- **Open issue, escalated: `main`'s clean reading is contention-sensitive under `pnpm test
  browser`'s real parallelism, and no fix found in this session closes it.** All the numbers above
  are from the `gc` Playwright project run alone (`pnpm gc`/`node scripts/gc.mjs`), at low
  contention. Under the actual `pnpm test browser` command (`chromium`/`webkit`/`firefox`/`gc`
  projects sharing one `workers: 3` pool, so up to three browsers' worth of tests run at once),
  `topology`'s `main` repeatably read 83-85 B/frame with no code change at all -- a foreground loop
  of 20 `pnpm test browser` runs on a busy machine failed 4-5 of them, all on a *different* isolate's
  negative control (`main`'s own clean assertion contaminated, never `main`'s own `object`/`burst`
  control failing to trip). Two mitigations were tried: raising `warmupFrames` further (already at
  8000, no further gain) and halving `asHarness.stepTick`'s call frequency in the page's own drive
  (`STEP_TICK_EVERY = 2`, kept: it cannot hurt and gave a small improvement). Widening `main`'s
  budget to the contention ceiling (96, tried and reverted) hid the noise but also stopped `topology
  neg object main` from tripping (measured directly) -- worse than the flakiness, since the `object`
  control's own signal (~12-20 B/frame) is smaller than the clean/contended baseline's own swing
  (~31-85 B/frame), so no single fixed byte threshold can both stay under the contended-but-clean
  reading and over the isolated-clean-plus-object reading. Kept `main` at the tight, isolated-derived
  52/40 budgets (correct for the signal) rather than widen past detecting a real control. On a
  quieter machine (1-minute load under ~4, waited for) a 20-run `pnpm test browser` foreground loop
  measured 18/20 pass, 2 fail (both `topology neg object client`, the same contamination shape on a
  different isolate), 0 hang -- see the report for exact counts. Root cause not fully identified:
  `gc-loop`'s own page (one sim worker, one wake per frame) stays reliable under the same stress
  (35/35 in a dedicated `--repeat-each 5 --workers 3` check); `topology`/`echo` do two or three
  busy-spin round trips per synthetic frame (`stepFrame` plus `stepTick`'s sim+gen0 wakes), and
  reducing that by half only partly helped, so the mechanism is probably wall-clock exposure during
  a busy-spin under real contention rather than a fixed per-call cost, but that is not verified.
  **Orchestrator decision needed**: accept the residual flakiness (numbers above), or reduce this
  milestone's own cross-thread synchronisation further, or change how `pnpm test browser` schedules
  the `gc` project relative to the others (e.g. not sharing the worker pool) -- the last two are
  bigger changes than this brief's step 5/6 scope covers on their own.
- **Production workers must be parked before `__pageReady`.** Unlike the M03/M04 harness (starts
  idle, only entering `Atomics.wait` on the first `resume()`), a production worker enters its
  blocking loop immediately after `ready` (Planning decisions: `ready` is posted, then
  `runBlockingLoop` starts, synchronously, in the same task). `gc-topology.ts`/`gc-echo.ts` therefore
  call `await parkWorkers(client)` before setting `window.__pageReady = true`; skipping this hung
  `measure()`'s isolate-naming step (a CDP `Runtime.evaluate` on a blocked worker never returns)
  rather than failing fast -- documented in the `gc-test` skill so a future page does not rediscover
  it as a mystery 30 s timeout.
- **`createClient()` checked `crossOriginIsolated` too late.** `createSabSet()` (hence `new
  SharedArrayBuffer`) ran synchronously in `createClient()` itself, before the async `start()`'s own
  isolation check, so a non-isolated page threw a bare `ReferenceError` (`SharedArrayBuffer is not
  defined`) straight out of `createClient()` instead of `client.ready` rejecting with
  `EngineStartError('not-isolated', ...)` -- found by `start.not_isolated_error`. Fixed by moving the
  check to the top of `createClient()`, before any SAB is touched; on failure it now returns `{
  ready: Promise.reject(err), destroy() {} }` directly, without creating any SAB, control block or
  worker entry.
- **`start.not_isolated_error`/`start.worker_blocked_error`** use two new `fixturesPlugin()` routes,
  registered under `configurePreviewServer` (not `configureServer`: the browser suite navigates
  against `vite preview`, which fires the former, not the latter). `/__no-isolation__/<built file>`
  serves the exact built bytes from `dist/` with no COOP/COEP at all (a route that ends its own
  response before Vite's header middleware runs never gets them, same trick as the existing fixture
  route, M02b Deviations). `/__no-coep-worker__.js` serves the built `worker-auto-*.js` chunk
  (globbed by filename pattern, since it is content-hashed) with `Cross-Origin-Opener-Policy` but no
  `Cross-Origin-Embedder-Policy`; `topology.ts`'s `__createClient` gained a `createWorker` passthrough
  (pattern B, already in `ClientOptions`) so the test can point every spawned worker at that route
  from an otherwise normally-isolated page. Neither spec uses the shared `openPage` helper (it
  asserts `crossOriginIsolated` and fails on any console error, both of which these two tests
  deliberately trigger); a small `openWithoutIsolationChecks` in `start.spec.ts` just navigates and
  waits for `__pageReady`.
- **`grep -n postMessage packages/engine/src`**, summarised by file (production code only; `src/
  test/**` has its own separate, pre-existing M03/M04 harness message protocol -- `setup`/`resume`/
  `hash`/`admit`/`memory`/`memGrows`/`markIsolate`/`pmTick`/`dispose` -- unrelated to the production
  worker protocol this criterion is about): `client.ts` (1, the `setup` message), `worker.ts` (2, the
  `FromWorker` `postMessage` type and the shared `post()` used for `ready`/`fatal`), `worker/shell.ts`
  (2, the shared `post()` used for `fatal`, plus its own doc comment), `worker/protocol.ts` (1,
  comment), `sab/control.ts` (1, this session's own doc comment). No kind body calls `postMessage`
  directly (`worker/shell.ts`'s `post()` is the one channel every kind shares); `resume`/`stop` are
  not yet posted by any production code path (only by `test/client.ts`'s `resumeWorkers`/
  `parkWorkers`'s wake, and `destroy()`'s own yield+terminate, which never posts `stop`) -- reserved
  for whichever later milestone (M09's rAF loop, most likely) drives them from production code.
