// M39t: M16-coexist waits for the page's first `engine_mem_grows` reading before it opens the window, and a
// reading that never arrives is `{ ready: false, why }`, never a pass.
import { describe, expect, test } from 'vitest'
import { CHECKS, evaluate } from './device-walk/checks.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'

const entry = CHECKS['M16-coexist']
const row = (r, name) => r.criteria.find((c) => c.name === name)

const item = (o = {}) => ({
  id: 'M16-coexist',
  n: 1,
  page: 'slice.html?autopan=1',
  plan: { mode: 'coexist' },
  opts: { timeoutMs: 8000, windowMs: 3000, warmupMs: 0, ...o },
})

/** A slice page whose `engine_mem_grows` is null until `arrive()`, as before its first 3 s reading. */
async function slicePage() {
  const page = createFakePage({ load: ['collect-life.js'] })
  await page.connect()
  let mem = null
  const paints = []
  page.window.__check = {
    ready: true,
    readings: () => ({ orientation: 'portrait', engine_mem_grows: mem }),
    errors: () => [],
    act: { paint: (a) => paints.push(a) },
  }
  return { page, paints, arrive: () => (mem = 0) }
}

describe('device-walk coexist: the first memory reading', () => {
  test('device-walk coexist: a reading that arrives after 4 s is waited for, the window measures it', async () => {
    const { page, arrive } = await slicePage()
    const run = page.window.__walkKit.collectors.slice(item())
    await page.advance(4000)
    arrive()
    await page.advance(6000)
    const r = await run
    expect(r.ready).toBe(true)
    expect(r.reloads).toBe(0)
    const e = evaluate(entry, r)
    expect(row(e, 'engine_mem_grows')).toMatchObject({ value: 0, ok: true })
  })

  test('device-walk coexist: a reading that never arrives is { ready: false, why }, a failing verdict', async () => {
    const { page, paints } = await slicePage()
    const run = page.window.__walkKit.collectors.slice(item({ timeoutMs: 2000 }))
    await page.advance(6000)
    const r = await run
    expect(r).toMatchObject({ ready: false, why: { ready: true } })
    expect(r).not.toHaveProperty('reloads')
    expect(paints).toHaveLength(0)
    const e = evaluate(entry, r)
    expect(row(e, 'engine_mem_grows')).toMatchObject({ value: null, ok: false })
    expect(e.verdict).toBe('fail')
  })
})
