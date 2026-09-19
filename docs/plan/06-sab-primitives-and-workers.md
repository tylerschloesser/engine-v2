# M06: SAB primitives, control block, camera block

Status: not started · After: 04 · Tyler-dependent: no

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
- [ ] Every test above passes by name; `drops` and `torn` read 0.
- [ ] No function in `src/sab/` or `src/camera/block.ts` contains `new`, a closure, an array or object literal, or `subarray` outside a constructor (checked by a small source-scan unit test, `sab.no_alloc_syntax`).
- [ ] `.claude/rules/hot-paths.md` globs cover `src/sab/**` and `src/camera/**`.
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test unit -t ring` · `pnpm test unit -t seqlock` · `pnpm test unit -t triple` · `pnpm test unit -t control` · `pnpm test browser -t sab.ring_both_directions` · `pnpm test` · `pnpm lint` (`-t` is a substring match, M01).

## Budgets
- Memory, whole tab: SABs ≈ 12 MiB (0015 §5). Measured by `layout.sab_total_under_budget` against `counters["sab.totalBytes"]` in `packages/engine/budgets.json` (M04's file and `expectWithinBudget`).
- Allocation per isolate: these functions must contribute 0 B; the measuring pages are M06b's `topology` and `echo`.

## Context artifacts
- `.claude/rules/hot-paths.md` (created by M02, verification line added by M04): add the globs `packages/engine/src/sab/**`, `packages/engine/src/camera/**`, and, so that M06b, M09 and M11 find the rule on their first read, `packages/engine/src/worker/**`, `packages/engine/src/render/**`, `packages/engine/src/input/**`, `packages/engine/src/overlay/**`. Add the rules this code introduces: views, descriptors and event objects are created in constructors and mutated afterwards; no `subarray`, closures or literals on a per-frame, per-tick or per-message path; no `postMessage` in steady state.
- `packages/engine/CLAUDE.md`: one line for `src/sab/` (which shape to use when: ring = reliable stream, seqlock = small latest-wins record, triple buffer = large latest-wins frame).

## Manual device checks
None.

## Deviations
(filled in during Phase 3)
