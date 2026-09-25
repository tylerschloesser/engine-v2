// Step 1 (docs/plan/20-reference-game-v0.md Order of work): scaffolds a real, single-player
// `createClient` session against `RefGame`'s step-1 placeholder worldgen (deep water everywhere) --
// proves the crate boots end to end (workers spawn, the sim/client roles connect) with no WebGPU
// terrain pipeline yet. `tiles.json`/`tiles.png` don't exist until step 3, which replaces the
// neutral-colour placeholder below with the real renderer (`createRealFrameLoop`, camera/input, pan
// and zoom) -- see this brief's Deviations for the exact split.

import wasm from 'virtual:engine/wasm'
import type { ClientOptions } from 'engine'
import { createClient } from 'engine'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement
canvas.style.background = '#3a3a3a' // the "neutral colour" this step's own exit bar names

const options: ClientOptions = {
  canvas,
  wasm,
  host: {
    kind: 'local',
    world: { worldId: 'reference', params: { seed: '1', worldgen: {} } },
    connect: true,
  },
  genWorkers: 1,
}
const client = createClient(options)
await client.ready

window.__pageReady = true
