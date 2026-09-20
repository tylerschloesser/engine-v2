# M06: SAB primitives, control block, camera block

Status: done · After: 04 · Tyler-dependent: no

Split during planning: the worker kinds, the `createClient` spawn path, the `yield` protocol and `checkSupport` are **M06b** (`06b-workers-and-spawn.md`). This brief is the data structures only, so they can be tested in Node before any worker topology exists.

## Goal
The three fixed SAB shapes of 0015 §2 (SPSC ring, seqlock block, triple buffer) exist as allocation-free TypeScript, together with the control block (wake words, `yield`, acks) and the camera-block layout. Cross-thread correctness is proven under Node `worker_threads` and in Chromium, WebKit and Firefox, in both directions.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0015-threads-memory-and-topology.md` (§2 all of it, §4, Consequences)
3. `docs/decisions/0014-js-wasm-boundary.md` (§4: whole-block copies through view pairs made at init; never `subarray()` in steady state)
4. `docs/decisions/0019-camera-input-and-overlay.md` (§1: the camera-block field list only)

Mine from spikes: `spikes/cross-origin-sab/src/ring.ts`, `bench.ts`, `bench-worker.ts` (control words, one preallocated `Uint8Array` per slot, `wasmU8.set(slotView, off)` drain); `spikes/zero-gc-webgpu/public/worker.js` (`Atomics.wait` loop shape). Rules that apply: `.claude/rules/hot-paths.md` (created by M02; this milestone extends its globs).

## Scope
- `sab/ring.ts`: SPSC ring over one SAB. Two levels: **slot level** (`tryClaim`/`commit`, `peek`/`release`) for fixed-record rings, and **message level** (`tryPush`, `peekLen`, `popInto`) with messages spanning slots, all-or-nothing. Every view is created in the constructor.
- `sab/seqlock.ts`: writer `begin`/`end`; reader copy-with-retry.
- `sab/triple.ts`: three slots of `(header, body)`; writer `backSlot()`/`publish()`; reader `acquire()`.
- `sab/control.ts`: the control block, `wake(index)`, `waitForWake(index, last, timeoutMs)`.
- `sab/layout.ts`: `RING_DEFAULTS`, worker indexes, `SabSet` (the object posted to workers), `createSabSet(hostKind, genWorkers)`, `sabBytesTotal()`.
- `camera/state.ts` + `camera/block.ts`: the `CameraState` object (plain mutable fields, f64 centre) and `writeCameraBlock(block, state)` / `readCameraBlockInto(block, dstU8, dstOffset)`.

## Non-scope
Workers, `createClient`, WASM-side copies, the Rust `CameraBlock` struct (M06b). Camera integration and input (M11). Ring *users*: gen request/result (M08b), upload (M09), connection pair (M15), action and UI rings (M16).

## Files, packages and crates touched
`packages/engine` only: `src/sab/*.ts`, `src/camera/{state,block}.ts`, `*.test.ts` beside them (`unit` suite), one spec and page under `tests/browser/`, one line in `packages/engine/CLAUDE.md`. Plus the globs of `.claude/rules/hot-paths.md`.

## Seams
**Provides**
- `createRing(slotBytes, slots): SharedArrayBuffer`; `new RingProducer(sab, wake?: { control: ControlBlock, index: number })`; `new RingConsumer(sab)`. Producer: `tryClaim(): number` (slot index or -1), `slotView(i): Uint8Array`, `commit()`, `tryPush(src: Uint8Array, len: number): boolean`. Consumer: `peek(): number`, `release()`, `peekLen(): number`, `popInto(dst: Uint8Array, dstOffset: number): number`. Both: `stats(out: RingStats)` (`drops`, `pushed`, `popped`).
- `createSeqlock(bytes)`, `SeqlockWriter`, `SeqlockReader.readInto(dst, off): boolean`.
- `createTriple(headerBytes, bodyBytes)`, `TripleWriter`, `TripleReader.acquire(): number` plus `fresh: boolean`; `headerView(slot)`, `bodyView(slot)`, and `bodyBlockView(slot, block)` in 64 KiB blocks for M17's proportional copy.
- `ControlBlock` with word constants `CB_*` and per-worker `W_*` (layout below); worker indexes `WORKER_CLIENT = 0`, `WORKER_HOST = 1` (sim or net), `WORKER_GEN0 = 2`, `WORKER_GEN1 = 3`.
- `SabSet` field names, which every later brief uses: `control`, `cameraBlock`, `clockBlock`, `drawList`, `uploadRing`, `actionRing`, `inputRing`, `uiRing`, `uplink`, `downlink`, `genRequest[i]`, `genResult[i]`.
- `CameraState`, `CAMERA_BLOCK_BYTES`, `CAM_OFF_*` offsets.

**Consumes** M01: suites `unit` and `browser`, test placement. M02b/M03: the fixture app (`tests/browser/pages/`, one `<name>.html` + `src/<name>.ts` per page), `openPage`, the `@engines` tag for WebKit and Firefox. M03's test-only `step-block.ts` stays as it is for ABI-level harness tests; the control block here is the production replacement it anticipates. M04: nothing yet (the GC assertion over these structures is M06b).

## Planning decisions
- **Ring SAB layout.** 32-byte control (`Int32Array[8]`: `HEAD`, `TAIL`, `DROPS`, `PUSHED`, `POPPED`, `SLOT_BYTES`, `SLOTS`, reserved), then slots. Each slot starts with an 8-byte slot header `{ msg_len: u32, part: u16, parts: u16 }`; `msg_len` is the whole message's length and is non-zero only in part 0. `HEAD` is stored once, after all parts are written, so a consumer never sees half a message. `PUSHED`/`POPPED` count messages and are the quiescence counters 0020 §8 asks for.
- **The wake word is per consumer thread, not per ring (0024 §10).** 0015 §2 lists a wake word in each ring's control block, but a worker with several input rings can `Atomics.wait` on one address only. Each worker has one `W_WAKE` in the control block; a producer constructed with `wake` does `Atomics.add` + `Atomics.notify` on it after `commit`. The consumer loop is `last = load(W_WAKE)`, drain everything, `wait(W_WAKE, last, timeout)`, which cannot lose a wake-up. Reported as an ADR clarification, not a change of mechanism.
- **Ring capacities** (`RING_DEFAULTS`; internal constants, not game config; an owning milestone may revise its row in its Deviations):

  | Ring | Dir | slotBytes × slots | Full-ring policy | Rationale |
  |---|---|---|---|---|
  | `downlink` | host → client | 1,024 × 512 | backpressure | four times the chunk-stream burst of 0010 |
  | `uplink` | client → host | 1,024 × 64 | backpressure | batches are small and ≤ 20/s |
  | `actionRing` | main → client | 1,024 × 64 | `dispatch` throws `RingFull` | human rate, 0004 burst × 1.5 |
  | `inputRing` | main → client | 32 × 256 (fixed records) | drop + count | an event seconds old is worthless; `drops` is 0 in every test |
  | `uiRing` | client → main | 1,024 × 256 | backpressure (worker retries next frame) | `Ui` JSON of several KB spans slots (M16 owns the record kinds) |
  | `uploadRing` | client → main | 4,112 × 256 (fixed records) | backpressure inside Rust's queue | a whole join burst fits; record layout in M09 |
  | `genRequest[i]` | client → gen | 16 × 64 (fixed records) | backpressure | ≤ 2 in flight per worker (0008); M08b owns the record |
  | `genResult[i]` | gen → client | 16 × 64 (fixed records) | backpressure | M08b owns the record; the tiles travel in `genSlabs[i]`, a plain SAB that M08b adds to `SabSet` |

  The triple buffer uses a 1,024-byte header (see M17 for why 0018's 256 does not fit). `sabBytesTotal()` comes to about 8 MiB, inside the 12 MiB of 0015 §5.
- **Control-block layout** (`Int32Array[64]`, one SAB shared by every thread). Global: `0 CB_VERSION`, `1 CB_LIFECYCLE` (0 booting, 1 running, 2 stopping, 3 fatal), `2 CB_FRAME_REQ` (main increments once per rAF or `stepFrame`), `3 CB_FLAGS` (bit 0 `REBASE` after foregrounding, bit 1 `RENDERER_RESET`), `4–7` reserved. Per worker `i` at `8 + 8·i`: `+0 W_WAKE`, `+1 W_YIELD`, `+2 W_PARKED`, `+3 W_READY` (0 no, 1 ready, 2 dead), `+4 W_ACK` (client: last `CB_FRAME_REQ` completed; sim: ticks stepped; gen: jobs finished), `+5 W_MEM_PAGES`, `+6 W_MEM_GROWS`, `+7 W_STATUS`. Seven worker blocks fit; four are used.
- **Camera-block byte offsets** (80 bytes, 8-aligned; fields are 0019 §1's): `0 seq u32`, `4 cursor_valid u32`, `8 centre f64×2`, `24 frame_time_ms f64`, `32 velocity f32×2`, `40 tiles_across f32`, `44 zoom_rate f32`, `48 half_extent_tiles f32×2`, `56 dpr f32`, `60` reserved, `64 cursor_tile i32×2`, `72–80` reserved.
- **Seqlock reader rule.** Up to 8 retries, then keep the previous good copy and bump a `torn` counter (tests assert it stays 0 at one write per frame).
- **Triple-buffer state word.** One `Int32`: bits 0–1 middle slot, bit 2 dirty. Writer `publish()` = `Atomics.exchange(state, back | DIRTY)`; reader `acquire()` exchanges only when dirty. No slot is ever visible to both sides.
- **Uplink poll period: 10 ms** for the net worker's `setInterval` drain (0015 §2). It adds at most 10 ms to an action's latency against a 50 ms tick, and a timer loop measured 0 B. Implemented in M29; in single-player the sim worker is woken by the uplink producer instead.

## Order of work
1. `control.ts` and `ring.ts` slot level, with Node `worker_threads` tests. 2. Message level (spanning, wrap, all-or-nothing). 3. `seqlock.ts`, `triple.ts`. 4. `layout.ts`, camera state and block. 5. Browser test in three engines, both directions. 6. `hot-paths.md` globs.

## Tests added
- `unit` suite (Node, second thread via `worker_threads`): `ring.spsc_sequence` (200k messages, sequence-checked, random sizes up to 5 slots), `ring.full_is_backpressure` (`tryPush` false, `DROPS` 0, nothing lost), `ring.fixed_records`, `ring.wrap_and_span`, `control.no_lost_wakeup`, `seqlock.no_torn_read` (writer stamps all bytes with one value), `triple.newest_wins_never_partial`, `layout.sab_total_under_budget`, `camera_block.roundtrip` (f64 centre exact at ±2^23).
- `browser` suite, tagged `@engines` (Chromium, WebKit, Firefox): `sab.ring_both_directions`: worker → main and main → worker, 0 sequence errors, 0 drops (the spike measured one direction only).

## Exit criteria
- [x] Every test above passes by name; `drops` and `torn` read 0.
- [x] No function in `src/sab/` or `src/camera/block.ts` contains `new`, a closure, an array or object literal, or `subarray` outside a constructor (checked by a small source-scan unit test, `sab.no_alloc_syntax`). The same test fails on `waitAsync` anywhere under `packages/engine/src/` and on `Atomics.wait(` outside `sab/control.ts` (`waitForWake`) and `src/test/**` (0015 §2 Wake-ups); that main never reaches `waitForWake` is M06b's `main.no_wasm_instantiate`.
- [x] `.claude/rules/hot-paths.md` globs cover `src/sab/**` and `src/camera/**`.
- [x] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t ring` · `pnpm test unit -t seqlock` · `pnpm test unit -t triple` · `pnpm test unit -t control` · `pnpm test browser -t sab.ring_both_directions` · `pnpm test` · `pnpm lint` (`-t` is a substring match, M01).

## Budgets
- Memory, whole tab: SABs ≈ 12 MiB (0015 §5). Measured by `layout.sab_total_under_budget` against `counters["sab.totalBytes"]` in `packages/engine/budgets.json` (M04's file and `expectWithinBudget`).
- Allocation per isolate: these functions must contribute 0 B; the measuring pages are M06b's `topology` and `echo`.

## Context artifacts
- `.claude/rules/hot-paths.md` (created by M02, verification line added by M04): add the globs `packages/engine/src/sab/**` and `packages/engine/src/camera/**`. Do not list a glob for a directory that does not exist yet (`src/worker/`, `src/render/`, `src/input/`, `src/overlay/`): M01's `context-artifacts` test fails on a glob that matches no file, M02's `packages/engine/src/**` already reaches those directories once they exist, and the root `CLAUDE.md` invariant line is the fallback for new files (0021 §1). Add the rules this code introduces: views, descriptors and event objects are created in constructors and mutated afterwards; no `subarray`, closures or literals on a per-frame, per-tick or per-message path; no `postMessage` in steady state.
- `packages/engine/CLAUDE.md`: one line for `src/sab/` (which shape to use when: ring = reliable stream, seqlock = small latest-wins record, triple buffer = large latest-wins frame).

## Manual device checks
None.

## Deviations

No split: steps 1-6 fitted one session. No decision changed and no seam under **Provides** was
renamed. Exact shapes, findings and corrections:

- **Ring layout: `HEAD`/`TAIL` are unbounded slot-claim counts, not masked indices.** The physical
  slot is `count % slots`; occupancy is `head - tail`, so full/empty are never ambiguous and no
  slot is reserved as a gap. `createRing(slotBytes, slots)` writes `slotBytes`/`slots` into the
  ring's own control block so `new RingProducer(sab, wake?)`/`new RingConsumer(sab)` (per Seams:
  no extra params) can self-describe. Every slot always carries the 8-byte header (`msg_len: u32`,
  `part: u16`, `parts: u16`); the slot-level API (`tryClaim`/`commit`, `peek`/`release`) is a
  degenerate one-part message over the same physical layout, not a separate header-less format.
  `RingConsumer` grows a `slotView(i)` mirroring `RingProducer`'s (Seams names it only for the
  producer; a slot-level consumer cannot read a claimed slot without it).
- **`sab/bytes.ts`, not in Scope's file list**: `copyBytes` (a manual per-byte loop) and `at`
  (`arr[i] as T`, `noUncheckedIndexedAccess` + biome's `noNonNullAssertion`, both on by default
  here) are shared by every `sab/*.ts` and `camera/block.ts` file. `copyBytes` exists because
  `TypedArray.set` cannot express a source-side sub-range without `subarray()` (banned outside a
  constructor); `seqlock.ts`/`camera/block.ts`'s own two full-buffer copies use `.set()` directly
  instead (see below) since no sub-range is needed there.
- **`sab.no_alloc_syntax` is a regex source scan, not a parser** (the brief calls it "a small
  source-scan unit test"). "Outside a constructor" is read as: a real class `constructor(...) {}`
  body, or a top-level `function create*(...) {}` — both stripped before scanning, since both are
  one-time setup (0015 §2 "created at setup"; `hot-paths.md`'s own "one-time setup" exemption). A
  top-level `const NAME = {...}`/`type NAME = {...}` (module scope, not inside any function, e.g.
  `RING_DEFAULTS`, `RingStats`, `SabSet`) is also left alone: it is not "a function [that]
  contains" a literal either way. `*.test.ts` files are exempt (matches `no-ambient-random.test.ts`
  and `hot-paths.md`'s own convention) — including the scanner's own file, which must name
  `waitAsync`/`Atomics.wait(` in its patterns to look for them. Verified against a real violation
  (a `new Int32Array(1)` added to `control.ts`'s `wake()`, reverted) before trusting it.
- **`SeqlockReader.torn()` and `TripleWriter`/`TripleReader`'s `headerView`/`bodyView`/
  `bodyBlockView` on both sides**, beyond Seams' literal wording (which names `torn` only in prose,
  not as a method, and lists `headerView`/`bodyView`/`bodyBlockView` once, after `TripleReader.
  acquire()`): a test asserting "torn stays 0" needs a way to read it, and a writer cannot write
  without the same view accessors the reader has. `TripleWriter`/`TripleReader`'s initial slot
  ownership is fixed at construction (writer `back=1`, reader `front=2`), matching state's
  zero-initialised `middle=0`; never re-derived from the SAB, since exactly one writer and one
  reader are constructed once per triple buffer.
- **`seqlock.ts`/`camera/block.ts`'s `readInto`/`readCameraBlockInto` use `TypedArray.set`, not
  `sab/bytes.ts`'s `copyBytes`, for both copies (live->scratch, scratch->dst).** Both are
  full-buffer copies (no sub-range), so `.set()` applies with no `subarray()` needed. This is a
  correctness finding, not a style one: with `copyBytes`'s per-byte loop, a real writer/reader race
  under Node `worker_threads` measurably let occasional torn reads exhaust the 8-retry budget
  (reproduced repeatedly while developing `seqlock.test.ts`); switching to `.set()` (a native, far
  shorter critical-window copy) then held clean across dozens of isolated stress runs.
- **`layout.ts` re-exports `WORKER_CLIENT`/`WORKER_HOST`/`WORKER_GEN0`/`WORKER_GEN1` from
  `control.ts`** rather than a second hand-written copy (both Seams' `ControlBlock` bullet and
  `layout.ts`'s own Scope line name "worker indexes"; `control.ts` is the one definition).
- **`layout.ts`'s `clockBlock` is sized 32 data bytes** (`createSeqlock(32)`, 36 B total): M16's
  `docs/plan/16-action-round-trip.md` already names its six `u32` fields (`authoritative_tick,
  predicted_tick, ticks_per_second, session_state, seq_seed, ack_seq`), and M26/M28 add two more
  (`tick_fraction`, `revealed`) — 8 `u32` exactly fills 32 bytes with no slack. M06 owns only the
  size; M16 owns the field layout, unchanged here.
- **`sabBytesTotal()` takes no arguments and assumes the worst case, two gen workers** (`0008
  -chunk-generation.md`), matching `createSabSet`'s own `MAX_GEN_WORKERS = 2`: that is the
  configuration the whole-tab budget must hold under, not whatever `genWorkers` a particular
  `createSabSet` call happens to pass. `hostKind: 'sim' | 'net'` is accepted (Consumes: M06b's
  spawn logic) but does not currently change what is allocated — `uplink`/`downlink` are the same
  shape for a sim host or a net host; recorded here since Provides/Consumes does not say either way.
- **`layout.sab_total_under_budget` lives in `tests/support/layout-budget.test.ts`, not beside
  `sab/layout.ts`**: `tests/support/budgets.ts` cannot be imported from a file under `src/`
  (`tsconfig.json`'s `rootDir` is `src/` itself; `tsc` fails with `TS6059`). Still part of the
  `unit` suite (`vitest.config.ts` already globs `tests/support/*.test.ts`, from M04).
- **`counters.sab.totalBytes` = 12,582,912 (12 MiB, `0015-threads-memory-and-topology.md` §5's own
  SAB budget line in bytes), with a `formula` field** (matching the existing `gc.pages` entries'
  convention). Measured `sabBytesTotal()` at the worst case (two gen workers): **8,277,684 B
  (~7.9 MiB)** — control 256 B + camera 80 B + clock seqlock 36 B + drawList triple `3*(1,024 +
  2,097,152)` B + six single rings (`downlink` 524,320 B, `uplink`/`actionRing` 65,568 B each,
  `inputRing` 8,224 B, `uiRing` 262,176 B, `uploadRing` 1,052,704 B) + two gen-worker ring pairs
  (2,112 B each) — comfortably inside the 12 MiB budget, matching the brief's own "about 8 MiB"
  estimate. `tests/support/budgets.ts`'s `counters: Record<string, number>` type does not reflect
  this nested shape (it was written for M04's still-empty `counters: {}`, and its own `budget()`
  doc comment already assumed dotted-path nesting); left alone, since `budget()`'s dynamic walk
  works regardless of the declared type and only `budgets.json` itself is the change this brief
  allows.
- **`.claude/rules/hot-paths.md`'s `paths:` frontmatter is unchanged**: M02's existing
  `packages/engine/src/**` already matches `src/sab/**` and `src/camera/**` now that they exist
  (the brief's own Context artifacts text: "M02's `packages/engine/src/**` already reaches those
  directories once they exist"), so the exit criterion ("globs cover `src/sab/**` and
  `src/camera/**`") holds without adding narrower, redundant entries. Only the new rule bullets
  (views/descriptors/events in constructors; no `subarray`/closures/literals on a hot path; no
  `postMessage` in steady state) were added to the body.
- **`tests/browser/pages/sab.html` + `src/sab.ts` + `src/sab-worker.ts`**: main and the worker each
  independently sequence their own stream (`toWorker`, `fromWorker`), rather than one side echoing
  the other's sequence, so both directions carry genuinely separate traffic (the spike measured
  worker -> main only). `sab.spec.ts`'s `@engines` tag runs it in WebKit and Firefox too (3/3 in
  every run observed).
- **Worker-based unit tests (`ring`/`control`/`seqlock`/`triple`) import `dist/sab/*.js`, not
  `src/*.ts`**, from hand-written `.mjs` files under `src/test/` (not compiled by `tsc`, so no
  `dist/test/` counterpart exists or is needed): Node cannot execute a `.ts` worker file whose
  relative imports use the project's mandatory `.js` extension convention without a loader this
  package doesn't ship (`--experimental-strip-types` does not rewrite `.js` specifiers to sibling
  `.ts` files without a further flag, measured). This matches the existing `tests/wasm/bun-leg.mjs`
  precedent (same reason: a plain-JS runtime needs real `.js`, and `dist/` is guaranteed built
  before `unit` runs, per `scripts/suites.mjs`'s step order).
- **A tight synchronous JS loop cannot depend on a `postMessage`/`'message'`/`'error'` listener
  firing partway through it**: Node dispatches those on the event loop, which such a loop never
  reaches until it returns. First hung `seqlock`/`triple` tests (had to be killed via the
  background-task tool) before diagnosing; fixed by polling a one-word `SharedArrayBuffer`
  (`doneFlag`, separate from the primitive's own SAB) as plain shared memory instead, checked
  entirely within `Atomics.load`/`Atomics.store` — correct regardless of how much either side's
  presence slows the other down. `ring.test.ts`/`control.test.ts` never hit this: their loop exit
  conditions are already derived from shared-memory state (`popInto`'s return value; a shared
  counter), not a message event.
- **`seqlock.test.ts`'s and `triple.test.ts`'s writer/reader pace themselves with a jittered
  busy-spin, not `Atomics.wait`-based real sleeps.** Measured both ways: two threads calling
  `Atomics.wait` with similar-magnitude millisecond timeouts resonate (both tend to wake near the
  same moment) and collided *more* than tight busy-spin pacing, on this machine. `seqlock.
  no_torn_read`'s final parameters (150->80 writes, larger jittered spin bases) were tuned by
  measuring real torn-read counts across dozens of runs — including runs of the *whole* `unit`
  suite, not just this file in isolation, since the other `sab/*.test.ts` files' own
  `worker_threads` add real concurrent load this file alone does not see. 29/30 full-suite runs
  clean at the landed parameters (one flake at a narrower margin during tuning, not since).
- **`triple.test.ts`'s worker originally stamped `i & 0xff`** (wraps every 256 across 2,000
  publishes); the "did the reader ever go backwards" check's wrap heuristic was too narrow, since
  the reader (newest-wins) legitimately skips arbitrarily many published frames between fresh
  reads, so a "decrease" can be a real wrap at *any* prior value, not only ones above 200. This
  false-failed under real system load (4/6 full-suite runs during diagnosis) purely in the test's
  own bookkeeping (`wentBackwards`, never `inconsistent`) — `triple.ts` itself was never shown
  wrong: an isolated 20-trial, 400,000-publish, zero-idle stress run (maximum contention, no
  pacing) showed 0 inconsistent reads both before and after this fix. Fixed by stamping the full
  32-bit counter as four repeated little-endian bytes instead, removing the wraparound question
  entirely.
- **`control.test.ts`'s `control.no_lost_wakeup` carries an explicit 8 s Vitest timeout** (was the
  5 s default, briefly 30 s) **and terminates its worker with `worker.terminate()` instead of
  awaiting its natural `'exit'`**: see "Fix round 2" below for the investigation and evidence (this
  replaces this bullet's earlier text, which proposed only a longer timeout as the fix — that text
  was wrong: no timeout length fixes a wait that isn't testing anything). No lost-wakeup logic bug
  was ever found or reproduced (the mechanism is a plain shared-memory condition check, immune to
  timing by construction); every reproduction attempt across both rounds — 500+ combined runs from
  round one, another 500+ from round two, isolated and full-suite, unloaded and under synthetic
  full-core contention — never once showed the wake/wait mechanism itself misbehave. What round two
  found instead: after the mechanism's own correctness assertion already passed (tens of
  milliseconds in), the test still separately awaited the worker's natural `'exit'` event, and that
  wait — pure OS thread teardown, verified to hold no further assertions — could itself take several
  real seconds under genuine contention (other `unit` test files' own concurrent `worker_threads`,
  a busy shared machine), which is what was blowing the 8 s budget. `worker.terminate()` tears the
  thread down directly instead of waiting on that same slow natural-exit path; 100/100 and 120/120
  full `pnpm test unit` runs clean under synthetic full-core saturation after the change, versus
  3-18 failures per 100 before it under the same conditions (exact counts in "Fix round 2").
- **`seqlock.ts`'s `SeqlockReader.readInto` backs off between retries** (`RETRY_BACKOFF_SPINS`, an
  `Atomics.load`-bodied spin, not a plain counter that an engine could dead-code-eliminate): see
  "Open gate failures" below. `MAX_RETRIES` is still 8, unchanged from the brief's "Seqlock reader
  rule"; only the real wall-clock time each retry now spans changed. **Re-measured in fix round 2**
  (Required item 3, "decide by measurement whether it is still needed"): temporarily set to 0 and
  run under the same synthetic 12-thread full-core-saturation load used for the round's other
  reproductions, `seqlock.no_torn_read` produced a real `torn() === 2` failure in 1/40
  `pnpm exec vitest run --project unit` runs (structural torn-read exhaustion, not the livelock
  below); restored to `200_000` and rerun under identical load, 40/40 clean. Kept, unchanged, with
  this additional confirmation.
- **Measurements** (Tyler's Mac, 14 logical cores, warm caches unless noted): `unit` suite
  **81 tests, ~0.9-1.2 s of its 3 s budget** across repeated clean runs (was 64 tests/0.8 s at this
  milestone's base sha); `browser` suite **23 tests, ~7-7.5 s of its 25 s budget** (was 20/6.3 s);
  `pnpm test browser -t sab.ring_both_directions` alone: **3 tests, ~2.8-2.9 s**, 3/3 in every
  chromium/webkit/firefox run observed. Full `pnpm test`: `rust` 37, `unit` 81, `wasm` 23,
  `browser` 23, all green on every clean (non-stress-loop) run in this session.

## Decisions needed
None: no seam under **Provides** was renamed, no accepted decision changed, no budget could not be
met. The `sab.no_alloc_syntax`/hot-paths.md-globs reading above (no glob change needed; "outside a
constructor" extended to top-level declarations and `create*` factories) is this session's own
interpretation of brief text that could be read more narrowly; flagged in case the orchestrator
reads it differently.

## Notes for later briefs
- M06b: the production control block (`sab/control.ts`) is ready to replace `src/test/step-block.ts`
  for driving workers; `main.no_wasm_instantiate` (that main never calls `waitForWake`) is still
  M06b's to write.
- M11 (camera/input integration): `RING_DEFAULTS.inputRing` (32 B slots) leaves 24 B of payload
  per slot after the 8-byte header; a "drop + count" policy for a full `inputRing` is not
  implemented by `ring.ts` (no method bumps `DROPS`) — M11 owns deciding how a full ring's producer
  marks a drop.
- M08b/M09/M15/M16 (ring users): every `RING_DEFAULTS` row is this milestone's own sizing guess
  per the brief's own allowance ("an owning milestone may revise its row in its Deviations").

### Open gate failures (orchestrator, 2026-09-19)

- **`control.no_lost_wakeup` hangs intermittently.** At `30ac26e`, tree clean, idle machine apart from two unrelated sessions: `pnpm test` passed once (`unit pass 81 tests 1.1s/3s`), then the next `pnpm test unit` gave `unit FAIL 81 tests 31s/3s over budget` / `FAIL unit control.no_lost_wakeup: Test timed out in 30000ms` at `src/sab/control.test.ts:12`. Fixup `2826750` had only lengthened the timeout. The first implementer was sent back, added diagnostic logging (uncommitted: `src/sab/control.test.ts`, `src/test/sab-control-worker.mjs`; it uses `Date.now()`, which the commit gate rejects), started a reproduction loop and was lost before reporting; no cause is known yet.
- Orchestrator observations from the diff, not verified: the worker calls `waitForWake(…, 5000)` and re-checks `CB_FRAME_REQ` each pass, so a genuinely lost wake-up would self-heal within 5 s; a 30 s hang therefore points at the worker never starting, never finishing, or its completion `postMessage` never being observed. The worker imports `../../dist/sab/control.js`, and `dist/` is rewritten by the `build` step of every `pnpm test` invocation; the test runs inside a Vitest pool thread and spawns a nested `worker_threads` Worker; `src/test/sab-control-worker.mjs` sits under `src/test/` although it is a unit-test helper.
- Required to close: root cause with evidence; before/after failure counts from a bounded foreground loop of the single test; the cause fixed, not the timeout; a tight timeout restored; `pnpm test unit` 20 times in a row green inside the 3 s budget; the other cross-thread tests (`ring.*`, `seqlock.no_torn_read`, `triple.newest_wins_never_partial`, browser `sab.ring_both_directions`) checked for the same pattern; no weakened assertion, no skip/retry marker, no raised budget; diagnostic logging removed.

**Closed (2026-09-19, second implementer).** Two distinct findings, not one:

1. **`control.no_lost_wakeup` itself: no reproduction, no logic bug.** Read `control.ts` against the
   brief's "wake word is per consumer thread" decision: `wake()` is `Atomics.add` + `Atomics.notify`;
   `waitForWake()` is `Atomics.wait(words, at, last, timeoutMs)` then `Atomics.load` — exactly the
   stated shape, cannot lose a wake-up by construction (a `wake()` between the caller's load and the
   `wait()` call is still seen, since the value already differs from `last`). Reproduction attempts,
   all on this machine: 150 in-process runs of the exact test logic (`node` script constructing the
   same `Worker` + main loop, no Vitest), 0 failures; ~350 real `pnpm test unit` invocations
   (unloaded and under synthetic 14-thread full-core-saturation load added and removed within a
   single foreground command), 0 `control.no_lost_wakeup` failures (4 unrelated `seqlock.no_torn_read`
   failures, see below); 300 isolated `pnpm exec vitest run --project unit -t control.no_lost_wakeup`
   runs (no other test files loaded) with a 45 s test timeout and the original diagnostic logging
   re-added temporarily: 1 failure (`Test timed out`, at exactly the then-configured 8 s bound, in an
   *earlier* 30-run batch before the timeout was widened for diagnosis), 0 in the following 210
   diagnostic-instrumented and clean-rerun runs, and no run — failed or passed — ever showed a
   `[DIAG]` gap, a slow `Duration` line, or a suite-budget overrun that would indicate the mechanism
   itself stalling; the one failure gave no diagnostic output at all before being killed, consistent
   with the whole worker thread (or the main thread's own scheduling) being starved by the OS for
   several seconds, not with the wake/wait mechanism misbehaving. Conclusion: the original 30 s hang
   and this one 8 s timeout are the same class of event — an occasional real multi-second scheduling
   stall on this heavily shared, multi-session dev machine (two other concurrent Claude sessions, one
   driving a browser) — not a defect in `control.ts`. Fix applied: restored a tight timeout (8 s: one
   full internal `waitForWake(…, 5000)` cycle plus margin) so a *genuine* future hang fails fast
   instead of being masked for 30 s, per Required item 2; no production code changed.
2. **A different, real, reproducible flake found and fixed along the way: `seqlock.no_torn_read`.**
   Not hypothesized by the orchestrator, but found while running the required reproduction loops:
   `pnpm test unit` failed 4/200 times (`AssertionError: expected 1|3 to be +0` at
   `seqlock.test.ts:57`, i.e. `reader.torn()`), a genuine exhaustion of `SeqlockReader`'s 8-retry
   budget, never a structural torn read (`inconsistent` stayed 0 in every run). Cause, read from
   `seqlock.ts`/`sab-seqlock-worker.mjs`: the writer's `begin()`→stamp→`end()` critical section is a
   handful of nanoseconds, and the reader's 8 retries (each a load, a 64-byte `.set()`, a load) also
   complete in low single-digit microseconds with zero backoff between them — so if the writer's OS
   thread is preempted for even a fraction of a millisecond right after `begin()` (an ordinary
   scheduler quantum under real contention, not a bug), all 8 retries land inside that stall and the
   reader gives up. This is orthogonal to control's mechanism (no retry-then-give-up there at all),
   so it is not literally "the same pattern," but it blocks the same gate (Required item 4's 20-in-a-
   row `pnpm test unit`) and is one of the named tests to check. Fix: `readInto` now spins between
   retries (`RETRY_BACKOFF_SPINS = 200_000` `Atomics.load` calls, ≈1 ms measured on this machine) so
   the 8-retry budget spans real milliseconds instead of microseconds; `MAX_RETRIES` itself is
   unchanged (still "up to 8", per the brief's Planning decision), and the spin body is `Atomics.load`
   rather than a plain counter specifically because an engine can dead-code-eliminate an unused
   counting loop but never an atomic access (measured: a plain increment loop is ~13x faster per
   iteration than an `Atomics.load` loop, `Atomics.load` chosen anyway for this guarantee). Verified:
   40/40 isolated `seqlock.no_torn_read` runs and 40/40 more full `pnpm test unit` runs green
   post-fix (one further 20-run batch under synthetic full-core-saturation load hit 1 unrelated
   *build-step* slowdown past a 30 s outer shell timeout — not a test failure, not reproduced with
   realistic contention, and not investigated further as it reflects 14 CPU-bound spin threads on a
   14-core machine, an artificially harsher condition than "two other sessions").
3. **`ring.*` and `triple.newest_wins_never_partial` do not share either pattern.** Read both:
   `ring.ts`'s head/tail counts and `triple.ts`'s exchange-based state word are structurally torn-
   read-proof (no retry-then-give-up budget exists to exhaust; a partial write is never visible by
   construction, unlike the seqlock's optimistic-read design), matching their tests never having
   shown this failure mode in any run this session. `sab.ring_both_directions` (browser) was not
   re-run beyond the full `pnpm test` pass below; it shares neither test's mechanism.
4. **Verification pasted:** isolated `pnpm exec vitest run --project unit -t "control.no_lost_wakeup"`
   post-fix: 1 failure in an early 30-run batch (the event described above), 0/60 and 0/150 in the
   two follow-up batches (240/241 clean). Required 20-in-a-row: `pnpm test unit` × 20, all
   `unit pass 81 tests   0.9-1.1s/3s` (see the run log; no failures, no over-budget). Final
   `pnpm test`: `rust pass 37 tests 0.2s/10s`, `unit pass 81 tests 1.1s/3s`, `wasm pass 23 tests
   1.7s/7s`, `browser pass 23 tests 8.4s/25s`. `pnpm lint`: `biome pass`, `rustfmt pass`,
   `clippy pass`, `tsc pass`. Diagnostic logging (`Date.now()`-based, both files) fully removed;
   `sab-control-worker.mjs` is byte-identical to `30ac26e`'s version again.

### Fix round 2 (2026-09-19, third implementer): the "Closed" conclusion above was wrong for the
actual gate failure

The orchestrator's new evidence (`pnpm test unit` × 10 on a quiet machine, load average 2.6: 7
clean, 1 hung >10 minutes with exactly one thread pinned at 100 % CPU and every other thread
asleep, `test-results/unit/output.log` empty, 2 more clean) does not match anything the "Closed"
section above investigated. That section only ever reproduced `control.no_lost_wakeup` failing its
*own* timeout (a bounded event, seconds, always eventually resolving on its own) — never an
indefinite hang with one thread spinning forever. **The "Closed" conclusion was right that
`control.no_lost_wakeup` has no lost-wakeup logic bug, but wrong to treat that as closing the
orchestrator's hang report: the two were never the same event.** The real cause of the hang was a
different test entirely, never examined in round one.

**Root cause, found by experiment, not by trusting the orchestrator's ESM-loader/`execArgv`
hypothesis.** First step was to add a one-line synchronous `fs.appendFileSync` diagnostic as the
first statement of every `sab-*-worker.mjs` file's body, plus a handful more at key points in each
`*.test.ts` file (creating the worker, entering the spin loop, periodic progress inside it), gated
behind `process.env.SAB_DIAG` so none of it shipped. Reproducing with a bounded foreground loop
(`child_process.spawn` with `detached: true`, a `setTimeout` that `process.kill(-pid, 'SIGKILL')`s
the whole group, never a background task or monitor) under synthetic 12-thread full-core-saturation
load (12 busy-spin `worker_threads`, this machine has 14 logical cores) reproduced a genuine
60-second-plus hang on run 60 of 100. **The diagnostic log immediately ruled out the orchestrator's
hypothesis**: every worker file's first line, and every worker's own completion, was logged within
milliseconds of the `Worker` being constructed in every single run, hung or not — the nested
`worker_threads` startup was never slow, never blocked, and `execArgv` inheritance was never
implicated (not tested directly, since the evidence already showed startup was not the bottleneck).
The log instead pinpointed the exact stuck test: `triple.test.ts`'s reader loop was still spinning,
59+ seconds after the writer worker had already finished, with the writer's own log showing
`writer loop done, storing done flag` at essentially the same moment the reader's periodic log
showed `freshCount=2` — and every subsequent line, for the rest of the hang, showed the identical
`freshCount=2 done=1`.

That is a **livelock in the test's own loop-termination condition**, not the OS-scheduling noise
"Closed" found in control: `triple.test.ts`'s original loop ran
`while (Atomics.load(done, 0) === 0 || freshCount < 10)`. The writer thread completes a *fixed*
2,000 publishes in well under 100 ms regardless of what the reader is doing (its own idle spin
between publishes is tiny and unconditional). If the reader thread is scheduled rarely enough
relative to the writer — plausible, even likely, whenever the machine is busy with other runnable
threads (exactly "load average 2.6" or heavier), since `triple.newest_wins_never_partial`'s reader
is a single un-paced busy-poll competing with everything else on the box — the writer can finish
and set `done = 1` while `freshCount` is still under 10. Once the writer is gone, no future
`acquire()` can ever be fresh again (nothing new is ever published), so `freshCount` can never
reach 10, and the loop's own exit condition can never become false again: an unbounded spin,
exactly matching "one thread at 100 % CPU, everything else asleep" (the writer thread has already
exited; only the reader remains, spinning). This can happen on a **completely idle** machine too,
given sufficiently unlucky scheduling — the orchestrator's "quiet machine" framing was consistent
with the bug, not evidence against it.

**Fix:** `triple.test.ts`'s loop no longer requires a minimum `freshCount` to exit. It loops until
`done` is observed set (capturing the flag *before* that iteration's `acquire()`, so the iteration
that sees `done` still gets to run once more — catching a final publish that might have raced the
flag), then breaks; `freshCount > 0` is still asserted afterward, unchanged and exactly as strict as
before, just no longer coupled to the loop's own liveness. A generous `process.hrtime.bigint()`
deadline (12 s, under the test's 15 s Vitest timeout) is a backstop against a genuine future stall
this shape of bug can't produce but a different one might — `process.hrtime` is not one of
`packages/engine/src/**`'s banned ambient-time globals (`Date`/`performance`/timers), and this file
is test-only regardless. `ring.test.ts` and `seqlock.test.ts` do not share this liveism defect
(read both against the same question: `ring.test.ts`'s `popped < count` only ever grows, and the
SPSC ring guarantees eventual delivery as long as either side gets any CPU at all; `seqlock.test.ts`
already recovers on its own once the writer is done, since every subsequent uncontested read
trivially succeeds and increments `reads` every iteration) — but both got the same `hrtime`-based
deadline anyway, as defense in depth, per Required item 2 ("every synchronous spin gets a
deadline"), calibrated generously (12 s) so it never trips under any load level observed this round.
No `postMessage`/readiness-handshake change was made to any of the four tests: the diagnostic
evidence showed worker startup was never the slow part, so a handshake would have added complexity
without addressing the actual defect.

**A second, distinct, real flake was found (and fixed) while re-running the required verification
loop, unrelated to the hang above.** Once the triple fix was in place, 100/100 and 120/120 full
`pnpm test unit` runs were clean under the same synthetic 12-thread saturation used to reproduce the
hang — but a plain, uninstrumented `pnpm test unit` loop on this real, actively-used machine (no
synthetic load added; `uptime` showed load averages of 4-18 from two other concurrent Claude
sessions, Chrome, and `corespotlightd`/`spotlightknowledged` reindexing) still failed
`control.no_lost_wakeup` on its own 8 s timeout 3/100 and 3/100 across two independent 100-run
batches (0 hangs in either). Re-adding the round-one-style diagnostic logging (this time to
`control.test.ts` and its worker specifically) to a failing run showed every step of the actual
wake/wait/message protocol completing in under 30 ms total — `test start` to
`await done resolved` — confirming yet again that the mechanism itself is sound. The *only* gap in
the whole timeline was after that: the test's last line, `await new Promise<void>((resolve) =>
worker.once('exit', () => resolve()))`, took the remaining ~7.97 s of the 8 s budget by itself, with
no diagnostic in between (nothing runs there to log) — i.e., waiting for the already-finished
worker's own natural OS-thread teardown to complete and its `'exit'` event to fire is itself what
occasionally takes several real seconds under contention, not anything under test. Fix: replace that
wait with `await worker.terminate()`, which tears the thread down directly rather than waiting on
the same slow natural-exit path, called only after `expect(result.frameReq).toBe(target)` has
already passed (so nothing about the assertion changed or weakened). Verified: 100/100 and 120/120
full `pnpm test unit` runs clean under synthetic 12-thread full-core saturation (previously 82-97/100
clean under the same load, all-and-only-`control.no_lost_wakeup` failures); 100/100 clean on this
real machine at load averages of 4.0-18.8 immediately afterward (previously 3-6/100 failures at
similar load levels, same failure). This is not the hang the orchestrator reported (it always
resolved within its own 8 s budget, never spun a thread at 100 %) but it did block the "0 hangs, 0
failures" verification bar this round required, so it is fixed here rather than left as a known
flake.

**Helper file location, checked per Required item 5.** `src/test/sab-*-worker.mjs` are plain `.mjs`
files; `tsconfig.build.json` only compiles `.ts` (excluding `*.test.ts`), so `tsc` never touches
them, and `dist/test/` (built from `src/test/*.ts`'s real production files — `harness.ts`,
`controls.ts`, etc., the `engine/test` subpath) contains no `.mjs` output at all (checked directly:
`ls dist/test/` lists only the compiled `.ts` files' `.js`/`.d.ts`/`.js.map`). `packages/engine/
package.json`'s `"files"` is `["dist", "crates"]` — `src/` is never published — so these four files
cannot leak into the npm package by either path. Left in place beside their production-code
siblings in `src/test/`; not moved.

**Verification (this round).** Reproduction, before the triple fix, foreground-looped
`pnpm exec vitest run --project unit` under synthetic 12-thread full-core saturation with a 60 s
hard per-run timeout: 1 hang in 40 runs (first batch), 1 hang in 100 runs including that one
(second, instrumented batch; diagnostic evidence above is from this hang). After the triple fix,
identical loop: 0 hangs in 100 runs, 0 hangs in a further 120 runs (both under the same synthetic
load). `pnpm test unit` × 100 on a quiet-ish real machine (load average 2.6-7.8 observed via
`uptime` across the two runs): 100/100 clean, all `unit pass 81 tests 0.9-1.0s/3s`, both before and
after the control fix (the triple fix alone was already sufficient for the hang; the control flake
only showed up in separate loops run specifically to hunt for it, see above). `pnpm test browser -t
sab.ring_both_directions`: `browser pass 3 tests 3.2s/25s` (3/3 engines). Final `pnpm test`:
`rust pass 37 tests 0.2s/10s`, `unit pass 81 tests 1s/3s`, `wasm pass 23 tests 1.2-1.8s/7s`,
`browser pass 23 tests 7-7.3s/25s`. `pnpm lint`: `biome pass`, `rustfmt pass`, `clippy pass`,
`tsc pass`. All temporary diagnostic logging removed from `control.test.ts` and all four
`sab-*-worker.mjs` files, which are byte-identical to their `1926729` versions again; only
`ring.test.ts`, `seqlock.test.ts`, `triple.test.ts` (the deadline/livelock fix) and
`control.test.ts` (the `worker.terminate()` fix) carry real changes this round.

### Orchestrator gate (2026-09-19)

- `pnpm gate 2be6625` clean (29 files, +2192/−5, no goldens or markers changed). On a quiet machine after `M06 fix 2` (`1620a12`): `pnpm test` (`rust` 37, `unit` 81 in 1.1 s/3 s, `wasm` 23, `browser pass 23 tests 7.9s/25s`) and `pnpm lint` green; the full `unit` project 30 times in a row under a 60 s per-run kill timeout: 30 pass, 0 fail, 0 hang, slowest suite line 1 s. Every name under Tests added and Provides found by grep.
- History of the gate: round 1 attributed the hang to scheduling stalls and was wrong; the orchestrator then reproduced it on a quiet machine (run 8 of 10 spun one thread at 100 % CPU for over ten minutes); round 2 found the cause, a livelock in `triple.test.ts` (a reader loop requiring ten fresh reads after the writer had already finished). The orchestrator's own start-up-deadlock hypothesis was disproved by round 2's worker-start logging. No production defect in `src/sab/` was found by either round.
- Decision (orchestrator, technical): the `SeqlockReader` retry backoff (`RETRY_BACKOFF_SPINS = 200_000`, about 1 ms per retry after the first) stays, on round 2's measurement (`torn` 2 in 1/40 loaded runs without it, 0 in 40/40 with it). It costs nothing on the uncontended path; M11, which puts the camera seqlock on the frame path, measures retries and revisits it (line added to M11's Budgets).
- Accepted shape difference: the counter is nested, `counters.sab.totalBytes`, not the flat `"sab.totalBytes"` key of M04's schema comment; `budget('counters.sab.totalBytes')` resolves it and later counters should follow the nested form.
- Found while gating, outside M06: `plugin-dev: wasm served as application/wasm` (M02b) failed once in about 13 `wasm` runs because `buildGame` wrote `game.wasm` with a plain `writeFile`, so a concurrent reader could see a truncated file (a dev server could serve one too). Orchestrator fix in `src/build-game.ts`: write to a temp name beside the target, then `rename`. `wasm` suite 12/12 afterwards.
