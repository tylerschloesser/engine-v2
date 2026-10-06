// M39q: M29-net-heap waits for the page and the link, and a window that measured nothing cannot pass.
import { describe, expect, test } from 'vitest'
import { CHECKS, evaluate, read } from './device-walk/checks.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'

const entry = CHECKS['M29-net-heap']
const row = (r, name) => r.criteria.find((c) => c.name === name)

describe('device-walk netheap: no measurement, no pass', () => {
  test('device-walk netheap: a sum over no windows is null, not 0', () => {
    expect(read({}, 'windows.*.raf.long25', 'sum')).toBeNull()
    expect(read({ windows: [] }, 'windows.*.raf.long25', 'sum')).toBeNull()
    expect(read({ windows: [{ raf: { long25: null } }] }, 'windows.*.raf.long25', 'sum')).toBeNull()
    expect(read({ windows: [{ raf: { long25: 0 } }] }, 'windows.*.raf.long25', 'sum')).toBe(0)
  })

  test('device-walk netheap: a result with no window fails reloads and sends the hitch proxy to the judge', () => {
    for (const data of [
      { ready: false, why: { ready: false, link: 'none' } },
      { ready: false, error: 'x' },
    ]) {
      const r = evaluate(entry, data)
      expect(row(r, 'reloads')).toMatchObject({ value: null, ok: false })
      expect(row(r, 'hitch_gaps_over_25ms')).toMatchObject({ value: null, ok: null })
      expect(r.verdict).toBe('fail')
    }
    // Even with a reloads of 0 and an empty window list the hitch criterion is not a pass.
    const r = evaluate(entry, { ready: true, reloads: 0, windows: [] })
    expect(row(r, 'hitch_gaps_over_25ms').ok).toBeNull()
    expect(r.verdict).toBe('judge')
  })

  test('device-walk netheap: a measured window with no gap still passes', () => {
    const r = evaluate(entry, {
      ready: true,
      reloads: 0,
      windows: [{ raf: { long25: 0, max: 17 } }],
    })
    expect(r.verdict).toBe('pass')
  })
})

describe('device-walk netheap: the agent', () => {
  const item = (o = {}) => ({
    id: 'M29-net-heap',
    n: 1,
    page: 'mp.html?linklog=1',
    plan: { mode: 'netheap' },
    opts: { timeoutMs: 4000, windowMs: 3000, warmupMs: 0, ...o },
  })
  /** A `__check` that is still booting; `up()` is the moment `client.ready` resolves and the foot of mp.ts runs. */
  const boot = (page, { link = 'online' } = {}) => {
    const paints = []
    const c = {
      ready: false,
      readings: () => ({ orientation: 'portrait', link: 'none' }),
      errors: () => [],
    }
    page.window.__check = c
    return {
      paints,
      up: () => {
        c.act = { paint: (a) => paints.push(a) }
        c.readings = () => ({ orientation: 'portrait', link })
        c.ready = true
      },
    }
  }
  const setup = async (frames) => {
    const page = createFakePage({ load: ['collect-life.js'], frames })
    await page.connect()
    return page
  }

  test('device-walk netheap: a page that boots after the agent attached is waited for, then measured', async () => {
    const page = await setup()
    const { paints, up } = boot(page)
    const run = page.window.__walkKit.collectors.mp(item())
    await page.advance(2000) // the old collector would throw on `check().act` here
    expect(paints).toHaveLength(0)
    up()
    await page.advance(6000)
    const r = await run
    expect(r.ready).toBe(true)
    expect(r.reloads).toBe(0)
    expect(r.windows).toHaveLength(1)
    expect(r.windows[0].raf.frames).toBeGreaterThan(100)
    expect(paints.length).toBeGreaterThan(0)
  })

  test('device-walk netheap: a link that never comes online is { ready: false, why }, with no reloads', async () => {
    const page = await setup()
    const { paints, up } = boot(page, { link: 'connecting' })
    up()
    const run = page.window.__walkKit.collectors.mp(item({ timeoutMs: 1500 }))
    await page.advance(6000)
    const r = await run
    expect(r).toMatchObject({ ready: false, why: { ready: true, link: 'connecting' } })
    expect(JSON.parse(JSON.stringify(r.errors))).toEqual([])
    expect(r).not.toHaveProperty('reloads')
    expect(paints).toHaveLength(0)
  })

  test('device-walk netheap: a page that never boots is { ready: false, why: { ready: false } }', async () => {
    const page = await setup()
    boot(page)
    const run = page.window.__walkKit.collectors.mp(item({ timeoutMs: 1500 }))
    await page.advance(3000)
    const r = await run
    expect(r).toMatchObject({ ready: false, why: { ready: false, link: 'none' } })
    expect(r).not.toHaveProperty('reloads')
  })

  test('device-walk netheap: a window that saw no frame reports unknown gap counts, not 0', async () => {
    const page = await setup(() => Number.POSITIVE_INFINITY)
    boot(page).up()
    const run = page.window.__walkKit.collectors.mp(item({ windowMs: 2000 }))
    await page.advance(5000)
    const r = await run
    expect(r.windows[0].raf).toMatchObject({ frames: 0, long25: null, max: null })
    const e = evaluate(entry, r)
    expect(row(e, 'hitch_gaps_over_25ms')).toMatchObject({ value: null, ok: null })
    expect(e.verdict).not.toBe('pass')
  })
})
