// `engine/worker`'s `run()`: hosts every worker kind of docs/decisions/0015-threads-memory-and-
// topology.md §1 in one script (0017 §2's "self-contained" is read as "no bare imports, no dynamic
// `import()`": relative imports of sibling files are fine, docs/plan/06b-workers-and-spawn.md,
// Planning decisions "Worker script layout"). The kind arrives in the setup message, so there is one
// worker script however many workers a topology spawns (pattern A/B, 0017 §3).
import { ControlBlock } from './sab/control.js'
import * as clientKind from './worker/client.js'
import * as genKind from './worker/gen.js'
import * as netKind from './worker/net.js'
import type { FromWorker, SetupMessage, ToWorker } from './worker/protocol.js'
import { createShell, type LoopState, runBlockingLoop, type Shell } from './worker/shell.js'
import * as simKind from './worker/sim.js'

export interface WorkerKindModule {
  /**
   * Instantiates (when this kind has WASM) and prepares this worker. Returns the loop to run once
   * `ready` has been posted, or `null` for a kind with no blocking loop (`net`). `runBlockingLoop`
   * itself blocks the thread synchronously (through `Atomics.wait`), so `run()` below posts `ready`
   * *before* starting it -- calling it from inside `setup` would mean this promise never settles
   * and `ready` never gets sent.
   */
  setup(shell: Shell, message: SetupMessage): Promise<LoopState | null>
}

const kinds: Record<SetupMessage['kind'], WorkerKindModule> = {
  client: clientKind,
  sim: simKind,
  gen: genKind,
  net: netKind,
}

const scope = self as unknown as {
  postMessage(m: FromWorker): void
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null
}

function post(m: FromWorker): void {
  scope.postMessage(m)
}

/** Hosts every kind; called once by `worker-auto.ts` (pattern A) or a game's own two-line
 * `worker.ts` (pattern B, 0017 §3). */
export function run(): void {
  let shell: Shell | null = null

  scope.onmessage = (ev) => {
    const m = ev.data
    if (m.type === 'setup') {
      // A debugging/test convenience only (read, never relied on for behaviour): which kind this
      // worker was set up as, reachable from the outside through `worker.evaluate()` in a
      // Playwright test (docs/plan/06b-workers-and-spawn.md, Tests added).
      ;(self as unknown as { __engineWorkerKind?: string }).__engineWorkerKind = m.kind
      const control = new ControlBlock(m.sabs.control)
      const s = createShell(control, m.index)
      shell = s
      kinds[m.kind].setup(s, m).then(
        (loop) => {
          post({ type: 'ready' })
          if (loop) runBlockingLoop(s, loop.body, loop.timeoutMs)
        },
        (e: unknown) => s.fatal(e instanceof Error ? e.message : String(e)),
      )
    } else if (m.type === 'resume') {
      shell?.resume()
    } else if (m.type === 'stop') {
      shell?.stop()
    }
  }
}
