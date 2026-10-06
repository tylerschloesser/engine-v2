// M39p: a measuring window measures only itself, and nothing runs beside it. The agent and the walk driver run in a
// `vm` on a virtual clock (`fake-agent-page.mjs`); the drive loop runs over a recording backend.
import { describe, expect, test } from 'vitest'
import { createFakePage } from './device-walk/fake-agent-page.mjs'

const GRID = 1000 / 60
const grid = (t) => (Math.floor(t / GRID + 1e-9) + 1) * GRID
const item = (opts) => ({
  id: 'M09b-fill-rate',
  n: 1,
  opts: { windowMs: 30_000, warmupMs: 10_000, ...opts },
})

describe('device-walk quiet: window-local statistics', () => {
  test('device-walk quiet: a 60 ms hitch at 9.5 s, warm-up 10 s: the steady rAF numbers are the smooth frames', async () => {
    const page = createFakePage({
      frames: (t) => {
        const f = grid(t)
        return f > 9490 && f < 9560 ? 9560 : f
      },
    })
    await page.connect()
    const run = page.kit.measureWindow(item())
    await page.advance(31_000)
    const m = await run
    expect(m.steady.length).toBeGreaterThan(15)
    const worst = Math.max(...m.steady.map((s) => s.raf_p95_ms))
    expect(worst, 'a steady p95 holds no warm-up frame').toBeLessThan(17.5)
    expect(Math.max(...m.steady.map((s) => s.raf_over20))).toBe(0)
    // The whole window still shows the hitch, with its time and size.
    expect(m.window.raf.long50).toBe(1)
    expect(m.window.gaps.list).toHaveLength(1)
    expect(m.window.gaps.list[0].gap).toBeGreaterThan(60)
    expect(m.window.gaps.list[0].t).toBeGreaterThan(9400)
    expect(m.window.gaps.list[0].t).toBeLessThan(9700)
  })

  test('device-walk quiet: a long window skips one rolling window after the warm-up for the page statistics', async () => {
    const page = createFakePage()
    await page.connect()
    const run = page.kit.measureWindow(item({ windowMs: 60_000, warmupMs: 10_000 }))
    await page.advance(61_000)
    const m = await run
    expect(m.window.samples.length).toBe(60)
    expect(Math.min(...m.steady.map((s) => s.t))).toBeGreaterThanOrEqual(20_000)
    expect(m.steady[0]).toMatchObject({ page_raf_p95_ms: 99 }) // the HUD's rolling value stays beside it
  })
})
