# M37b: WebGPU device loss, `rendererLost`, the test device-loss flag

Status: not started · After: 34 (runs **before** M37) · Tyler-dependent: no

Split out of M37 (sizing rule: reading list). It runs first so M37's event audit includes `rendererLost`.

## Goal
The renderer survives a WebGPU device loss without the camera, input, overlay or sim stopping: it rebuilds every GPU object, the client worker re-enqueues resident terrain, and the picture returns. When it cannot (no adapter, or repeated loss), the game is told through `rendererLost`. Tests can lose the device on demand.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0018-renderer.md` (§8 lifecycle: the device-loss sequence and the null-adapter / repeated-loss rule; §3 page texture, indirection, visual table: what must come back; §1 last bullet: reused descriptors)
3. `docs/decisions/0020-testing-strategy.md` (§6 last paragraph: every browser test fails on device loss and `uncapturederror`; §8 the test entrypoint)
4. `docs/decisions/0016-zero-gc-definition.md` (§2 exclusions: device loss is a rare discontinuity outside the measured window)

Mine from spikes: `spikes/zero-gc-webgpu/` (device, pipeline and pool creation in one place). Rules that apply: `.claude/rules/hot-paths.md` (the rAF callback gains a no-device branch; the healthy path must allocate nothing new).

## Scope
- **Re-runnable GPU setup.** `render/device.ts` (M09) and everything created from the device (terrain pipeline and textures M09/M09b, art array and mips M09b, sprite atlas and uber-quad pipeline M17/M17b, instance buffer, reused descriptors and bind groups) hang off one `GpuResources` object built by one function, so loss handling is "drop it, build another". No behaviour change while healthy.
- **Loss sequence** (0018 §8): `device.lost` → request adapter → device → reconfigure the same canvas → `GpuResources` again → re-fetch art (HTTP cache) → rewrite the visual-table uniform from `tiles.json` (it lives on main, M09) → set `CB_FLAGS` bit `RENDERER_RESET` (reserved by M06) and wake the client worker. The client worker, seeing the bit at its next wake, clears it and calls the client export that marks every resident chunk and the indirection window for re-upload (`Uploader::requeue_all`, visible first by the existing priority); the chunk-upload ring's byte budget paces the refill as on a join.
- **While no device exists** the rAF callback still integrates the camera, writes the camera block and the overlay properties, takes DrawList slots (and drops them), and does not drain the upload ring; it skips encode and submit. The canvas keeps its last presented frame.
- **`rendererLost`:** `client.onRendererLost(cb: (e: { reason: 'no-adapter' | 'repeated-loss' }) => void)`, raised per the 0018 §8 rule, timed by the injected `Clock` (M03). After it, the renderer makes no further attempt; sim, storage and link continue, so a reload loses nothing. (If an `EngineEvent` union carrier landed, this is a filter over it; M37 owns that rule.)
- **Test flag** (0018 §8; PRE-PLAN §6 list): `engine/test` `loseDevice(client)` (calls `device.destroy()`), `failNextAdapter(client)` (the next `requestAdapter` resolves `null`). Playwright helper `allowDeviceLoss(page)` opts one test out of the global failure rule of 0020 §6.
- **Reference game:** nothing beyond registering the callback; the prompt UI is M37's `status.ts` work.

## Non-scope
The event audit, `onFatal`, trap reactions (M37). Context loss for anything but WebGPU. A non-WebGPU fallback (non-goal). `checkSupport` (M35). Allocation accounting during a loss (0016 §2). Resize, DPR, backgrounding (M09b).

## Files, packages and crates touched
`packages/engine` (`src/render/*.ts`, `src/client.ts`, `src/worker/client.ts`, `src/test.ts`, `tests/browser/render/device-loss.test.ts`, `tests/support/`), the engine crate (`Uploader::requeue_all` + its client export and ABI registry entry). No game package.

## Seams
**Provides:** `client.onRendererLost`; `GpuResources` (internal, one constructor); `CB_FLAGS` bit `RENDERER_RESET` given its meaning; Rust `Uploader::requeue_all()` behind client export `upload_requeue_all`; `engine/test` `loseDevice`, `failNextAdapter`; helper `allowDeviceLoss(page)`.
**Consumes:** `render/device.ts`, terrain path, `Uploader`, chunk-upload ring, `upload_stage`, `renderTo` / `readPixels` / probes, counters (M09); art loading, mips, lifecycle handlers (M09b); DrawList triple buffer, uber-quad pipeline, atlas (M17, M17b); control block and `wake` (M06, M06b); camera block writer and overlay writes (M11, M18); injected `Clock`, `stepFrame`, quiescence (M03); zero-GC `measure` (M04); ABI registry (M02).

## Planning decisions
- **A control-block flag, not a message.** Device loss is outside the zero-GC window, so `postMessage` would be legal, but M06 already reserved `RENDERER_RESET`, a flag is idempotent if two losses race, and tests can read it.
- **Re-upload reuses the join path.** `requeue_all` only marks residency dirty; staging, conversion and pacing are the code M09 already tests, so a loss cannot starve tick-driven patches or exceed the per-frame upload budget (0018 §3). Stale ring records written before the loss are harmless: they are texel writes to slots that exist again.
- **The table is not re-enqueued by the worker** even though 0018 §8 lists it: M09 decided the visual table is built on main from `tiles.json`, so main rewrites it itself. Same outcome, recorded here so the ADR sentence is not read as a missing ring record.
- **Repeated-loss window uses the injected clock,** so both sides of the 0018 §8 interval are tested without waiting.
- **On the software adapter** (`ENGINE_GPU=swiftshader`, M10) `device.destroy()` behaves the same; the tests run in CI. If SwiftShader cannot re-create a device in one process, the recovery test is marked local-only with a named notice and the two `rendererLost` tests still run.

## Order of work
1. `GpuResources` refactor; all render tests green unchanged. 2. `loseDevice`, `allowDeviceLoss`; no-device rAF branch. 3. Rebuild + `RENDERER_RESET` + `requeue_all`; recovery test. 4. `failNextAdapter`, repeated-loss rule, `onRendererLost`. 5. Zero-GC-after-recovery slow test. 6. Nested `CLAUDE.md`.

## Tests added
`rust`: `upload.requeue_all_marks_every_resident_chunk_once`. `browser`: `device loss recovers` (after `loseDevice` and N stepped frames the M09 probes pass again; during the outage `W_ACK` and the camera-block `seq` advanced and an anchored element kept tracking), `device loss: uploads stay under the frame budget` (counter `uploadBytes`), `two losses raise rendererLost` (virtual clock inside and outside the interval), `null adapter raises rendererLost`, `no recovery attempt after rendererLost`. Slow: `device loss then zero-GC window @slow` (loss, recovery, then the standard M04 window passes on main and the client worker).

## Exit criteria
- [ ] The five `browser` tests pass locally on the real GPU and in CI on the software adapter (or carry the named local-only notice above).
- [ ] Every other browser test still fails on an unexpected device loss (negative check: `loseDevice` without `allowDeviceLoss` turns a test red).
- [ ] The M04/M17 zero-GC tests pass untouched, and `device loss then zero-GC window @slow` passes.
- [ ] `pnpm test:slow browser -t bench.frame` shows no regression against its baseline if M36 has landed (M17b's `bench.frame_worstcase` otherwise).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test` · `pnpm lint` · `pnpm test browser -t "device loss"` · `pnpm test browser -t rendererLost` · `pnpm test rust -t requeue_all` · `pnpm test:slow browser -t "device loss then zero-GC"`

## Budgets
PRE-PLAN §7 "Allocation per isolate": unchanged main and client-worker numbers on the healthy path (M04 tests). "GPU upload": the refill respects the per-frame byte budget (`uploadBytes` counter). "Frame time": main share unchanged (frame benchmark). "Test suite": stepped frames and the virtual clock only; each test inside the 0020 §4 browser p95.

## Context artifacts
`packages/engine/CLAUDE.md`: "every GPU object is created in `GpuResources`; nothing else may hold a GPU handle", and how to write a test that expects a loss. `hot-paths.md` unchanged. No new skill.

## Manual device checks
Proposed entry for `docs/plan/device-checks.md` (this row should carry **D**): **M37b-ios-background**: on the iPhone, play, background the tab for several minutes under memory pressure (camera app, a few heavy pages), return: the world is drawn again without a reload, or the `rendererLost` prompt appears; never a frozen or black canvas.

## Deviations
(filled in during Phase 3)
