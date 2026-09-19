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
    host: { kind: 'local'; world: WorldConfig } | { kind: 'remote'; url: string }
    createWorker?: () => Worker                                    // pattern B
    arenas?: { sim?: number; client?: number; gen?: number }       // bytes; defaults 0015 §5
    genWorkers?: number                                            // default per 0008
  }
  interface Client { readonly ready: Promise<void>; destroy(): void }   // later milestones add members
  class EngineStartError extends Error { code: 'not-isolated' | 'worker-blocked' | 'compile-failed' | 'abi-mismatch' | 'arena-config' | 'worker-fatal' }
  checkSupport(): Promise<{ ok: boolean; failures: { code: 'not-isolated' | 'no-sab' | 'no-wasm' | 'no-module-worker' | 'no-webgpu' | 'no-adapter'; message: string }[] }>
  ```
  `host` closes the PRE-PLAN §10 gap "which option selects single-player": `local` spawns the sim worker and forwards `world` (0009), `remote` spawns the net worker. M15 and M29 consume it unchanged.
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
- `unit` suite: `support.report_shape`, `arena.sum_rule`.

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
