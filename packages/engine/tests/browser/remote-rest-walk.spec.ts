// `remote-rest-walk` (docs/plan/39ab-remote-lurch-after-rest.md step 3): a remote that has stood still for
// seconds and then starts walking must never be drawn behind where it stood. `InterpBuffer::sample` used to
// follow the tangent of a very long rest-to-walk segment and drew the circle up to a tile behind for ~250 ms
// (the Hermite tangents are now clamped per Fritsch-Carlson, `interp/buffer.rs`). Same multiplayer page as
// `remote-fade`: host and remote tick in lockstep with the page's injected clock; the page's drawn x of the
// remote is read every frame.
//
// Inject-fail-revert: remove the tangent clamp in `InterpBuffer::sample`; the first walking frames step back.
import { expect, test } from '@playwright/test'
import { fixtureBuildDir } from '../support/fixtures.js'
import { type MovingRemote, startMovingRemote } from './support/moving-remote.js'
import { openPage } from './support/page.js'
import { startTestServer, type TestServer } from './support/test-server.js'

const PORT = 48_273 + 2 * Number(process.env.TEST_PARALLEL_INDEX ?? 0)
const BASE_PATH = `/gc-multiplayer-topology.html?url=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}`
const STEP_MS = 50
const REST_X = 0.52
const SPEED = 4 // tiles per second
const REST_FRAMES = 80 // 4 s standing, longer than the 2 s of the report and the fade-free silence
const WALK_FRAMES = 40
/** Q24.8 units; a rounding step or two. */
const SLACK = 2

let server: TestServer | undefined
let remote: MovingRemote | undefined

test.beforeAll(async () => {
  server = await startTestServer({
    fixture: fixtureBuildDir('presence'),
    manualTimer: true,
    port: PORT,
  })
  remote = await startMovingRemote(server.url, 'presence', () => server?.stepTick())
})

test.afterAll(async () => {
  remote?.leave()
  await server?.stop()
})

test('remote-rest-walk: a remote walking off after rest is never drawn behind its rest position @slow', async ({
  page,
}) => {
  const opening = setInterval(() => server?.stepTick(), 50)
  try {
    await openPage(page, BASE_PATH)
  } finally {
    clearInterval(opening)
  }
  let n = 0
  let sent = 0
  const frame = async (x: number, v: number): Promise<number | undefined> => {
    if (n++ % 2 === 0) {
      remote?.stepAt(x, v)
      sent++
    }
    server?.stepTick()
    await new Promise((r) => setTimeout(r, 15))
    return page.evaluate(async (dt) => {
      await window.__step?.(dt)
      const p = (await window.__probe?.()) as { rows: { x: number; alpha: number }[] } | undefined
      return p?.rows.length === 1 ? p.rows[0]?.x : undefined
    }, STEP_MS)
  }

  for (let i = 0; i < REST_FRAMES; i++) await frame(REST_X, 0)
  const restX = await frame(REST_X, 0)
  if (restX === undefined) throw new Error('remote-rest-walk: the resting remote is not drawn')

  const xs: number[] = []
  let t = 0
  for (let i = 0; i < WALK_FRAMES; i++) {
    t += STEP_MS / 1000
    const x = await frame(REST_X + SPEED * t, SPEED)
    if (x !== undefined) xs.push(x)
  }
  expect(sent).toBeGreaterThan(REST_FRAMES / 2)
  expect(xs.length, 'the walking remote is drawn').toBeGreaterThan(WALK_FRAMES / 2)
  let worst = 0
  let prev = restX
  for (const x of xs) {
    worst = Math.max(worst, prev - x, restX - x)
    prev = x
  }
  expect(worst, `largest step back (Q24.8, 256 = 1 tile) over ${xs.join(' ')}`).toBeLessThanOrEqual(
    SLACK,
  )
  expect(xs[xs.length - 1], 'it did walk').toBeGreaterThan(restX + 256)
})
