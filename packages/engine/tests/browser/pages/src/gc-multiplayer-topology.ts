// `gc-multiplayer-topology.html`'s script (M29, this
// cut's own step 5): a real `createClient()` **multiplayer** topology (`host: { kind: 'remote' }`
// -- client + gen0 + net, no sim worker) against a real `ws://` server (`?url=`, a `startTestServer`
// this page's own spec starts before navigating), driven the same `stepFrame`/`stepTick` lockstep
// `gc-topology.ts` already uses for the *local* topology -- so `zeroGcSuite` runs the same generated
// clean-plus-negative-controls suite it runs against every other production-topology page, this time
// over `net` too (0016's own net-worker row and paragraph). No `test.game` (M33f, ADR 0042): the
// client takes the world from `Welcome`, as `mp.ts` does.
import { createClient } from '../../../../src/client.ts'
import { FLAG_REBASE } from '../../../../src/sab/control.ts'
import {
  asHarness,
  dispatchRaw,
  interpCounters,
  parkWorkers,
  resumeWorkers,
  samplePresences,
  untilConfigured,
} from '../../../../src/test/client.ts'
import { installGcPage } from '../../../../src/test/gc-page.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    /** One client frame after `dtMs` of injected clock time (`rebase-on-visible`). */
    __step?: (dtMs: number) => Promise<void>
    /** `FLAG_REBASE`, exactly what `frame-loop.ts`'s `resume()` sets on a return from background. */
    __setRebase?: () => void
    /** The remote players as the last frame interpolated them, plus the interpolation counters. */
    __probe?: () => Promise<{
      rows: Awaited<ReturnType<typeof samplePresences>>
      delayMs: number
      renderTime: number
    }>
  }
}

const params = new URL(location.href).searchParams
const url = params.get('url')
if (!url) throw new Error('gc-multiplayer-topology: ?url= is required (the spec’s own test server)')
// `gc/net-negative-control`'s own trigger (`?netInjectParse=1`): `TestFlags.netInjectParse`,
// `worker/net.ts` -- never set by `zeroGcSuite`'s own generated clean/object/burst tests.
const netInjectParse = params.get('netInjectParse') === '1'

const wasm = await fixtureWasm('presence')
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: { kind: 'remote', url, joinKey: '' },
  genWorkers: 1,
  test: {
    clock,
    flags: { gcHook: true, ...(netInjectParse ? { netInjectParse: true } : {}) },
  },
})

// `client.ready` does not itself wait for a remote session to go live (0013 Client policy, `client
// .ts`'s own `awaitLive` split, steps 1-2 Deviations) -- this page needs the net worker genuinely
// connected and past its handshake before the measured window starts, both so `presentIsolates`
// finds a real, active thread there and so the negative controls below actually exercise the *same*
// live topology the clean run does. `client.onLink`'s own `'online'` transition is the one signal
// for that (`mp.ts`'s own precedent).
await client.ready
let harness = asHarness(client)

// **Real bug found live, fixed here**: unlike `mp.ts` (a real `createRealFrameLoop`, one real rAF
// callback -> `writeCameraAndWake()` -- a real wake of `WORKER_CLIENT` -- every ~16 ms forever),
// this page drove no wake at all while waiting for `online`. `worker/net.ts`'s own `onUp` handler
// wakes `WORKER_CLIENT` exactly once when `CB_LINK_STATE` flips to `Up`; if the client worker has
// not yet reached its own first `Atomics.wait` at that exact instant, that one notify is lost (an
// `Atomics.notify` wakes only an *already-waiting* thread -- standard semantics, not a bug in
// `net.ts`), and with nothing else ever waking it again, `pumpHandshake()` never gets a second
// chance to observe `CB_LINK_STATE === Up` and actually send `client_hello()`: the page hung
// forever (`client.onLink` never reaching `'online'`, confirmed live with `client.debug.linkLog()`
// stuck at a lone `'open'` entry). Fixed the same way any production page already has the fix
// built in for free (a real frame loop's own continuous wakes): `harness.stepFrame()` (which
// itself calls `writeCameraAndWake()` and spins on the client's own ack) is called at least once,
// in a short real-time poll loop, until `online` -- each call is a fresh wake, so even a lost
// first notify is recovered by the very next one.
let online = false
const unsubscribeOnline = client.onLink((e) => {
  if (e.state === 'online') online = true
})
while (!online) {
  harness.stepFrame(1000 / 60)
  await new Promise((resolve) => setTimeout(resolve, 0))
}
unsubscribeOnline()
// ADR 0042: the gen workers are spawned after the first `Welcome`; park only once they exist.
await untilConfigured(client)
// `asHarness` snapshots the worker set: build it again now that gen0 exists.
harness = asHarness(client)

// M30: the spec's own moving remote (a second client on the same server,
// driven from Node) is only relayed to a client whose camera subscribes the chunk it stands in, so
// this page holds a small camera around the origin, where that remote walks.
const { cameraState } = client
cameraState.centreX = 0
cameraState.centreY = 0
cameraState.tilesAcross = 16
cameraState.halfExtentTilesX = 8
cameraState.halfExtentTilesY = 8

await parkWorkers(client)

window.__step = async (dtMs) => {
  await resumeWorkers(client)
  harness.stepFrame(dtMs)
}
window.__setRebase = () => client.setFlags(FLAG_REBASE)
window.__probe = async () => {
  await parkWorkers(client)
  const rows = await samplePresences(client)
  const c = await interpCounters(client)
  return { rows, delayMs: c.interpDelayMs, renderTime: c.renderTime }
}

// One lightweight action every `DISPATCH_EVERY_FRAMES` frames (`gc-slice.ts`'s own precedent):
// exercises the net worker's *uplink* drain path (`createBytePump`'s own `drainUp`), not only its
// downlink one (real server traffic, driven by the spec's own background ticking of the manual-
// timer test server). `SetMotd` (not `Paint`): global scope, no chunk-subscription dependency, the
// same action `mp/two-pages` already uses for its own convergence check -- this page never sets a
// camera, so nothing is ever subscribed to any chunk.
const SET_MOTD_JSON_BYTES = new TextEncoder().encode(
  JSON.stringify({ Poke: { tile: { x: 0, y: 0 }, from: { x: 0, y: 0 } } }),
)
const DISPATCH_EVERY_FRAMES = 30
let frame = 0
let seq = 1

// **Real bug found live, fixed here**: `net`'s own drain timer (`worker/net.ts`'s `armDrainTimer`)
// fires on a real 10 ms wall-clock cadence, but this page's own `drive()` loop (like every other
// zero-GC page's) runs its 600 "frames" as fast as synchronous SAB spin-waits allow -- measured,
// the whole clean run (warmup + two measured windows) took well under a second of real wall time,
// so the drain timer only fires a handful of times total, nowhere near once per "frame". `client`/
// `gen0`'s own `body()` has no such gap (it runs exactly once per explicit, synchronous step from
// main, 600 times, guaranteed) -- `net`'s own negative controls were found to almost never actually
// fire (`neg burst net` measured ~98 B/frame, not the ~40,000 B/frame every other isolate's own
// burst control shows). Fixed by dispatching a real `online` window event once per `drive()` call:
// `client.ts`'s own existing, production `online` listener already posts `{ type: 'probe' }` to the
// net worker on every real one (Scope: "main -> net `{ type: 'probe' }` on ... `online`"), and
// `worker/net.ts`'s `linkControl` now also calls `applyGcHook` there (this cut's own addition) --
// giving `net` the same deterministic, once-per-measured-frame trigger every other isolate already
// has, with no change to `net.ts`'s own real reconnect-probe *behaviour* (`Link.probe()` is a no-op
// on an already-healthy connection, `net/link.ts`'s own doc comment).
const onlineEvent = new Event('online')

installGcPage(harness, {
  drive() {
    frame += 1
    harness.stepFrame(1000 / 60)
    harness.stepTick() // `gen0` only (`asHarness`'s own tick targets: sim | gen); `net` is event-driven
    window.dispatchEvent(onlineEvent)
    if (frame % DISPATCH_EVERY_FRAMES === 0) {
      dispatchRaw(client, seq, SET_MOTD_JSON_BYTES)
      seq += 1
    }
  },
})

window.__pageReady = true
