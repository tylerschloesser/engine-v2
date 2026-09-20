// `gc-echo.html`'s script (docs/plan/06b-workers-and-spawn.md, Tests added): 10 KiB per frame,
// main -> `actionRing` -> client `Rx` region -> `Tx` region -> `uiRing` -> main, through
// preallocated view pairs -- the SAB -> WASM -> SAB round trip 0014's "WASM -> SAB unmeasured" gap
// and 0015's "only worker -> main measured" both name. The client worker's own echo of `Rx` into
// `Tx` and `uiRing` is `worker/client.ts`'s `test.echo` path; this page only drives the main side.
// Named `gc-echo` (Deviations note the same naming reasoning as `gc-topology.ts`).
import wasm from 'virtual:engine/wasm'
import { type Client, clientTestHandle, createClient } from '../../../../src/client.ts'
import { WORKER_CLIENT } from '../../../../src/sab/control.ts'
import { RingConsumer, RingProducer } from '../../../../src/sab/ring.ts'
import { asHarness, parkWorkers } from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const DEFAULT_GAME = { seed: '0x1', entities: 4 }
// Matches `fixtures/hash`'s `CLIENT_RX_TX_BYTES` (docs/plan/06b-workers-and-spawn.md, Deviations):
// the whole-block copies below (`tryPush`/`popInto`) rely on both ends being exactly this size.
const ECHO_BYTES = 10 * 1024
// The spike's ack-timeout guard (`spikes/zero-gc-webgpu/public/main.js`), reused the same way
// `test/client.ts`'s `stepFrame` does.
const SPIN_LIMIT = 2_000_000_000
// See `gc-topology.ts`'s own comment: `sim`/`gen0` only need *some* wake cycles across the window.
const STEP_TICK_EVERY = 2

const canvas = document.createElement('canvas')
const client: Client = createClient({
  canvas,
  wasm,
  host: { kind: 'local', world: { game: DEFAULT_GAME } },
  genWorkers: 1,
  test: { game: DEFAULT_GAME, flags: { echo: true, gcHook: true } },
})
await client.ready

const h = clientTestHandle(client)
const actionProducer = new RingProducer(h.sabs.actionRing, {
  control: h.control,
  index: WORKER_CLIENT,
})
const uiConsumer = new RingConsumer(h.sabs.uiRing)
// Preallocated once, reused every frame (`.claude/rules/hot-paths.md`): a whole-block round trip,
// never `subarray()`/recreated.
const src = new Uint8Array(ECHO_BYTES)
const dst = new Uint8Array(ECHO_BYTES)

// A production worker enters its blocking loop right after `ready`: park every worker before
// `__pageReady` so CDP can reach them the moment the test attaches (packages/engine/CLAUDE.md,
// "call `parkWorkers` before any CDP call into a worker"; same reasoning as `gc-topology.ts`).
const harness = asHarness(client)
await parkWorkers(client)

installGcPage(harness, {
  drive(frame) {
    src[0] = frame & 0xff
    if (!actionProducer.tryPush(src, src.length)) {
      throw new Error('gc-echo: actionRing full')
    }
    let spins = 0
    while (uiConsumer.peekLen() < 0) {
      if (++spins > SPIN_LIMIT) throw new Error('gc-echo: no response from the client worker')
    }
    const len = uiConsumer.popInto(dst, 0)
    void len
    void dst[0]
    // `sim`/`gen0` have no ring traffic of their own yet (Non-scope): locksteps a synthetic wake
    // with them so their own negative controls trip reliably (`asHarness`'s own comment).
    if (frame % STEP_TICK_EVERY === 0) harness.stepTick()
  },
})

window.__pageReady = true
