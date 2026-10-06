// The control block: one `SharedArrayBuffer` shared by every thread (docs/decisions/0015-threads-
// memory-and-topology.md §2 "Wake-ups"; docs/plan/06-sab-primitives-and-workers.md, Planning
// decisions "Control-block layout"). `Int32Array[64]`: four global words, then seven 8-word
// per-worker blocks (four used). The wake word is per *consumer thread*, not per ring (0024 §10):
// a worker with several input rings still blocks on one address.

// docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Deviations): `CB_LINK_STATE`/
// `CB_LINK_GEN` below were planned as "global words 4-5" (M06's own original layout: "4-7
// reserved"), but every one of those four words was claimed by an intervening milestone
// (`CB_TEST_CONTROL` 4, `CB_SIM_STEP_REQ` 5, `CB_SIM_TICKS_RUN` 6, `CB_FORCE_SNAPSHOT_REQ` 7) long
// before this one landed -- there is no free global word left inside the original `Int32Array[64]`.
// Rather than renumber anything already in use (this brief's own explicit instruction) or repurpose
// a per-worker field with an unrelated meaning for one specific worker kind, this appends two new
// global words *after* the existing per-worker region: `WORKER_BASE`/`WORKER_STRIDE`/`MAX_WORKERS`
// are unchanged, so every existing `workerWord(...)` address (and `control.workerWord addressing`'s
// own pinned literals, `control.test.ts`) is untouched -- only the block's own total size grows.
export const CONTROL_BLOCK_INT32S = 74
export const CONTROL_BLOCK_BYTES = CONTROL_BLOCK_INT32S * 4

// Global words (indices 0-7, all now used as of `CB_FORCE_SNAPSHOT_REQ` below).
export const CB_VERSION = 0
export const CB_LIFECYCLE = 1
export const CB_FRAME_REQ = 2
export const CB_FLAGS = 3
/** Test-only negative-control target, read only by a worker whose setup carried `test.gcHook`
 * (docs/plan/06b-workers-and-spawn.md, orchestrator decision 2: no new `postMessage` type for the
 * zero-GC hook). `0` = no control armed; else `((workerIndex + 1) << 8) | kind`, `kind` a
 * `StepControl`-shaped value (1 = object, 2 = burst) applied by `src/worker/gc-hook.ts`. One global
 * word, not per-worker: `zeroGcSuite` arms at most one isolate's control at a time. */
export const CB_TEST_CONTROL = 4
/**
 * The sim worker's own step-tick request word (docs/plan/13-sim-host-tick-loop.md, Scope: "A
 * `CB_*` step-tick request word serves `stepTick`"), the same monotonic-counter shape as
 * `CB_FRAME_REQ` (`worker/client.ts`'s own `frameReq !== lastFrameReq` idiom): a caller
 * `Atomics.add`s the number of ticks wanted, then wakes `WORKER_HOST`; `worker/sim.ts`'s `body()`
 * diffs the word against what it last saw and runs that many ticks through `SimHost.stepTick`,
 * bypassing the real-time pacing timer entirely (deterministic, for `engine/test`'s `stepTick` and
 * `asHarness.stepTick`'s own generic per-call "run one tick" contract, not for production pacing,
 * which never touches this word). One global word, not per-worker: there is at most one `sim`/`net`
 * worker (`WORKER_HOST`) in any topology. */
export const CB_SIM_STEP_REQ = 5
/**
 * The sim worker's own `SimHostCounters.ticksRun`, mirrored by `worker/sim.ts`'s `body()` after
 * every pass (one `Atomics.store` of a Smi, allocation-free) so a test can watch real-time pacing
 * advance from main without parking the worker (docs/plan/16d-sim-pacing-under-external-wakes.md,
 * step 1: a park/resume per sample would itself perturb the pacing under test). Read-only for
 * everyone but the sim worker. One global word, same reasoning as `CB_SIM_STEP_REQ`. */
export const CB_SIM_TICKS_RUN = 6
/**
 * docs/plan/23-persistence-opfs-and-lifecycle.md step 6: the sim worker's own force-a-snapshot-now
 * request word, the same monotonic-counter shape as `CB_SIM_STEP_REQ` (a caller `Atomics.add`s 1,
 * then wakes `WORKER_HOST`; `worker/sim.ts`'s `body()` diffs it against what it last saw and calls
 * `persistence.snapshotNow()` once, unconditionally -- bypassing `sim_dirty()`'s own cadence guard,
 * the same "bypasses the real cadence" relationship `CB_SIM_STEP_REQ` has to real-time pacing).
 * `engine/test.forceSnapshot(client)` is the only caller: a real, deterministic snapshot inside a
 * zero-GC page's own measured window (`zero_gc_singleplayer_with_snapshot`, Planning decision 1),
 * without waiting on 1,200 real ticks or racing the periodic cadence's own timing. This was the last
 * free global word (`CONTROL_BLOCK_INT32S`'s own header comment: "seven 8-word per-worker blocks",
 * i.e. indices 0-7 global, 7 previously reserved). */
export const CB_FORCE_SNAPSHOT_REQ = 7

export const Lifecycle = { Booting: 0, Running: 1, Stopping: 2, Fatal: 3 } as const
export type Lifecycle = (typeof Lifecycle)[keyof typeof Lifecycle]

export const FLAG_REBASE = 1
export const FLAG_RENDERER_RESET = 2

// Per-worker block: `WORKER_BASE + WORKER_STRIDE * index + <field>`.
export const WORKER_BASE = 8
export const WORKER_STRIDE = 8
export const MAX_WORKERS = 7

export const W_WAKE = 0
export const W_YIELD = 1
export const W_PARKED = 2
export const W_READY = 3
export const W_ACK = 4
export const W_MEM_PAGES = 5
export const W_MEM_GROWS = 6
export const W_STATUS = 7

export const Ready = { No: 0, Yes: 1, Dead: 2 } as const
export type Ready = (typeof Ready)[keyof typeof Ready]

/**
 * docs/plan/29-net-worker-and-reference-server.md steps 1-2 (Seams): appended after the per-worker
 * region (this file's own header comment above `CONTROL_BLOCK_INT32S`), indices 64-65. Written only
 * by the `net`-kind worker (`worker/net.ts`), mirroring its own `createLink`'s `LinkState`/`gen`
 * exactly (`net/link.ts`): `CB_LINK_STATE` holds the same numeric values as that module's own
 * `LinkState` (`Down = 0, Up = 1, Stopped = 2`) -- not imported here (`sab/` stays below `net/` in
 * the dependency order), just numerically identical by construction, so `worker/net.ts` can write
 * `link.state` straight into this word with no translation. `CB_LINK_GEN` counts every dial of
 * every `Link` the net worker builds (docs/plan/30c-ci-reds-after-m30.md: not `createLink`'s own
 * per-`Link` generation, which restarts at 1 on a version-mismatch `retry`). Read by the
 * `client`-kind worker (`worker/client-net.ts`, only when `SetupMessage.remoteLinked` is set) to
 * decide when it is safe to send `client_hello()` for the first time over a multiplayer topology --
 * before this word ever reads `Up` there is no net worker `Connection` yet for the uplink ring's
 * bytes to reach. Both `0` (`LinkState.Down`) until the net worker's very first `dial()`. Never
 * written or read for a `local`-host (single-player, sim-linked) topology, which has no net worker
 * at all -- these two words simply stay `0` there, and nothing consults them.
 */
export const CB_LINK_STATE = 64
export const CB_LINK_GEN = 65

/**
 * docs/plan/36-slow-tier-and-benchmarks.md step 6: the bench HUD's worker timings (appended after
 * `CB_LINK_GEN`, indices 66-68; same reasoning as that pair). Written only by a worker whose setup
 * carried `test.timing` (the bench build's page, never a shipped one): the client worker after each
 * `frame()` call (`CB_CLIENT_FRAME_US` = the call's duration in whole microseconds, then
 * `CB_CLIENT_FRAME_N` += 1) and the sim worker after a pass that ran a tick (`CB_SIM_TICK_US` = that
 * pass's tick duration in microseconds, stored before `CB_SIM_TICKS_RUN`). Main reads them with
 * `Atomics.load`; a counter that moved since the last read means the duration word is new.
 */
export const CB_CLIENT_FRAME_US = 66
export const CB_CLIENT_FRAME_N = 67
export const CB_SIM_TICK_US = 68

/**
 * docs/plan/39o-large-save-tick-breakdown.md: the parts of that same timed pass (indices 69-73), written
 * by the sim worker before `CB_SIM_TICK_US`, only under `test.timing`. Whole microseconds each:
 * `CB_SIM_SEAL_US` (`sim_seal_frame`), `CB_SIM_ONETICK_US` (`sim_tick`), `CB_SIM_FRAME_US` (the frame
 * build and send over every connection), all three of the pass's own paced tick (catch-up ticks
 * excluded); `CB_SIM_RESYNC_US` (the whole `resync()` of this pass, 0 when it ran none, catch-up ticks
 * and warming included) and `CB_SIM_CATCHUP` (the catch-up ticks that resync ran).
 */
export const CB_SIM_SEAL_US = 69
export const CB_SIM_ONETICK_US = 70
export const CB_SIM_FRAME_US = 71
export const CB_SIM_RESYNC_US = 72
export const CB_SIM_CATCHUP = 73

/** Slots of `SimHost.profile` (`server.ts`), in the order of the control words above. */
export const PROFILE_SEAL = 0
export const PROFILE_TICK = 1
export const PROFILE_FRAME = 2
export const PROFILE_RESYNC = 3
export const PROFILE_CATCHUP = 4
export const PROFILE_SLOTS = 5

// Worker indexes (docs/plan/06-sab-primitives-and-workers.md, Seams).
export const WORKER_CLIENT = 0
export const WORKER_HOST = 1 // sim or net
export const WORKER_GEN0 = 2
export const WORKER_GEN1 = 3

/** Absolute word index of `field` in worker `index`'s block. */
export function workerWord(index: number, field: number): number {
  return WORKER_BASE + WORKER_STRIDE * index + field
}

export function createControlBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(CONTROL_BLOCK_BYTES)
}

/**
 * The control block. `words` is public so a later milestone can read/write any field (`Ack`,
 * `Yield`, memory counters, …) with `Atomics` directly; this class owns only the two operations
 * every producer/consumer pair needs.
 */
export class ControlBlock {
  readonly words: Int32Array

  constructor(sab: SharedArrayBuffer) {
    this.words = new Int32Array(sab)
  }

  /** Producer side, called after a commit: bump the consumer's wake word and notify it. */
  wake(index: number): void {
    const at = workerWord(index, W_WAKE)
    Atomics.add(this.words, at, 1)
    Atomics.notify(this.words, at)
  }

  /**
   * Consumer side: block until the wake word differs from `last`, or `timeoutMs` elapses. Cannot
   * lose a wake-up: if `wake()` already ran between the caller's own load and this call,
   * `Atomics.wait` sees the mismatch and returns immediately instead of blocking.
   *
   * Deliberately returns nothing (docs/plan/11-camera-and-input.md step 7, Deviations, "fix 1"):
   * `runBlockingLoop` used to discard this method's own return value and then re-read the same
   * word a second time with its own separate `Atomics.load` one line later -- a genuine redundant
   * native call on every single wake, removed here (the caller now does the one load it always
   * needed anyway). A real cleanup on its own merits, and nothing more: it did not move the byte
   * total that motivated it.
   *
   * This method's body is pinned to that one statement by `sab/no-alloc-syntax.test.ts`'s
   * `sab.wait_for_wake_shape` -- `worker/shell.ts` blocks only through here, so ordinary hot-path
   * discipline. It is no longer load-bearing for the zero-GC instrument: the ~13.5 KB this frame
   * was once blamed for is a one-off V8 JIT code-installation burst billed to whichever frame
   * happens to be executing (measured on seven different ones, `waitForWake` among them), which
   * docs/decisions/0028-zero-gc-two-measured-windows.md separates by measuring two windows and
   * taking the lower total, not by excluding any name.
   */
  waitForWake(index: number, last: number, timeoutMs: number): void {
    Atomics.wait(this.words, workerWord(index, W_WAKE), last, timeoutMs)
  }
}
