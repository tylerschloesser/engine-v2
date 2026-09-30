// `gc-single-player.html`'s script (docs/plan/34b-reference-scripted-single-player.md, "Zero GC
// through the game"; `gc-entry.ts` is the topology this extends): the same single-player `startGame`
// wiring driven through `asHarness`, but in the state a player has after the first half of the script
// (stone mined, furnace crafted and placed, iron and wood fetched and deposited), and the measured
// window keeps the game's own verbs running: the camera pans, a collect is started every
// `ACT_EVERY_FRAMES` frames and iron deposited into the furnace as it lands. Every `dispatch` and its
// ack is real per-action allocation on main (`gc-slice.ts`'s own module comment): the budget names it.
//
// **Never imported by `main.ts`/`test-entry.ts`**; this page sets `ClientOptions.test`.
import { createUploadDrain, RingConsumer, type UploadDrain } from 'engine/render'
import {
  asHarness,
  createManualClock,
  installGcPage,
  parkWorkers,
  pumpUntilLive,
  resumeWorkers,
  stepFrame,
  stepSimTickSync,
  stepTick,
} from 'engine/test'
import type { RefUi } from './bindings/RefUi.js'
import { startGame } from './game.js'

declare global {
  interface Window {
    __pageReady?: true
  }
}

const STONE = 0
const IRON = 1
const WOOD = 2
const FURNACE_ITEM = 4
const FURNACE_AT = { x: -4, y: 1 } // `tests/helpers/script.ts` FURNACE_A: inside one chunk
const STONE_AT = { x: -1, y: 2 }
const IRON_AT = { x: 0, y: 0 }
const WOOD_AT = { x: -4, y: -2 }

const canvas = document.getElementById('game') as HTMLCanvasElement
const clock = createManualClock()

const { client, renderer, device, canvasFormat } = await startGame({
  canvas,
  host: {
    kind: 'local',
    world: { worldId: 'reference', params: { seed: '6840143426475589698', worldgen: {} } },
    connect: true,
  },
  test: { clock, flags: { gcHook: true } },
  clock,
  scheduler: clock,
})
await pumpUntilLive(client)
const harness = asHarness(client)

// The newest `Ui` (delivered on the real rAF: `gc-entry.ts`'s own note on why priming awaits one).
let ui: RefUi | null = null
client.onUi<RefUi>((u) => {
  ui = u
})

// Where the player stands (the camera drives presence); the priming moves it, the window oscillates it.
const stand = { x: IRON_AT.x, y: IRON_AT.y }
client.cameraState.tilesAcross = 20
client.cameraState.halfExtentTilesX = 15
client.cameraState.halfExtentTilesY = 15
function pinCamera(): void {
  client.cameraState.centreX = stand.x
  client.cameraState.centreY = stand.y
}
pinCamera()

const uploadConsumer = new RingConsumer(client.uploadRing)
const uploadDrain: UploadDrain = createUploadDrain(uploadConsumer, renderer)
const target = device.device.createTexture({
  label: 'gc-reference-single-player-target',
  size: [64, 64],
  format: canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
})
renderer.frameUniform.viewportPxW = 64
renderer.frameUniform.viewportPxH = 64
renderer.frameUniform.tilesPerPx = client.cameraState.tilesAcross / 64

const nextAnimationFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

function drainUploadsFully(): void {
  for (;;) {
    const { records } = uploadDrain.drain(1_000_000)
    if (records === 0) break
  }
}

/** `n` host ticks, then one real rAF so `onUi`/acks land (the priming only, never the window). */
async function advance(n: number): Promise<void> {
  pinCamera()
  stepFrame(client, 50)
  drainUploadsFully()
  await stepTick(client, n)
  await resumeWorkers(client)
  drainUploadsFully()
  await nextAnimationFrame()
}

async function until(what: string, done: () => boolean, step = 10): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await advance(step)
  if (!done()) throw new Error(`gc-single-player: ${what} did not happen`)
}

const inv = (slot: number): number => ui?.inventory[slot] ?? 0

async function moveTo(tile: { x: number; y: number }): Promise<void> {
  stand.x = tile.x
  stand.y = tile.y
  await advance(25)
}

async function collect(tile: { x: number; y: number }, slot: number): Promise<void> {
  const before = inv(slot)
  await until(`${JSON.stringify(tile)} in range`, () =>
    (ui?.in_range ?? []).some((e) => e.tile.x === tile.x && e.tile.y === tile.y),
  )
  const from = ui?.in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)?.from
  client.dispatch({ StartCollect: { tile, from } })
  await until(`collect at ${JSON.stringify(tile)}`, () => inv(slot) > before)
}

for (let i = 0; i < 5; i++) await advance(10)
await until('first Ui', () => ui !== null)
await moveTo(STONE_AT)
for (let i = 0; i < 5; i++) await collect(STONE_AT, STONE)
client.dispatch({ StartCraft: { recipe: 0 } })
await until('furnace crafted', () => inv(FURNACE_ITEM) === 1)
client.dispatch({ PlaceFurnace: { origin: FURNACE_AT } })
await until('furnace placed', () => inv(FURNACE_ITEM) === 0)
await moveTo(WOOD_AT)
await collect(WOOD_AT, WOOD)
await moveTo(IRON_AT)
await collect(IRON_AT, IRON)
client.dispatch({ FurnaceDeposit: { at: FURNACE_AT, item: 2, count: 1 } })
await until('wood deposited', () => inv(WOOD) === 0)
client.dispatch({ FurnaceDeposit: { at: FURNACE_AT, item: 1, count: 1 } })
await until('iron deposited', () => inv(IRON) === 0)
// Ends with both landmark tiles in range of the window's camera (the iron and stone tiles).
for (let i = 0; i < 10; i++) await advance(10)

await parkWorkers(client)

const PAN_AMPLITUDE_TILES = 0.3
const PAN_PERIOD_FRAMES = 120
const ACT_EVERY_FRAMES = 100

// Alternating collect targets and the next action, fixed objects built once (`dispatch` itself
// serialises per call: that cost is the page's own measured per-action allocation).
let acted = 0
function act(): void {
  const u = ui
  if (u === null) return
  if ((u.inventory[IRON] ?? 0) > 0) {
    client.dispatch({ FurnaceDeposit: { at: FURNACE_AT, item: 1, count: 1 } })
  } else if (u.collecting === null) {
    const tile = acted++ % 2 === 0 ? IRON_AT : STONE_AT
    const entry = u.in_range.find((e) => e.tile.x === tile.x && e.tile.y === tile.y)
    if (entry) client.dispatch({ StartCollect: { tile, from: entry.from } })
  }
}

function drive(f: number): void {
  const cx = stand.x + PAN_AMPLITUDE_TILES * Math.sin((2 * Math.PI * f) / PAN_PERIOD_FRAMES)
  client.cameraState.centreX = cx
  client.cameraState.centreY = stand.y
  const camTileX = Math.floor(cx)
  const camTileY = Math.floor(stand.y)
  const fu = renderer.frameUniform
  fu.camTileX = camTileX
  fu.camTileY = camTileY
  fu.camFracX = cx - camTileX
  fu.camFracY = stand.y - camTileY
  if (f % ACT_EVERY_FRAMES === 0) act()

  harness.stepFrame(1000 / 60)
  stepSimTickSync(client, 1) // the host ticks (and acks) as it does in `gc-slice.ts`
  harness.stepTick()
  uploadDrain.drain(1_000_000)
  client.pick.acquire()
  renderer.writeFrameUniform(fu)
  renderer.draw(target)
  client.overlay.update()
}

installGcPage(harness, { adapter: device.adapterInfo, drive })

window.__pageReady = true
