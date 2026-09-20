# M06b: Worker kinds and the `createClient` spawn path

Status: done · After: 06 · Tyler-dependent: no

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
- [x] All tests above pass by name; pages `topology` and `echo` within the budgets below with zero GC events and unchanged `memory.buffer.byteLength` on every instance.
- [x] `grep -n postMessage packages/engine/src` shows only setup, ready, fatal, resume and stop.
- [x] `pnpm test` and `pnpm lint` are green.

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
  (not independently re-verified here; carried forward as a flag -- see Notes for later briefs).
- **`abi-mismatch` vs `worker-fatal`** is chosen by string-matching the fatal message
  (`m.message.includes('ABI mismatch')`, `client.ts::setupWorker`).

### Steps 5-6 (this session)

- **Debug-global gate is the setup message's `test` field, not `test.flags`.** `SetupMessage.test`
  (`worker/protocol.ts`) is `TestFlags`, populated from `options.test?.flags` only, so a production
  `createClient()` call (no `options.test`) gets none of the three debug globals; `topology.ts`'s own
  `__createClient` defaults `flags` to `{}` so existing `workers.spec.ts` assertions still hold.
  `self.__engineIsolateName` (new) is `'client' | 'sim' | 'gen0' | 'gen1' | 'net'`
  (`worker/protocol.ts::isolateName`, shared by `worker.ts` and `asHarness`).
- **`CB_TEST_CONTROL`**: global control word 4 (`sab/control.ts`; words 5-7 still reserved).
  Encoding: `0` = none, else `((workerIndex + 1) << 8) | kind` (`kind`: 1 = object, 2 = burst, same
  numbering as `src/test/step-block.ts`'s `StepControl`). `worker/gc-hook.ts::applyGcHook(control,
  index)` is the production-side reader (production code cannot import `src/test/**`), read only
  when a kind's own `setup()` closed over `message.test?.gcHook === true`.
- **`sim`/`gen` bodies are no longer bare no-ops.** Each stores `W_ACK = wokenBy` on every real wake
  (unconditional `Atomics.store`, not gated by `gcHook`), beyond the brief's "no-op" wording for
  these stub bodies, so a test driver can lockstep with them the way `stepFrame` already locksteps
  the client role (Notes for later briefs, below).
- **`asHarness(client): Harness`** (`test/client.ts`): `park`/`resume` → `parkWorkers`/
  `resumeWorkers`; `stepFrame` → this file's own `stepFrame`; `stepTick` → wakes every spawned
  `sim`/`gen` worker and spins on `W_ACK` (scratch array preallocated once); `setWorkerControl` →
  `CB_TEST_CONTROL`; `memoryBytes`/`memGrows` → `W_MEM_PAGES`/`W_MEM_GROWS` (no message);
  `markIsolates` is a no-op (marking moved to CDP, below); `hash`/`admit`/`messageTick` reject (no
  production counterpart yet); `workerGcExposed()` always `true` (no message asks a production
  worker to confirm the `gc` project's process-wide `--expose-gc` itself); `errors()` always `[]` (no
  ongoing fault channel past `ready`/`fatal`).
- **New pages are `gc-topology.html`/`gc-echo.html`, not `topology.html`/`echo.html`.**
  `topology.html` already serves `workers.spec.ts`/`start.spec.ts`'s imperative debug API (client
  created only on explicit `__createClient()`, so those specs count exactly the workers *they*
  spawn); a zero-GC page instead auto-creates its client at load (`window.__gc.ready` resolves with
  no prior call), which would spawn extra, uncounted workers and break that count. `budgets.json`'s
  `gc.pages` keys stay `topology`/`echo` regardless (`zeroGcSuite`'s `pageId` is independent of the
  HTML file name).
- **`echo`'s round trip does not use the frame req/ack lockstep.** `worker/client.ts`'s `body()`
  stores `W_ACK` only when `CB_FRAME_REQ` changed, *before* the unconditional ring-echo block runs;
  two wakes issued back-to-back could coalesce into one `body()` call, letting `main` observe the ack
  before the echoed message actually reaches `uiRing`. `gc-echo.ts` instead spins directly on
  `RingConsumer.peekLen() >= 0`: safe because `RingProducer.tryPush` writes the payload bytes before
  its atomic `HEAD` store, so observing `HEAD` advance already guarantees the payload is visible.
- **`fixtures/hash`'s `Rx`/`Tx` are sized per role**, not per test flag: `CLIENT_RX_TX_BYTES = 10 *
  1024` for `Role::Client` (any Client instance, `echo` flag or not), unchanged 64 B for `Sim`/`Gen`.
  `golden/golden.json` untouched (Sim-role only path; `pnpm golden` not run), `pnpm test rust`/`wasm`
  stayed green. This grew the Client role's own fixed footprint by roughly 20 KB before rounding to
  the next 64 KB WASM page -- still inside the same 20-page bucket every existing `workers.spec.ts`
  `FIXED_FOOTPRINT_BYTES` assertion assumes (all stayed green unmodified), but the page-boundary
  margin for `client` is now much smaller than for `sim`/`gen` (Notes for later briefs, below).
- **Isolate marks move to CDP for workers, stay `page.evaluate` for `main`** (`gc/instrument.ts`,
  orchestrator decision 3). A production worker cannot call `performance.mark` itself (`.claude/
  rules/hot-paths.md`), so `measure()` sends each worker session a `Runtime.evaluate` of
  `self.performance.mark('gc-isolate:' + self.__engineIsolateName); undefined` (`returnByValue: true`,
  trailing `undefined` so the `PerformanceMark` is never retained) while parked. Routing `main`
  through the same second-CDP-session approach too measurably moved `gc-loop`'s own `main` clean
  reading from ~45.5 to ~54 B/frame, tripping its 54 B budget, so `main` still marks itself through
  `page.evaluate(() => performance.mark('gc-isolate:main'))`. `installGcPage`'s own `markIsolates()`
  is unchanged and still callable; `measure()` just no longer calls it.
- **`zeroGcSuite` takes an optional `controlKinds`** (default every kind, `gc-loop`'s existing
  shape): `topology`/`echo` pass `['object', 'burst']`, skipping the generated `post-message`
  control (no spare `postMessage` type on a production worker to drive a message-round-trip tick).
- **`measure()`/`zeroGcSuite` take an optional `warmupFrames`** (default `WARMUP = 120`, `gc-loop`'s
  own tuned figure; kept as the global default so its entry stays untouched). `topology`/`echo` pass
  `warmupFrames: 8000`: at 120, and even 3000, the deeper production `yield`-protocol call chain had
  not reached steady optimised code (`main` read as high as ~51.8-53.86 B/frame and the `object`
  control did not reliably separate from clean); at 8000 every control tripped only its own named
  isolate and readings stabilised -- **superseded**: fix round 3's own re-measurement below found
  `WARMUP` alone was not the whole story; current figures are its "Measured after all of the above"
  paragraph.
- **Fix round 1 (`1fc1abf`).** The orchestrator's hypothesis for a `main`-contention swing seen at
  this point was V8 tiering; `byFn` evidence on `topology clean` versus a reliably contended repro
  (`--project gc --grep topology --workers 3 --repeat-each 4`) instead showed the growth concentrated
  in two native-builtin buckets (`next@:0`, `values@:0`), pointing at one allocating site under
  contention rather than spread-out double-boxing. Two real per-pass allocation bugs were found and
  fixed: (1) `parkWorkers`/`resumeWorkers`'s poll predicate (`src/test/client.ts`) built a fresh
  closure and called `.every()` every macrotask tick -- fixed with a named `allEqual(h, field, want)`
  created once per call; (2) `ManualClock.fireDue` (`src/test/manual-clock.ts`) built a `Map`
  iterator every `advance()` call with zero timers ever registered -- fixed with the same
  `timers.size === 0` guard `frame()` already had. Two reverted attempts, kept for the next person:
  **(a)** Chromium launch flags forcing permanently-unoptimised code
  (`--no-concurrent-recompilation --no-concurrent-osr --no-concurrent-sparkplug
  --concurrent-maglev-max-threads=0`) made every reading uniformly worse -- reverted. **(b)** An
  adaptive "warm up in short `HeapProfiler`-sampled windows until two consecutive readings agree
  within 1 B" loop did not fully fix the contended case either (it can stabilise at a wrong,
  permanently-baseline-tier plateau) and added real per-test CDP overhead -- reverted in favour of
  the plain fixed `WARMUP = 8000` above. What this round called "residual cross-isolate interference"
  (a target isolate's own control measurably raising a *sibling* isolate's reading) turned out to be
  per-pass `HeapNumber` boxing in the blocking loop scaling with the number of timeout passes (fix
  round 2, second pass, below) plus the lost-wake race (fix round 3, below); its widened budgets and
  `STEP_TICK_EVERY = 2` were rejected by the orchestrator and removed in fix round 2 (numbers there).
- **Production workers must be parked before `__pageReady`.** Unlike the M03/M04 harness (starts
  idle, only entering `Atomics.wait` on the first `resume()`), a production worker enters its
  blocking loop immediately after `ready` (Planning decisions: `ready` posted, then
  `runBlockingLoop` starts, synchronously, in the same task). `gc-topology.ts`/`gc-echo.ts` therefore
  call `await parkWorkers(client)` before setting `window.__pageReady = true`; skipping this hung
  `measure()`'s isolate-naming step (a CDP `Runtime.evaluate` on a blocked worker never returns)
  rather than failing fast -- documented in the `gc-test` skill so a future page does not rediscover
  it as a mystery 30 s timeout.
- **`createClient()` checked `crossOriginIsolated` too late.** `createSabSet()` (hence `new
  SharedArrayBuffer`) ran synchronously in `createClient()` itself, before the async `start()`'s own
  isolation check, so a non-isolated page threw a bare `ReferenceError` instead of `client.ready`
  rejecting with `EngineStartError('not-isolated', ...)` -- found by `start.not_isolated_error`.
  Fixed by moving the check to the top of `createClient()`, before any SAB is touched; on failure it
  now returns `{ ready: Promise.reject(err), destroy() {} }` directly, with nothing created.
- **`start.not_isolated_error`/`start.worker_blocked_error`** use two new `fixturesPlugin()` routes
  under `configurePreviewServer` (the browser suite runs against `vite preview`, which fires that
  hook, not `configureServer`). `/__no-isolation__/<built file>` serves the exact built bytes with no
  COOP/COEP at all (same end-response-early trick as the existing fixture route, M02b Deviations).
  `/__no-coep-worker__.js` serves the built `worker-auto-*.js` chunk (globbed by filename,
  content-hashed) with COOP but no COEP; `topology.ts`'s `__createClient` gained a `createWorker`
  passthrough (pattern B, already in `ClientOptions`) to point spawned workers at that route. Neither
  spec uses the shared `openPage` helper (both deliberately trigger a console error or
  non-isolation); `openWithoutIsolationChecks` in `start.spec.ts` just navigates and waits for
  `__pageReady`.
- **`grep -n postMessage packages/engine/src`**, by file (production code only; `src/test/**` has its
  own separate, pre-existing M03/M04 harness protocol, unrelated to this criterion): `client.ts` (1,
  the `setup` message), `worker.ts` (2, the `FromWorker` type and the shared `post()` for
  `ready`/`fatal`), `worker/shell.ts` (2, `post()` for `fatal`, plus a doc comment),
  `worker/protocol.ts` (1, comment), `sab/control.ts` (1, doc comment). No kind body calls
  `postMessage` directly (`worker/shell.ts`'s `post()` is the one channel every kind shares);
  `resume`/`stop` are posted only by `test/client.ts`'s `resumeWorkers`/`parkWorkers` -- reserved for
  whichever later milestone (M09's rAF loop, most likely) drives them from production code.

### Gate history

At `1fc1abf` (fix round 1) `pnpm test && pnpm lint` was green on a quiet run, but the orchestrator
did not accept the milestone, for three reasons -- all now resolved:

1. **`pnpm test browser` not reliable** (25/30 quiet, 25/30 under synthetic saturation; failures were
   `topology` and M04's `gc: flat transport parity`, 0 hangs). **Resolved** at `5aec08f`: the
   lost-wake fix (fix round 3, below).
2. **Budgets above the ADR** (worker isolates budgeted well above the strict 8 B/frame figure of
   0016 §1; `main` budgets carrying explicit "sibling-burst headroom"; numbers under fix round 2,
   second pass, below). **Resolved** at `37008df`: strict 8 B/frame on every worker isolate, `main` =
   ceil(clean max) + 8, no headroom.
3. **`STEP_TICK_EVERY = 2` masked a defect** (halving the tick rate to keep idle `sim`/`gen0` under
   budget; see fix round 2, second pass below for the reading it was hiding). **Resolved** at
   `37008df`: the constant removed, ticking every frame again.
4. **Round-3 gate failure**: after 1-3 were fixed, `gc: flat transport parity` still failed 2/10
   foreground runs (`sim` differing by exactly 136 B, tunnel high). **Resolved** at `5aec08f`: the
   136 B was V8's lazily-allocated feedback metadata for `armedLoop` landing inside the measured
   window on some runs (fix round 3, below); fixed by splitting warm-up into 8 passes.

Decisions A, B and C (owed from the previous orchestrator session) were decided in this round and built at `24e0302`:
**A**, `frame(t_ms)` stays a true contract -- JS keeps passing a constant, the Rust extern shim
ignores the raw argument and reads `camera.frame_time_ms` instead (as-built text under Fix round 3
below is authoritative); **B**, `isDetached` feature-detects `'detached' in ArrayBuffer.prototype`
once at module load, falling back to the old check when absent (as-built text under Fix round 3
below is authoritative); **C**, `browser` suite headroom (17 s of 25 s) not acted on now, trip-wire
recorded in `docs/plan/deferred-ledger.md`.

**Orchestrator acceptance** (`9f9736d`, 2026-09-20): `pnpm gate ac7a24d` clean, no goldens changed,
no markers; `pnpm test && pnpm lint` green (`rust 39`, `unit 85`, `wasm 25`, `browser 52`, 17 s/25 s);
`browser` × 30 at ambient 1-minute load 10-13: 30/30, 0 hangs, slowest suite line 18 s; `browser` × 30
with `--load 10` (1-minute load 27-35): 30/30, 0 hangs, slowest 22 s; `unit` × 15 plain 15/15 and ×
10 with `--load 10` 10/10. The orchestrator accepted the split warm-up (`WARMUP_PASSES = 8`, same
total frames) as a change to M04's instrument: it excludes one-time lazy-feedback allocation from a
steady-state measurement and leaves the measured window, budgets and controls untouched.

### Fix round 2, second pass (`37008df`)

Reconstructed after the fact from `git show 37008df`, `budgets.json` and the code comments that cite
this entry by name: that implementer left no report. Three allocation sites, all a double-valued
temporary boxed into a fresh `HeapNumber` in the interpreter tier, which code that spends its life
blocked in `Atomics.wait` may never leave:

- **`NO_TIMEOUT`** (`src/worker/shell.ts`). Each kind declared its own `const NO_TIMEOUT = (): number
  => Number.POSITIVE_INFINITY`, and `runBlockingLoop` calls `timeoutMs()` before every wait, so the
  named-property read re-boxed on every pass -- woken or timed out. `byFn` named it the top site in
  idle `sim`/`gen0`: ~3100 B over ~300 wakes, about 10 B per pass. Replaced by a module-level
  `INFINITE_TIMEOUT_MS` constant returned by one shared `noTimeout()` (`sim.ts`, `gen.ts`, `client.ts`
  all import it).
- **`frame(t_ms)`** (`src/worker/client.ts`). The worker read the just-copied camera block through a
  `Float64Array` view (`frameTime[0] as number`) and passed it to `inst.call1(inst.x.frame, ...)`: a
  `Float64Array` element read boxes, about 12 B on every real frame. The worker now passes the
  module-level Smi constant `FRAME_ARG = 0`; the 80-byte block, `frame_time_ms` included, is already
  in this role's own `Camera` region on the same pass, so Rust reads it there. The export's declared
  shape is unchanged (no `ABI_VERSION` bump) because 0014 and briefs 08b, 15b, 16b, 17, 18, 19, 26, 30
  cite `frame(t_ms)` by name -- what that meant for the *game-facing* contract was left open and is
  decision A below.
- **The loader's detach check** (`src/loader.ts`, M02 code, every runtime). `call0`/`call1`/`call2`
  ended with `this.mem.u8.byteLength === 0`, whose own comment claimed it allocated nothing;
  `TypedArray.prototype.byteLength`'s getter boxes its return value on an unpredictable fraction of
  calls, which made every isolate that calls a WASM export at all allocate unpredictably -- a source
  of `gc: flat transport parity`'s run-to-run mismatches on `sim`. Replaced by
  `ArrayBuffer.prototype.detached` (a plain boolean). A buffer-identity comparison was tried and
  measured worse. The comment left behind said a "smaller, residual, intermittent allocation"
  remained on this check; fix round 3 found that residual to be somewhere else entirely (below).
- **`STEP_TICK_EVERY` removed** from `gc-topology.ts`/`gc-echo.ts` (it had halved the tick rate to
  hide the `NO_TIMEOUT` re-box: 7.33 B/frame at half rate is ~14.7 B per wake, one `HeapNumber`), and
  `budgets.json` was re-derived -- **superseded history**: `client`/`sim`/`gen0` back to the strict
  8 B/frame on both pages (clean 0.83-1.31 measured, was 7.33-33 masked), `topology.main` 52 → 50
  (clean max 41.65, ceil + 8) and `echo.main` 40 → 38 (clean max 29.83, ceil + 8), both with the
  "sibling-burst headroom" dropped. `gc-loop.sim` stayed 8 with its formula rewritten around a
  claimed "perfectly reproducible" 3.85 B/frame -- later found wrong by fix round 3 (below); current
  figures are its "Measured after all of the above" paragraph. `fixtures/hash/golden/golden.json`
  untouched, `ABI_VERSION` still 2.

### Fix round 3 (this session)

**The 136 B on `sim`, named.** `gc: flat transport parity` compares `sim`'s exact byte total between
tunnel and flat CDP transports; the tunnel run read 2448 B where the flat run read 2312 B,
reproducible with no contention at all (`--grep "flat transport parity" --workers 1` failed 3/10 runs
at `03c69ca`). Per-sample attribution (exact under `--sampling-heap-profiler-suppress-randomness`)
showed the two runs identical but for two extra samples, 28 B and 108 B, inside `armedLoop`
(`src/test/harness-worker.ts:69`, which allocates nothing itself) -- V8's lazily-allocated feedback
metadata for that function, confirmed by `--js-flags=--no-lazy-feedback-allocation` (8/8 runs a
constant 2364 B). `installGcPage`'s `run()` invokes `armedLoop` via `resume()` → two `post()` calls →
`park()`; `measure()` warmed up with **one** `run()` call, so the measured `run()` was that path's
*second* invocation -- right at V8's lazy-feedback threshold, which is why the 136 B landed inside
the window on some runs and before it on others. Fix, at that site: `measure()` now drives its
warm-up as `WARMUP_PASSES = 8` calls of `WARMUP / 8` frames each (`tests/browser/gc/instrument.ts`),
same total frames, no tolerance or retry near the parity test. Result: the parity test passed 10/10
(was 3/10 failing), and `gc-loop.sim` reads a constant 2172 B (3.62 B/frame) on both transports.

**The lost wake, found on the way.** Eight warm-up passes per measurement made `pnpm gc` (28 tests, 3
workers) fail 4-6 tests in 40-47 s with `stepFrame: the client worker did not ack the frame request`
and `gc-echo: no response from the client worker`, where one pass passed 25/25 in 8.5 s. A real
missed-wakeup in the production `yield` protocol, multiplied by the extra resume cycles rather than
caused by them: `Shell.resume()`, `runAsync`'s re-entry and `worker.ts`'s first entry all published
the worker as available (`W_PARKED = 0`, or the `ready` post) *before* `runBlockingLoop` read its own
`W_WAKE` baseline, so a wake issued in that window was lost and main spun out its 2e9-iteration
`W_ACK` spin and threw. Fixed: each caller now reads the word first (`Shell.observeWake()`) and
passes it to `runBlockingLoop(shell, body, timeoutMs, lastSeen?)` -- one optional parameter appended,
no seam renamed. With that, `pnpm gc` at 8 warm-up passes is 28 passed in 10.4 s. New test
`shell.resume_does_not_lose_a_wake` (`src/worker/shell.test.ts`, `unit`) drives that exact ordering
(400 ms wait timeout, body must run under 200 ms; without the fix it measures 405 ms and fails).
Very likely the defect behind fix round 1's `topology`/`echo` failures and the suite's contention
sensitivity generally.

**Decision A as built.** `abi::frame` (`crates/engine/src/abi/mod.rs`) takes the raw argument as
`_raw_t_ms` and calls `rt.inst.frame(camera.frame_time_ms, camera, result)`; the extern's own
signature, `ABI_VERSION` (2) and `fixtures/hash/golden/golden.json` are untouched, and no brief
needed an edit. `fixtures/hash`'s `frame` writes its `t_ms` *argument* at `Result[16..24]` again (it
wrote `camera.frame_time_ms` there after round 2, which made the assertion circular), and
`workers.camera_block_reaches_wasm` now reads 24 bytes and compares that `f64` with the
`frame_time_ms` the page reports for the same step (`__setCameraAndStep` returns
`clientTestHandle(client).cameraState.frameTimeMs`). Mutation-checked: with the shim passing the raw
argument again the test fails, `Expected: 157.375, Received: 0`. The unused raw export argument is
recorded here as decision A asked.

**Decision B as built.** `src/loader.ts` now selects the detach check once at module load: `const
isDetached: (buffer: ArrayBufferLike) => boolean = 'detached' in ArrayBuffer.prototype ? ... :
(buffer) => buffer.byteLength === 0`. Two whole functions, one chosen once; no per-call branch.
Coverage: `loader: views survive memory growth` (Node, `wasm`) unchanged for the getter path; a new
sibling deletes the getter (`vi.resetModules()`) and proves the fallback rebuilds views
(mutation-checked: a fallback returning `false` gives 0 rebuilds and fails it); the Bun leg
(`tests/wasm/bun-leg.mjs`, JavaScriptCore) gained its own copy, registered in `scripts/suites.mjs`.
The `wasm` suite is 25 tests, was 23.

**Measured after all of the above** (8 clean runs per page, `bytesPerFrame`, budgets unchanged):
`gc-loop` main 43.47 constant / `sim` 3.62 constant (budgets 54 / 8); `topology` main 39.47-39.73,
`client`/`sim`/`gen0` 2.52 constant (50 / 8); `echo` main 27.45-27.49, workers 2.52 constant (38 / 8).
`main` fell on every page; the worker isolates rose from ~1.3 to a constant 2.52 B/frame, which is the
split warm-up moving which one-off allocations fall inside the window -- still far under the strict 8,
and now identical run to run and transport to transport. Every negative control still trips on its
own isolate only (`pnpm gc`: 25/25). `budgets.json` formula strings carry these re-measurements; no
budget number moved.

**Proof** (this session, foreground, per-run kill timeout, load checked before each batch): `browser`
x10 twice quiet -- `pass=10 fail=0 hang=0 slowestSuiteSeconds=17` and `pass=10 fail=0 hang=0
slowestSuiteSeconds=16`; `browser` x10 with `--load 10` -- `pass=10 fail=0 hang=0
slowestSuiteSeconds=20`. `pnpm test`: `rust 39`, `unit 85 (1.2 s/3 s)`, `wasm 25 (1.3 s/7 s)`,
`browser 52 (17 s/25 s)`; `pnpm lint` all pass. `pgrep -x yes` = 0 and `lsof -ti tcp:4517` empty
after the runs.

### Notes for later briefs

- `sim`/`gen` bodies store `W_ACK` on every wake (a single unconditional `Atomics.store`); M08b and
  M13 must keep that store (or an equivalent) when real work replaces `body()`, since a test driver
  may still need to lockstep a synthetic wake with these roles from outside.
- A wake issued while a worker is parked is not replayed on `resume()`.
- Every caller that re-enters `runBlockingLoop` must pass `lastSeen` from `Shell.observeWake()`, read
  *before* publishing the worker as available (the lost-wake fix, Fix round 3 above).
- M13 replaces `noTimeout()` for `sim` with a real deadline and must keep it allocation-free: integer
  milliseconds, no double-valued temporary.
- `CB_TEST_CONTROL` is global control word 4; words 5-7 are still reserved.
- New zero-GC pages on the production topology must `parkWorkers` before setting `__pageReady`.
- The raw argument of the `frame` export is unused (Rust passes `camera.frame_time_ms`, decision A).
- The Client role's fixed footprint (grown by the `echo` Rx/Tx sizing) is close to its 20-page
  boundary; the margin for `client` is now much smaller than for `sim`/`gen` -- flagged for whoever
  next grows the Client role's own fixed data.
