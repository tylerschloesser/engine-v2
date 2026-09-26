// `engine/worker`'s `run()`: hosts every worker kind of docs/decisions/0015-threads-memory-and-
// topology.md §1 in one script (0017 §2's "self-contained" is read as "no bare imports, no dynamic
// `import()`": relative imports of sibling files are fine, docs/plan/06b-workers-and-spawn.md,
// Planning decisions "Worker script layout"). The kind arrives in the setup message, so there is one
// worker script however many workers a topology spawns (pattern A/B, 0017 §3).
import { ControlBlock } from './sab/control.js'
import * as clientKind from './worker/client.js'
import * as genKind from './worker/gen.js'
import * as netKind from './worker/net.js'
import type {
  FromWorker,
  SetupMessage,
  SimControlMessage,
  SimWorldOpMessage,
  TestCallMessage,
  ToWorker,
} from './worker/protocol.js'
import { isolateName } from './worker/protocol.js'
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
  // Set once, off the resolved `LoopState`, only when this worker's own setup carried `test`
  // (orchestrator decision 1 at the step-5 boundary, docs/plan/08b-gen-workers-and-queue.md): a
  // production `createClient()` never sets `options.test`, so a production worker never answers a
  // `test-call` message at all, whatever its kind returns.
  let testEnabled = false
  let testCall: ((m: TestCallMessage) => FromWorker) | null = null
  // docs/plan/23-persistence-opfs-and-lifecycle.md steps 3-4: `sim-pause`/`sim-resume`, `sim`-kind
  // only (`worker/sim.ts`'s own `LoopState.simControl`), routed the same way `testCall` already is.
  let simControl: ((m: SimControlMessage) => void) | null = null
  // docs/plan/23-persistence-opfs-and-lifecycle.md step 5: export/import/delete requests, routed the
  // same way `simControl` already is (`worker/sim.ts`'s own `LoopState.worldOp`).
  let worldOp: ((m: SimWorldOpMessage) => void) | null = null

  scope.onmessage = (ev) => {
    const m = ev.data
    if (m.type === 'setup') {
      // Debugging/test globals only (read, never relied on for behaviour), set only when the setup
      // message carries a `test` field (orchestrator decision 1): a production `createClient()`
      // call never sets `options.test`, so a production worker exposes neither. `__engineWorkerKind`
      // is reachable through `worker.evaluate()` in a Playwright test (Tests added);
      // `__engineIsolateName` is what a CDP `Runtime.evaluate` names this isolate by (decision 3,
      // `tests/browser/gc/instrument.ts`).
      if (m.test) {
        const dbg = self as unknown as { __engineWorkerKind?: string; __engineIsolateName?: string }
        dbg.__engineWorkerKind = m.kind
        dbg.__engineIsolateName = isolateName(m.kind, m.index)
      }
      testEnabled = !!m.test
      const control = new ControlBlock(m.sabs.control)
      const s = createShell(control, m.index)
      shell = s
      kinds[m.kind].setup(s, m).then(
        (loop) => {
          testCall = loop?.testCall ?? null
          simControl = loop?.simControl ?? null
          worldOp = loop?.worldOp ?? null
          // The wake word is read before `ready` goes out, not after: main can wake this worker the
          // instant it sees `ready`, and a wake between the post and the loop's own first read
          // would be lost (`Shell.observeWake`; fix round 3, docs/plan/06b-workers-and-spawn.md).
          const seen = s.observeWake()
          post({ type: 'ready' })
          if (loop) runBlockingLoop(s, loop.body, loop.timeoutMs, seen)
        },
        (e: unknown) => s.fatal(e instanceof Error ? e.message : String(e)),
      )
    } else if (m.type === 'resume') {
      shell?.resume()
    } else if (m.type === 'stop') {
      shell?.stop()
    } else if (m.type === 'test-call') {
      // Reachable only while this worker is parked (0015 §2: a blocked worker receives no events),
      // so this branch never runs from inside a kind's blocking loop.
      if (testEnabled && testCall) {
        post(testCall(m))
      } else {
        post({ type: 'test-error', id: m.id, message: 'test-call: not enabled for this worker' })
      }
    } else if (m.type === 'sim-pause' || m.type === 'sim-resume') {
      simControl?.(m)
    } else if (
      m.type === 'export-world' ||
      m.type === 'import-world' ||
      m.type === 'delete-world'
    ) {
      worldOp?.(m)
    }
  }
}
