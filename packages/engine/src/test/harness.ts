// `engine/test`: the harness worker driver (docs/plan/03-browser-harness.md, Seams and Planning
// decisions). Own module under `src/test/`, never imported by production code (0017 §2). Spawns one
// dedicated harness worker per spec (pattern A shape, 0017 §3), drives it over a per-worker step
// block (`step-block.ts`) plus `postMessage`.
import { Role, type Status } from '../abi.js'
import type { InstanceConfig } from '../loader.js'
import { createManualClock, type ManualClock } from './manual-clock.js'
import type { FromWorker, ToWorker } from './protocol.js'
import { createStepBlock, StepBlockField, StepOp, stepBlockView } from './step-block.js'

/** Busy-wait ceiling for an ack: the spike's ack-timeout guard (spikes/zero-gc-webgpu/public/main.js). */
const SPIN_LIMIT = 2_000_000_000

export type HarnessWorkerSpec = { name: string; role: Role; config: InstanceConfig }

export interface Harness {
  readonly clock: ManualClock
  /** Every sim-role worker runs one `sim_tick`; returns when all have acknowledged. Synchronous and
   * allocation-free once every target worker is resumed. */
  stepTick(): void
  /** `clock.frame(dtMs)` on main, then one step of every client-role worker (none exist before
   * M06b: main-only for now). */
  stepFrame(dtMs: number): void
  /** Workers enter their blocking wait loop; resolves once every one reports blocked-and-ready. */
  resume(): Promise<void>
  /** Workers return to their event loops so messages and CDP reach them. */
  park(): Promise<void>
  /** The awaitable cross-thread quiescence point of 0020 §8: resolves once every worker has
   * acknowledged every request and is parked. */
  untilQuiescent(): Promise<void>
  /** Requires the worker parked (`park()` first): `hash`/`admit`/`memoryBytes`/`memGrows` travel by
   * `postMessage`, which a worker blocked in `Atomics.wait` cannot receive. */
  hash(worker: string): Promise<string>
  admit(worker: string, bytes: Uint8Array): Promise<Status>
  memoryBytes(): Promise<Record<string, number>>
  memGrows(): Promise<Record<string, number>>
  errors(): string[]
  dispose(): void
}

type Pending = {
  replyType: FromWorker['type']
  resolve: (m: FromWorker) => void
  reject: (e: Error) => void
}

type WorkerHandle = {
  name: string
  role: Role
  worker: Worker
  sab: Int32Array
  seq: number
  armed: boolean
  pending: Pending | null
}

function setupWorker(
  spec: HarnessWorkerSpec,
  module: WebAssembly.Module,
  handles: Map<string, WorkerHandle>,
  errors: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sabBuffer = createStepBlock()
    const worker = new Worker(new URL('./harness-worker.js', import.meta.url), {
      type: 'module',
      name: spec.name,
    })
    const handle: WorkerHandle = {
      name: spec.name,
      role: spec.role,
      worker,
      sab: stepBlockView(sabBuffer),
      seq: 0,
      armed: false,
      pending: null,
    }
    worker.onerror = (e) => reject(new Error(`harness worker '${spec.name}' error: ${e.message}`))
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data
      if (m.type === 'error') {
        errors.push(`${spec.name}: ${m.message}`)
        return
      }
      const pending = handle.pending
      if (!pending) return
      if (m.type === 'setupError') {
        handle.pending = null
        pending.reject(new Error(`harness worker '${spec.name}': ${m.message}`))
        return
      }
      if (m.type === pending.replyType) {
        handle.pending = null
        pending.resolve(m)
      }
    }
    handle.pending = { replyType: 'ready', resolve: () => resolve(), reject }
    handles.set(spec.name, handle)
    const setup: ToWorker = {
      type: 'setup',
      module,
      name: spec.name,
      role: spec.role,
      config: spec.config,
      sab: sabBuffer,
    }
    worker.postMessage(setup)
  })
}

async function loadModule(wasm: { url: string } | WebAssembly.Module): Promise<WebAssembly.Module> {
  if (wasm instanceof WebAssembly.Module) return wasm
  return WebAssembly.compileStreaming(fetch(wasm.url))
}

export async function createHarness(opts: {
  wasm: { url: string; buildHash: string } | WebAssembly.Module
  workers: HarnessWorkerSpec[]
  clock?: ManualClock
}): Promise<Harness> {
  for (const spec of opts.workers) {
    if (spec.name === 'main') throw new Error("createHarness: worker name 'main' is reserved")
  }
  const module = await loadModule(opts.wasm)
  const clock = opts.clock ?? createManualClock()
  const errors: string[] = []
  const handles = new Map<string, WorkerHandle>()

  await Promise.all(opts.workers.map((spec) => setupWorker(spec, module, handles, errors)))

  const all = (): WorkerHandle[] => [...handles.values()]
  const byRole = (role: Role): WorkerHandle[] => all().filter((h) => h.role === role)

  function findWorker(name: string): WorkerHandle {
    const h = handles.get(name)
    if (!h) throw new Error(`harness: no worker named '${name}'`)
    return h
  }

  function requireParked(h: WorkerHandle, what: string): void {
    if (h.armed)
      throw new Error(`harness: worker '${h.name}' is armed; call park() first (${what})`)
  }

  function wake(h: WorkerHandle, op: number): void {
    h.seq++
    Atomics.store(h.sab, StepBlockField.Op, op)
    Atomics.store(h.sab, StepBlockField.Req, h.seq)
    Atomics.notify(h.sab, StepBlockField.Req)
  }

  function awaitAck(h: WorkerHandle): void {
    let spins = 0
    while (Atomics.load(h.sab, StepBlockField.Ack) !== h.seq) {
      if (++spins > SPIN_LIMIT) {
        throw new Error(`harness: worker '${h.name}' did not ack a step (resume() first?)`)
      }
    }
  }

  function stepAll(role: Role, op: number): void {
    const targets = byRole(role)
    for (const h of targets) {
      if (!h.armed) throw new Error(`harness: worker '${h.name}' is not resumed`)
      wake(h, op)
    }
    for (const h of targets) awaitAck(h)
  }

  function send<T extends FromWorker['type']>(
    h: WorkerHandle,
    msg: ToWorker,
    replyType: T,
  ): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve, reject) => {
      h.pending = { replyType, resolve: resolve as (m: FromWorker) => void, reject }
      h.worker.postMessage(msg)
    })
  }

  async function resumeOne(h: WorkerHandle): Promise<void> {
    if (h.armed) return
    await send(h, { type: 'resume' }, 'armed')
    h.armed = true
  }

  /** Wakes a worker blocked in `Atomics.wait` without touching `Req`/`Ack` (`Atomics.wait` returns
   * "ok" on any `notify`, whatever the word's value): keeps `Req === Ack` true across a park. */
  async function parkOne(h: WorkerHandle): Promise<void> {
    if (!h.armed) return
    const reply = new Promise<void>((resolve, reject) => {
      h.pending = { replyType: 'parked', resolve: () => resolve(), reject }
    })
    Atomics.store(h.sab, StepBlockField.Yield, 1)
    Atomics.notify(h.sab, StepBlockField.Req)
    await reply
    h.armed = false
  }

  return {
    clock,

    stepTick() {
      stepAll(Role.Sim, StepOp.Tick)
    },
    stepFrame(dtMs) {
      clock.frame(dtMs)
      stepAll(Role.Client, StepOp.Frame)
    },

    async resume() {
      await Promise.all(all().map(resumeOne))
    },
    async park() {
      await Promise.all(all().map(parkOne))
    },
    async untilQuiescent() {
      await Promise.all(all().map(parkOne))
    },

    async hash(name) {
      const h = findWorker(name)
      requireParked(h, 'hash')
      const reply = await send(h, { type: 'hash' }, 'hash')
      return reply.value
    },
    async admit(name, bytes) {
      const h = findWorker(name)
      requireParked(h, 'admit')
      const reply = await send(h, { type: 'admit', bytes }, 'admit')
      return reply.status as Status
    },
    async memoryBytes() {
      const out: Record<string, number> = {}
      await Promise.all(
        all().map(async (h) => {
          requireParked(h, 'memoryBytes')
          out[h.name] = (await send(h, { type: 'memory' }, 'memory')).bytes
        }),
      )
      return out
    },
    async memGrows() {
      const out: Record<string, number> = {}
      await Promise.all(
        all().map(async (h) => {
          requireParked(h, 'memGrows')
          out[h.name] = (await send(h, { type: 'memGrows' }, 'memGrows')).grows
        }),
      )
      return out
    },

    errors() {
      return [...errors]
    },
    dispose() {
      for (const h of all()) h.worker.terminate()
    },
  }
}
