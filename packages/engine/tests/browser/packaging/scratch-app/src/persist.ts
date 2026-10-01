// `dev-reload-keeps-world @slow`'s page: a persisted local world (OPFS), real clock, no test hooks.
// The test pings through `__ping`, waits on `__ui()`, exports as the clean boundary, then edits the
// crate; Vite's full reload loads this same page again, which must show the same world.

import wasm from 'virtual:engine/wasm'
import { createClient } from 'engine'

type PingUi = { pings: number; tick: number; build: number }
type W = {
  __pageReady?: boolean
  __startError?: string
  __ui?: () => PingUi | undefined
  __ping?: () => void
  __export?: () => Promise<number>
}
const w = window as unknown as W

const client = createClient({
  canvas: document.getElementById('game') as HTMLCanvasElement,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'dev-reload', params: { seed: '1', worldgen: null } },
    connect: true,
    persist: true,
  },
  genWorkers: 1,
})

let ui: PingUi | undefined
client.onUi<PingUi>((u) => {
  ui = u
})
w.__ui = () => ui
w.__ping = () => {
  client.dispatch('Ping')
}
// Bounded: a world that is not persisted never settles an export, and the test must fail, not hang.
w.__export = async () => {
  const bound = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('exportWorld did not settle in 10 s')), 10_000),
  )
  return (await Promise.race([client.exportWorld(), bound])).size
}

try {
  await client.ready
  const frame = () => {
    client.writeCameraAndWake()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
} catch (e) {
  w.__startError = e instanceof Error ? e.message : String(e)
}
w.__pageReady = true
