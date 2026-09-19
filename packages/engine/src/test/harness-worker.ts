// The test-only harness worker (docs/plan/03-browser-harness.md, Planning decisions: "The harness
// worker is its own module under src/test/, not a kind of the production worker"). Spawned by
// `harness.ts` with `new Worker(new URL('./harness-worker.js', import.meta.url), { type: 'module',
// name })` (pattern A shape, 0017 §3). Receives the compiled `Module` by `postMessage`, instantiates
// it with the M02 loader, sets `self.__engineIsolateName`, and serves `resume`/`hash`/`admit`/
// `memory` plus the blocking loop (0015 §2). Never part of a production bundle.
import { RegionId, Status } from '../abi.js'
import { type EngineInstance, instantiate } from '../loader.js'
import type { FromWorker, ToWorker } from './protocol.js'
import { StepBlockField, StepOp, stepBlockView, WorkerState } from './step-block.js'

// `tsconfig.json` has no `webworker` lib (it would fight `dom`'s incompatible `self`/`postMessage`
// declarations); the spike's worker files (spikes/vite-lib-worker-wasm) used the same cast.
const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
  __engineIsolateName?: string
}

let inst: EngineInstance | undefined
let sab: Int32Array | undefined

function post(m: FromWorker): void {
  scope.postMessage(m)
}

function runOp(op: number): void {
  if (!inst) return
  try {
    if (op === StepOp.Tick) inst.call0(inst.x.sim_tick)
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
  post({ type: 'armed' })
  for (;;) {
    Atomics.wait(block, StepBlockField.Req, last)
    if (Atomics.load(block, StepBlockField.Yield)) break
    last = Atomics.load(block, StepBlockField.Req)
    Atomics.store(block, StepBlockField.State, WorkerState.Busy)
    runOp(Atomics.load(block, StepBlockField.Op))
    Atomics.store(block, StepBlockField.State, WorkerState.Armed)
    Atomics.store(block, StepBlockField.Ack, last)
  }
  Atomics.store(block, StepBlockField.Yield, 0)
  Atomics.store(block, StepBlockField.State, WorkerState.Idle)
  post({ type: 'parked' })
}

scope.onmessage = (ev) => {
  const m = ev.data
  if (m.type === 'setup') {
    scope.__engineIsolateName = m.name
    sab = stepBlockView(m.sab)
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
      post({ type: 'ready' })
    } catch (e) {
      post({ type: 'setupError', message: e instanceof Error ? e.message : String(e) })
    }
  } else if (m.type === 'resume') {
    if (sab) armedLoop(sab)
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
