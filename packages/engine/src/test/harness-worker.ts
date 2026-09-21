// The test-only harness worker (docs/plan/03-browser-harness.md, Planning decisions: "The harness
// worker is its own module under src/test/, not a kind of the production worker"). Spawned by
// `harness.ts` with `new Worker(new URL('./harness-worker.js', import.meta.url), { type: 'module',
// name })` (pattern A shape, 0017 §3). Receives the compiled `Module` by `postMessage`, instantiates
// it with the M02 loader, sets `self.__engineIsolateName`, and serves `resume`/`hash`/`admit`/
// `memory` plus the blocking loop (0015 §2). Never part of a production bundle.
import { RegionId, Status } from '../abi.js'
import { type EngineInstance, instantiate } from '../loader.js'
import { applyStepControl } from './controls.js'
import type { FromWorker, ToWorker } from './protocol.js'
import { StepBlockField, StepOp, stepBlockView, WorkerState } from './step-block.js'

// `tsconfig.json` has no `webworker` lib (it would fight `dom`'s incompatible `self`/`postMessage`
// declarations); the spike's worker files (spikes/vite-lib-worker-wasm) used the same cast.
const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
  __engineIsolateName?: string
  /** `--js-flags=--expose-gc` (docs/decisions/0016 §3): present per isolate, not just on main. */
  gc?: () => void
}

let inst: EngineInstance | undefined
let sab: Int32Array | undefined
// M04 (docs/plan/04-zero-gc-harness.md, Seams): preallocated views over the fixed-block SABs, when
// this worker was set up with `rxTx`. Never `subarray()`/re-created per tick (.claude/rules/hot-paths.md).
let rxView: Uint8Array | undefined
let txView: Uint8Array | undefined

function post(m: FromWorker): void {
  scope.postMessage(m)
}

// Preallocated, never mutated: `armedLoop` posts each of these exactly once per call (worker entry
// and exit, not per tick), but it is called fresh on every `harness.resume()`/`park()` round trip --
// `gc-page.ts`'s `run()` does one such round trip per invocation, and `instrument.ts` calls `run()`
// twice inside the measured windows (once per window) -- so a literal `{ type: 'armed' }`/`{ type:
// 'parked' }` built at the call site allocates once inside *each* window, identically, surviving
// 0028's lower-of-two-windows filter (which only removes an event confined to one window) and
// making `gc: flat transport parity`'s exact byte-for-byte comparison depend on which of two small,
// V8-internal-detail-sized byte counts a given session happened to land on (found via `windowByFn`,
// gc-parity defect-fix session, 2026-09-21: `armedLoop@harness-worker.ts` carrying the entire 8-byte
// discrepancy, present and stable in both windows, only its magnitude -- 32 vs 40 -- varying between
// independently-instantiated sessions). Neither message carries a per-call value (`protocol.ts`'s
// `FromWorker`), so both are ordinary module-level constants instead.
const ARMED: FromWorker = { type: 'armed' }
const PARKED: FromWorker = { type: 'parked' }

/** One tick's engine work, shared by the SAB step protocol and the `post-message` control's message
 * handler (docs/plan/04-zero-gc-harness.md, Seams): copy the fixed block SAB -> `Rx`, `sim_admit`,
 * `sim_tick`, `sim_build_frame`, copy the fixed frame block `Tx` -> SAB, through the view pairs
 * above (0014 §4: whole-block copies, no `subarray()`). A worker set up without `rxTx` (M03's
 * `stepping.html`) just ticks.
 *
 * `applyStepControl` fires as this function's own first statement (docs/plan/10-ci-workflow.md,
 * orchestrator's decision 1, 2026-09-21), not as a call sibling to it in `runOp` (where it lived
 * before and why `gc-loop`'s software-mode B never saw a worker control: `attributionRoots` names
 * `coreTick`, and a sibling call is not nested inside it). Mirrors `src/worker/{client,gen,sim}.ts`'s
 * `body()` calling `applyGcHook` first, the pattern already proven to attribute correctly. `n`
 * (`seq` from the SAB step protocol, `0` from the `post-message` handler below, where no real
 * `Control` is ever armed on this isolate at the same time) is only ever used to vary the control's
 * own retained object, never to gate whether it runs. */
function coreTick(n: number): void {
  if (!inst) return
  if (sab) applyStepControl(Atomics.load(sab, StepBlockField.Control), n)
  if (rxView && txView) {
    const rx = inst.region(RegionId.Rx)
    if (rx) rx.u8.set(rxView)
    inst.call2(inst.x.sim_admit, 0, rxView.length)
    inst.call0(inst.x.sim_tick)
    inst.call1(inst.x.sim_build_frame, 0)
    const tx = inst.region(RegionId.Tx)
    if (tx) txView.set(tx.u8)
  } else {
    inst.call0(inst.x.sim_tick)
  }
}

function runOp(op: number, seq: number): void {
  if (!inst) return
  try {
    if (op === StepOp.Tick) {
      coreTick(seq)
    }
    // Client-role stepping arrives with the client instance in M06b; nothing to do yet
    // (docs/plan/03-browser-harness.md, "What stepFrame means before a client worker exists").
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** Blocks the worker thread in `Atomics.wait`, serving step requests until yielded (0015 §2). */
function armedLoop(block: Int32Array): void {
  let last = Atomics.load(block, StepBlockField.Req)
  Atomics.store(block, StepBlockField.State, WorkerState.Armed)
  post(ARMED)
  for (;;) {
    Atomics.wait(block, StepBlockField.Req, last)
    if (Atomics.load(block, StepBlockField.Yield)) break
    last = Atomics.load(block, StepBlockField.Req)
    Atomics.store(block, StepBlockField.State, WorkerState.Busy)
    runOp(Atomics.load(block, StepBlockField.Op), last)
    Atomics.store(block, StepBlockField.State, WorkerState.Armed)
    Atomics.store(block, StepBlockField.Ack, last)
  }
  Atomics.store(block, StepBlockField.Yield, 0)
  Atomics.store(block, StepBlockField.State, WorkerState.Idle)
  post(PARKED)
}

scope.onmessage = (ev) => {
  const m = ev.data
  if (m.type === 'setup') {
    scope.__engineIsolateName = m.name
    sab = stepBlockView(m.sab)
    if (m.rxTx) {
      rxView = new Uint8Array(m.rxTx.rx)
      txView = new Uint8Array(m.rxTx.tx)
    }
    try {
      inst = instantiate(m.module, m.role, m.config, {
        onLog() {
          // Log text is decoded and handed to the hook in this isolate (Planning decisions); the
          // harness only surfaces panics and traps through errors().
        },
        onPanic(text) {
          post({ type: 'error', message: text })
        },
      })
      post({ type: 'ready', gcExposed: typeof scope.gc === 'function' })
    } catch (e) {
      post({ type: 'setupError', message: e instanceof Error ? e.message : String(e) })
    }
  } else if (m.type === 'resume') {
    if (sab) armedLoop(sab)
  } else if (m.type === 'markIsolate') {
    performance.mark(`gc-isolate:${scope.__engineIsolateName ?? ''}`)
    post({ type: 'markedIsolate' })
  } else if (m.type === 'pmTick') {
    try {
      // `0`: a `post-message`-controlled isolate is never simultaneously the target of the SAB
      // `Control` word (`gc-page.ts`'s `setControl` only calls `setWorkerControl` for a
      // non-`post-message` control), so `applyStepControl` is a no-op here regardless of `n`.
      coreTick(0)
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
      return
    }
    post({ type: 'pmTick' })
  } else if (m.type === 'hash') {
    if (!inst) return
    inst.call0(inst.x.sim_hash)
    post({ type: 'hash', value: inst.readU64Hex(RegionId.Result, 0) })
  } else if (m.type === 'admit') {
    if (!inst) return
    const rx = inst.region(RegionId.Rx)
    if (!rx) {
      post({ type: 'admit', status: Status.WrongRole })
      return
    }
    rx.u8.set(m.bytes)
    const status = inst.call2(inst.x.sim_admit, 0, m.bytes.length)
    post({ type: 'admit', status })
  } else if (m.type === 'memory') {
    post({ type: 'memory', bytes: inst ? inst.memoryBytes() : 0 })
  } else if (m.type === 'memGrows') {
    post({ type: 'memGrows', grows: inst ? inst.memGrows() : 0 })
  } else if (m.type === 'dispose') {
    self.close()
  }
}
