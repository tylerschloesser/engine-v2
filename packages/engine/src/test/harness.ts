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

export type HarnessWorkerSpec = {
  name: string
  role: Role
  config: InstanceConfig
  /** M04 (docs/plan/04-zero-gc-harness.md, Seams): drives `coreTick`'s fixed-block SAB<->region
   * copy every tick, instead of a bare `sim_tick`. */
  rxTx?: { rx: SharedArrayBuffer; tx: SharedArrayBuffer }
}

export interface Harness {
  readonly clock: ManualClock
  /** Names of every worker, in the order given to `createHarness` ('main' is reserved and never
   * included: docs/plan/04-zero-gc-harness.md, Seams). */
  readonly workerNames: string[]
  /** Every sim-role worker runs one `sim_tick`; returns when all have acknowledged. Synchronous and
   * allocation-free once every target worker is resumed. */
  stepTick(): void
  /** `clock.frame(dtMs)` on main, then one step of every client-role worker (none exist before
   * M06b: main-only for now). */
  stepFrame(dtMs: number): void
  /** Workers enter their blocking wait loop; resolves once every one reports blocked-and-ready.
   * `opts.except` (M04) leaves the named workers idle instead -- the `post-message` negative
   * control drives them by plain `postMessage` (`messageTick`), which a worker blocked in
   * `Atomics.wait` cannot receive. */
  resume(opts?: { except?: string[] }): Promise<void>
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
  /** M04: one tick by message round trip (docs/plan/04-zero-gc-harness.md, Seams, `post-message`
   * negative control). Valid only for a worker excluded from `resume()` (never armed), so it is
   * reachable through its normal event loop. */
  messageTick(worker: string): Promise<void>
  /** M04: every worker emits `performance.mark('gc-isolate:<name>')` (Planning decisions "Naming
   * isolates"). Requires every worker parked. */
  markIsolates(): Promise<void>
  /** M04: writes a `StepControl` into a worker's step block (`step-block.ts`); read fresh on its
   * next tick, so this is safe to call while parked (the usual case) or armed. */
  setWorkerControl(worker: string, control: number): void
  /** M04: `typeof gc === 'function'` in each worker's own isolate, captured at setup
   * (`--js-flags=--expose-gc`, 0016 §3). Main's own is a plain page-side check (not through the
   * harness: `installGcPage` does it directly). */
  workerGcExposed(): Record<string, boolean>
  errors(): string[]
  dispose(): void
}

/** M18c (docs/plan/18c-stepping-hash-under-load.md): diagnostic only, so a `stepping.spec.ts` hash
 * mismatch can explain itself instead of guessing -- deliberately not folded into `Harness` above
 * (Seams: this milestone provides nothing new there). `src/test/client.ts`'s `asHarness` (the
 * production-topology counterpart) does not implement this; only `createHarness`'s own harness
 * does, which is why it is a separate intersected type rather than a new `Harness` method. */
export interface HarnessDebug {
  /** Requires the worker parked, like `hash`/`admit`/`memoryBytes`/`memGrows`. `ticksRun` comes
   * from the worker itself (a message round trip, never inferred from `req`/`ack`): those two are
   * set unconditionally by the worker's loop regardless of how many times it actually ticked, so
   * this is the only way a lost or duplicated tick is visible. `req`/`ack`/`state`/`yieldFlag` are
   * the step block's own words (`step-block.ts`'s `StepBlockField`), read directly since they are
   * shared memory -- `state` is a `WorkerState` value and doubles as "was this worker really
   * parked (`WorkerState.Idle`) at the moment this was called". */
  debugSnapshot(worker: string): Promise<{
    ticksRun: number
    req: number
    ack: number
    state: number
    yieldFlag: number
  }>
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
  /** From the worker's `ready` message; `false` until setup resolves. */
  gcExposed: boolean
}

// M16f (docs/plan/16f-harness-waits-and-sibling-burst.md): every wait below now fails within a
// bound instead of hanging (M16e's own finding: `gc-loop clean` once hit a bare 30 s Playwright
// timeout inside this file's `resume`/`park`, docs/plan/16e-park-timeout-diagnosis.md, Deviations
// "Two natural occurrences"). `POLL_TIMEOUT_MS` matches the bound `src/test/client.ts`'s
// `pollUntil` already uses; `awaitAck`'s spin keeps its own pre-existing `SPIN_LIMIT`
// iteration-count bound unchanged (Non-scope) -- only its failure message gains detail. The failure
// message reuses M16e's shape (`<what>: timed out after <n> [ms|spins] ... workers=[...]`) built
// only in the reject/throw branch, but names this harness's own step-block fields (`Req`/`Ack`/
// `State`/`Yield`, `step-block.ts`) rather than `sab/control.ts`'s `W_*` words: a different
// protocol, per M16e's own Deviations ("not in this milestone's Files list"). A message-wait here
// (`setupWorker`/`send`/`parkOne`) is a single `setTimeout`, not a macrotask poll, so it has no
// `turns`/`longestGapMs` to report the way `pollUntil` does -- just the bound and the per-worker
// snapshot at the moment it fired.
const POLL_TIMEOUT_MS = 10_000

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Per-worker state for a timeout's failure message, read only when a wait is about to fail.
 * `Yield` is the park flag (1 = a park was requested of this worker); `Waits` (M19b,
 * docs/plan/19b-sim-park-while-armed.md) is `armedLoop`'s own per-wait counter, read straight off
 * the SAB the same way the other fields are -- a worker stuck in `Atomics.wait` cannot answer a
 * message, so this is the only way to see "stuck on its very first wait" versus "stuck after N". */
type WorkerDiag = {
  name: string
  Req: number
  Ack: number
  State: number
  Yield: number
  Waits: number
  armed: boolean
}

function diagWorkers(handles: Map<string, WorkerHandle>): WorkerDiag[] {
  const out: WorkerDiag[] = []
  for (const h of handles.values()) {
    out.push({
      name: h.name,
      Req: Atomics.load(h.sab, StepBlockField.Req),
      Ack: Atomics.load(h.sab, StepBlockField.Ack),
      State: Atomics.load(h.sab, StepBlockField.State),
      Yield: Atomics.load(h.sab, StepBlockField.Yield),
      Waits: Atomics.load(h.sab, StepBlockField.Waits),
      armed: h.armed,
    })
  }
  return out
}

/** A message-wait's timeout (`setupWorker`/`send`/`parkOne`): see the block comment above `WorkerHandle`. */
function describeTimeout(
  handles: Map<string, WorkerHandle>,
  what: string,
  limitMs: number,
): string {
  return `${what}: timed out after ${limitMs} ms workers=${JSON.stringify(diagWorkers(handles))}`
}

/** `awaitAck`'s own message, once `spins` has already exceeded `SPIN_LIMIT`: same shape
 * `spinTimeoutMessage` uses in `src/test/client.ts` (M16e, CI round) -- iteration-count bound on
 * the success path, `now()` read exactly once, only here, never on a periodic check. */
function spinTimeoutMessage(
  handles: Map<string, WorkerHandle>,
  what: string,
  spins: number,
): string {
  return (
    `${what}: timed out after ${spins} spins (limit ${SPIN_LIMIT}, detectedAtMs=${now().toFixed(1)}) ` +
    `workers=${JSON.stringify(diagWorkers(handles))}`
  )
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
      gcExposed: false,
    }
    const timer = setTimeout(() => {
      handle.pending = null
      reject(
        new Error(describeTimeout(handles, `harness worker '${spec.name}' setup`, POLL_TIMEOUT_MS)),
      )
    }, POLL_TIMEOUT_MS)
    worker.onerror = (e) => {
      clearTimeout(timer)
      reject(new Error(`harness worker '${spec.name}' error: ${e.message}`))
    }
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
        clearTimeout(timer)
        pending.reject(new Error(`harness worker '${spec.name}': ${m.message}`))
        return
      }
      if (m.type === pending.replyType) {
        handle.pending = null
        clearTimeout(timer)
        pending.resolve(m)
      }
    }
    handle.pending = {
      replyType: 'ready',
      resolve: (m) => {
        if (m.type === 'ready') handle.gcExposed = m.gcExposed
        resolve()
      },
      reject,
    }
    handles.set(spec.name, handle)
    const setup: ToWorker = {
      type: 'setup',
      module,
      name: spec.name,
      role: spec.role,
      config: spec.config,
      sab: sabBuffer,
      ...(spec.rxTx ? { rxTx: spec.rxTx } : {}),
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
}): Promise<Harness & HarnessDebug> {
  for (const spec of opts.workers) {
    if (spec.name === 'main') throw new Error("createHarness: worker name 'main' is reserved")
  }
  const module = await loadModule(opts.wasm)
  const clock = opts.clock ?? createManualClock()
  const errors: string[] = []
  const handles = new Map<string, WorkerHandle>()

  await Promise.all(opts.workers.map((spec) => setupWorker(spec, module, handles, errors)))

  const all = (): WorkerHandle[] => [...handles.values()]
  // M04 (docs/plan/04-zero-gc-harness.md, measured): `stepAll` runs every tick/frame in the gc
  // suite's measured window; `byRole` used to be `all().filter(...)`, allocating two fresh arrays
  // per call (~250 B/frame of the gc-loop `main` budget, dominating it). Grouped once here instead
  // (.claude/rules/hot-paths.md, even though src/test/** is exempt from the rule itself: the
  // allocation is real and this milestone measures it).
  const EMPTY_HANDLES: WorkerHandle[] = []
  const roleGroups = new Map<Role, WorkerHandle[]>()
  for (const h of handles.values()) {
    const group = roleGroups.get(h.role)
    if (group) group.push(h)
    else roleGroups.set(h.role, [h])
  }
  const byRole = (role: Role): WorkerHandle[] => roleGroups.get(role) ?? EMPTY_HANDLES

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
    // M19b step 3 (docs/plan/19b-sim-park-while-armed.md): `Wake`, not `Req`, is what `armedLoop`
    // blocks on -- see `step-block.ts`'s own doc comment on that field for why `Req`'s own notify
    // was not enough on its own (it is, for a real step: the value always changes; the field exists
    // for `parkOne`, which cannot say the same).
    Atomics.add(h.sab, StepBlockField.Wake, 1)
    Atomics.notify(h.sab, StepBlockField.Wake)
  }

  function awaitAck(h: WorkerHandle): void {
    let spins = 0
    while (Atomics.load(h.sab, StepBlockField.Ack) !== h.seq) {
      if (++spins > SPIN_LIMIT) {
        throw new Error(
          spinTimeoutMessage(
            handles,
            `harness: worker '${h.name}' did not ack a step (resume() first?)`,
            spins,
          ),
        )
      }
    }
  }

  function stepAll(role: Role, op: number): void {
    const targets = byRole(role)
    // Index loops, not `for...of`: measured to avoid an iterator-protocol allocation V8 otherwise
    // takes on this path (docs/plan/04-zero-gc-harness.md).
    for (let i = 0; i < targets.length; i++) {
      const h = targets[i] as WorkerHandle
      if (!h.armed) throw new Error(`harness: worker '${h.name}' is not resumed`)
      wake(h, op)
    }
    for (let i = 0; i < targets.length; i++) awaitAck(targets[i] as WorkerHandle)
  }

  function send<T extends FromWorker['type']>(
    h: WorkerHandle,
    msg: ToWorker,
    replyType: T,
  ): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        h.pending = null
        reject(
          new Error(
            describeTimeout(handles, `send('${msg.type}') to worker '${h.name}'`, POLL_TIMEOUT_MS),
          ),
        )
      }, POLL_TIMEOUT_MS)
      h.pending = {
        replyType,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m as Extract<FromWorker, { type: T }>)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      h.worker.postMessage(msg)
    })
  }

  async function resumeOne(h: WorkerHandle): Promise<void> {
    if (h.armed) return
    await send(h, { type: 'resume' }, 'armed')
    h.armed = true
  }

  /** Wakes a worker blocked in `Atomics.wait` without touching `Req`/`Ack`: keeps `Req === Ack`
   * true across a park. M19b step 3 (docs/plan/19b-sim-park-while-armed.md): the notify targets
   * `Wake` (bumped, not just notified -- `step-block.ts`'s own doc comment on that field), the same
   * word `armedLoop` blocks on for a real step request, so this signal is self-healing regardless of
   * exactly when `armedLoop`'s own thread reaches its next `Atomics.wait` call. It used to notify
   * `Req` itself, unchanged (`Atomics.wait` returns "ok" on any notify, whatever the word's value) --
   * safe only for a waiter *already registered* at the moment of the one notify, and silently lost
   * for one caught between its own `Yield` check and actually registering, with nothing left to send
   * a second notify. */
  async function parkOne(h: WorkerHandle): Promise<void> {
    if (!h.armed) return
    const reply = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        h.pending = null
        reject(new Error(describeTimeout(handles, `park('${h.name}')`, POLL_TIMEOUT_MS)))
      }, POLL_TIMEOUT_MS)
      h.pending = {
        replyType: 'parked',
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
    })
    Atomics.store(h.sab, StepBlockField.Yield, 1)
    Atomics.add(h.sab, StepBlockField.Wake, 1)
    Atomics.notify(h.sab, StepBlockField.Wake)
    await reply
    h.armed = false
  }

  return {
    clock,
    workerNames: opts.workers.map((s) => s.name),

    stepTick() {
      stepAll(Role.Sim, StepOp.Tick)
    },
    stepFrame(dtMs) {
      clock.frame(dtMs)
      stepAll(Role.Client, StepOp.Frame)
    },

    async resume(resumeOpts) {
      const except = new Set(resumeOpts?.except ?? [])
      await Promise.all(
        all()
          .filter((h) => !except.has(h.name))
          .map(resumeOne),
      )
    },
    async park() {
      await Promise.all(all().map(parkOne))
    },
    async untilQuiescent() {
      await Promise.all(all().map(parkOne))
    },
    async messageTick(name) {
      const h = findWorker(name)
      await send(h, { type: 'pmTick' }, 'pmTick')
    },
    async markIsolates() {
      await Promise.all(all().map((h) => send(h, { type: 'markIsolate' }, 'markedIsolate')))
    },
    setWorkerControl(name, control) {
      const h = findWorker(name)
      Atomics.store(h.sab, StepBlockField.Control, control)
    },
    workerGcExposed() {
      const out: Record<string, boolean> = {}
      for (const h of all()) out[h.name] = h.gcExposed
      return out
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

    async debugSnapshot(name) {
      const h = findWorker(name)
      requireParked(h, 'debugSnapshot')
      const reply = await send(h, { type: 'ticks' }, 'ticks')
      return {
        ticksRun: reply.count,
        req: Atomics.load(h.sab, StepBlockField.Req),
        ack: Atomics.load(h.sab, StepBlockField.Ack),
        state: Atomics.load(h.sab, StepBlockField.State),
        yieldFlag: Atomics.load(h.sab, StepBlockField.Yield),
      }
    },

    errors() {
      return [...errors]
    },
    dispose() {
      for (const h of all()) h.worker.terminate()
    },
  }
}
