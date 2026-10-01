// `recovery.html`'s script (docs/plan/37-robustness-events.md steps 1-3): one real `createClient()`
// single-player topology (`host.connect`, optionally `persist`) over a fixture named in the URL, with
// the `TestFlags` the test wants (`trapClientAtFrame`, `killSimWorkerAtTick`, `failStorageAtTick`)
// and a manual clock, so every guard window below is measured on injected time. Everything is
// stepped (`stepFrame`, `stepSimTickSync`): no real-time pacing, no sleeping.
//
// Query: `fixture` (default `puts`), `persist=1` plus `world=<id>` (OPFS, the sim-respawn and storage
// tests), `flags=<json>` (`TestFlags`). Every global is `__rec*`-prefixed (the page programs share
// one `Window` declaration space, `tests/browser/pages/tsconfig.json`).
import { clientTestHandle, createClient, type FatalEvent } from '../../../../src/client.ts'
import {
  CLOCK_FIELD,
  ClockBlockView,
  readClockBlockInto,
  SessionState,
} from '../../../../src/clock-block.ts'
import { CB_SIM_TICKS_RUN, WORKER_CLIENT } from '../../../../src/sab/control.ts'
import { RingConsumer } from '../../../../src/sab/ring.ts'
import {
  callParked,
  drawListHash,
  hostRegionHash,
  parkWorkers,
  pumpUntilLive,
  replicaHash,
  resumeWorkers,
  setCamera,
  stepFrame,
  stepSimTickSync,
  stepTick,
  worldHash,
} from '../../../../src/test/client.ts'
import { createManualClock } from '../../../../src/test/manual-clock.ts'
import { CLIENT_TRAPS_CALL, type TestFlags, TRAPS_BYTES } from '../../../../src/worker/protocol.ts'
import { fixtureWasm } from './fixture-wasm.ts'

declare global {
  interface Window {
    __pageReady?: true
    __recAdvance?: (x: number, y: number, tilesAcross: number, ticks: number) => Promise<void>
    __recFrames?: (n: number, dtMs?: number) => Promise<void>
    __recAdvanceClock?: (ms: number) => void
    __recStepSim?: (n: number) => Promise<void>
    __recUntilRespawned?: (n: number) => Promise<void>
    __recStaleReports?: (n: number) => Promise<void>
    __recDispatch?: (action: unknown) => number
    __recResults?: () => [number, unknown][]
    __recEvents?: () => { resyncing: number; fatal: FatalEvent[] }
    __recSession?: () => number
    __recPumpUntilOnline?: (minResyncing: number) => Promise<void>
    __recHashes?: () => Promise<{ replica: string; host: string }>
    __recWorldHashAndTick?: () => Promise<{ hash: string; tick: number }>
    __recDrawHash?: () => string
    __recSimTicks?: () => number
    __recClientTraps?: () => Promise<number>
    __recExport?: () => Promise<number[]>
    __recDump?: (worldId: string) => Promise<Record<string, number[]>>
    __recSimWorkers?: () => number
    __recSimRespawns?: () => number
  }
}

const params = new URL(location.href).searchParams
const fixture = params.get('fixture') ?? 'puts'
const worldId = params.get('world') ?? 'recovery'
const persist = params.get('persist') === '1'
const flags = JSON.parse(params.get('flags') ?? '{}') as TestFlags

const wasm = await fixtureWasm(fixture)
const canvas = document.createElement('canvas')
const clock = createManualClock()

const client = createClient({
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId, params: { seed: '1', worldgen: null } },
    connect: true,
    ...(persist ? { persist: true } : {}),
  },
  genWorkers: 1,
  test: { clock, flags },
})

const results: [number, unknown][] = []
let resyncing = 0
const fatal: FatalEvent[] = []
client.onActionResult((seq, result) => {
  results.push([seq, result])
})
client.onResyncing(() => {
  resyncing++
})
client.onFatal((e) => {
  fatal.push(e)
})

await pumpUntilLive(client)

// This page draws nothing; keep the page-owned upload ring empty (`connected.ts`'s own precedent).
const uploadDiscard = new RingConsumer(client.uploadRing)
const uploadDiscardBuf = new Uint8Array(4112)
setInterval(() => {
  for (;;) {
    if (uploadDiscard.popInto(uploadDiscardBuf, 0) < 0) break
  }
}, 16)

const handle = clientTestHandle(client)
const clockView = new ClockBlockView(handle.sabs.clockBlock)
const clockScratch = new Uint32Array(8)

/** The session state the client worker last wrote to the clock block (`SessionState`). */
function sessionState(): number {
  readClockBlockInto(clockView, clockScratch)
  return clockScratch[CLOCK_FIELD.SessionState] as number
}

window.__recAdvance = async (x, y, tilesAcross, ticks) => {
  await resumeWorkers(client)
  setCamera(client, { x, y, tilesAcross })
  stepFrame(client, 2000)
  await stepTick(client, ticks)
}
window.__recFrames = async (n, dtMs = 16) => {
  await resumeWorkers(client)
  for (let i = 0; i < n; i++) stepFrame(client, dtMs)
}
window.__recAdvanceClock = (ms) => clock.advance(ms)
// Ticks the sim and returns as soon as the sim worker acked, without parking anyone: a worker the
// test is about to kill must not be asked to park.
window.__recStepSim = async (n) => {
  await resumeWorkers(client)
  stepSimTickSync(client, n)
}
window.__recDispatch = (action) => client.dispatch(action)
window.__recResults = () => results.slice()
window.__recEvents = () => ({ resyncing, fatal: fatal.slice() })
window.__recSession = sessionState
// Steps ticks (and wakes the client worker, no frame: tests count frames) until the session reads
// `Online` again and at least `minResyncing` `onResyncing` events were seen: the client sends
// `Hello`, the sim answers it at a tick boundary, the client applies the `Welcome`. In macrotask-sized
// steps and bounded, so a regression fails instead of hanging. Returns early on `onFatal`.
window.__recPumpUntilOnline = async (minResyncing) => {
  await resumeWorkers(client)
  for (let i = 0; i < 400; i++) {
    handle.control.wake(WORKER_CLIENT)
    stepSimTickSync(client, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (fatal.length > 0) return
    if (resyncing >= minResyncing && sessionState() === SessionState.Online) return
  }
  throw new Error(`recovery: not online again after 400 steps (resyncing ${resyncing})`)
}
// Waits (macrotask polls, bounded) for the n-th replacement of the sim worker to report `ready`: only
// then is it safe to step the new sim (the old one never acks again).
window.__recUntilRespawned = async (n) => {
  for (let i = 0; i < 2000; i++) {
    if (handle.simRespawns() >= n || fatal.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`recovery: the sim worker was not respawned (${handle.simRespawns()})`)
}
// `n` camera reports pushed to the uplink while the sim worker is down (each frame moves the camera
// and is 100 ms of manual time, past the 50 ms report limit): what a real client keeps sending between the
// death and the new worker's first `Hello`.
window.__recStaleReports = async (n) => {
  await resumeWorkers(client)
  for (let i = 0; i < n; i++) {
    setCamera(client, { x: 100 + i * 7, y: 0, tilesAcross: 32 })
    stepFrame(client, 100)
  }
}
window.__recHashes = async () => {
  await parkWorkers(client)
  const replica = await replicaHash(client)
  const host = await hostRegionHash(client)
  await resumeWorkers(client)
  return { replica, host }
}
window.__recWorldHashAndTick = async () => {
  await parkWorkers(client)
  const hash = await worldHash(client)
  const tick = Atomics.load(handle.control.words, CB_SIM_TICKS_RUN)
  await resumeWorkers(client)
  return { hash, tick }
}
window.__recDrawHash = () => drawListHash(client)
window.__recSimTicks = () => Atomics.load(handle.control.words, CB_SIM_TICKS_RUN)
window.__recClientTraps = async () => {
  await parkWorkers(client)
  const { result } = await callParked(client, 'client', CLIENT_TRAPS_CALL, [], TRAPS_BYTES)
  await resumeWorkers(client)
  return new DataView(result.buffer).getUint32(0, true)
}
window.__recExport = async () => {
  const blob = await client.exportWorld()
  return Array.from(new Uint8Array(await blob.arrayBuffer()))
}
window.__recDump = (id) =>
  new Promise((resolve) => {
    const worker = new Worker(new URL('./world-dump-worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (ev: MessageEvent<{ entries: Record<string, number[]> }>) => {
      worker.terminate()
      resolve(ev.data.entries)
    }
    worker.postMessage({ worldId: id })
  })
window.__recSimRespawns = () => handle.simRespawns()
window.__recSimWorkers = () => handle.workers.filter((w) => w.kind === 'sim').length

window.__pageReady = true
