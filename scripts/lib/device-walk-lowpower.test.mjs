// M39u: M16-low-power turns Low Power Mode back off (finding 8 of m39r-iphone), the iOS cleanup's Settings walk
// has a deadline that fits the walk, and a throttled measuring window is noted on the attempt.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAutoRound } from './device-walk/auto-round.mjs'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import { createIosBackend, SETTINGS_WALK_MS } from './device-walk/drive/ios.mjs'
import { devicePerson } from './device-walk/drive/person.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'

const item = () => ({
  id: 'M16-low-power',
  n: 1,
  page: 'slice.html',
  plan: { mode: 'lowpower' },
  opts: { timeoutMs: 8000, windowMs: 3000, warmupMs: 0, actTimeoutMs: 20000 },
})

/**
 * The slice page on a virtual clock whose rAF cadence follows the fake phone's Low Power state, with the real
 * device person answering every act prompt on a fake backend. `flick` may throw.
 */
async function drivenPage({ flick, stuck } = {}) {
  const backend = createFakeBackend()
  const person = devicePerson(backend, { sleep: async () => {} })
  let lowOn = false
  const origSet = backend.setLowPower
  backend.setLowPower = async (on) => {
    await origSet(on)
    lowOn = stuck && !on ? true : on
  }
  const T60 = 1000 / 60
  const T30 = 1000 / 30
  const page = createFakePage({
    load: ['collect-life.js'],
    frames: (t) => (Math.floor(t / (lowOn ? T30 : T60) + 1e-9) + 1) * (lowOn ? T30 : T60),
  })
  await page.connect()
  const prompts = []
  const flicks = []
  page.window.__check = {
    ready: true,
    readings: () => ({ orientation: 'portrait' }),
    errors: () => [],
    act: {
      flick: async () => {
        flicks.push(lowOn)
        if (flick) return flick(flicks.length)
        return { tiles: lowOn ? 10 : 10, releaseVx: 1, spacingMaxMs: 20 }
      },
    },
  }
  const show = page.A.bar.show
  page.A.bar.show = (s) => {
    show(s)
    if (s?.kind !== 'act') return
    prompts.push(s.text)
    person.answer({ kind: 'act', text: s.text })
  }
  return { page, backend, prompts, flicks, state: () => lowOn }
}

const setLow = (b) => b.calls.filter((c) => c.m === 'setLowPower').map((c) => c.args[0])

describe('device-walk low-power: the item leaves the phone as it found it', () => {
  test('device-walk low-power: a driven M16-low-power ends with setLowPower(false) and the phone off', async () => {
    const { page, backend, prompts, state } = await drivenPage()
    const run = page.window.__walkKit.collectors.slice(item())
    await page.advance(40000)
    const r = await run
    expect(r.lowPower).toMatchObject({ detected: true, low_power_restored: true })
    expect(setLow(backend)).toEqual([true, false])
    expect(state()).toBe(false)
    expect(prompts.at(-1)).toMatch(/^Low Power Mode looks on\. Turn it off/)
  })

  test('device-walk low-power: a throw after Low Power went on still asks for it off', async () => {
    const { page, backend, state } = await drivenPage({
      flick: (n) => {
        if (n === 2) throw new Error('the page went away')
        return { tiles: 10, releaseVx: 1, spacingMaxMs: 20 }
      },
    })
    const run = page.window.__walkKit.collectors.slice(item())
    const out = run.then(
      () => 'resolved',
      (e) => e.message,
    )
    await page.advance(40000)
    expect(await out).toBe('the page went away')
    expect(setLow(backend)).toEqual([true, false])
    expect(state()).toBe(false)
  })

  test('device-walk low-power: a phone that never leaves Low Power is recorded as low_power_restored: false', async () => {
    const { page, backend } = await drivenPage({ stuck: true })
    const run = page.window.__walkKit.collectors.slice(item())
    await page.advance(120000)
    const r = await run
    expect(r.lowPower).toMatchObject({ detected: true, low_power_restored: false })
    expect(setLow(backend)).toEqual([true, false])
  })
})

describe('device-walk low-power: the iOS cleanup walk has its own deadline', () => {
  afterEach(() => vi.useRealTimers())

  /** An iOS backend with Low Power on, whose Settings walk (its `sleep`s) takes `walkMs` once cleanup starts. */
  async function backendWithWalk(walkMs) {
    const logs = []
    let slow = false
    const call = async (method, path, body) => {
      if (path === '/session') return { sessionId: 'SID' }
      if (path.endsWith('/attribute/name')) return 'LOW_POWER_MODE_IDENTIFIER_SWITCH'
      if (path.endsWith('/attribute/value')) return '1'
      if (path.endsWith('/element')) return { 'element-6066-11e4-a52e-4f735466cecf': 'E1' }
      if (body?.script === 'mobile: getContexts')
        return [{ id: 'WEBVIEW_1', title: '', url: 'https://x.example/device.html' }]
      return null
    }
    let first = true
    const sleep = async (ms) => {
      if (!slow) return
      if (first) {
        first = false
        await new Promise((r) => setTimeout(r, walkMs))
      }
    }
    const b = createIosBackend({ call, sleep, log: (l) => logs.push(l) })
    await b.open('https://x.example/device.html')
    await b.setLowPower(true)
    slow = true
    return { b, logs }
  }

  test('device-walk low-power: a 19 s Settings walk in cleanup finishes, a hung one is cut at SETTINGS_WALK_MS', async () => {
    expect(SETTINGS_WALK_MS).toBe(30_000)
    vi.useFakeTimers()
    const ok = await backendWithWalk(19_000)
    const done = ok.b.cleanup()
    await vi.advanceTimersByTimeAsync(25_000)
    await done
    expect(ok.logs.join('\n')).not.toMatch(/timed out/)

    const hung = await backendWithWalk(10 * 60_000)
    const cut = hung.b.cleanup()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(hung.logs.join('\n')).not.toMatch(/low power\) timed out/)
    await vi.advanceTimersByTimeAsync(2_000)
    await cut
    expect(hung.logs.join('\n')).toMatch(/ios cleanup \(low power\) timed out after 30000 ms/)
  })
})

describe('device-walk low-power: a throttled window is a note on the attempt', () => {
  const { items } = parseChecks(
    readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
  )
  const run = (p50) => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-thr-'))
    const file = join(dir, 'r.jsonl')
    mkdirSync(join(dir, 's'))
    const m = createAutoRound({
      file,
      items: items.filter((i) => i.id === 'M09b-fill-rate'),
      origins: { fixture: 'http://127.0.0.1:1' },
      params: {},
    })
    m.attach({ append: (e) => appendEvent(file, e) })
    const send = (type, body) =>
      m.react(appendEvent(file, { type, src: { tab: 't', seq: 1 }, ...body }))
    send('walk', { phase: 'start' })
    const path = join(dir, 's', 'x.json')
    const raf = { long25: 0, max: 18, frames: 100, p50 }
    writeFileSync(
      path,
      JSON.stringify({
        windows: [
          { orientation: 'portrait', raf, ...(p50 > 25 ? { cadence_throttled: true } : {}) },
        ],
        steady: [
          { isolated: true, adapter: 'a/a', raf_p50_ms: p50, raf_p95_ms: 16.9, raf_over20: 0 },
        ],
      }),
    )
    send('series', { id: 'M09b-fill-rate', n: 1, path })
    return readEvents(file).find((e) => e.type === 'attempt' && e.status === 'done')
  }

  test('device-walk low-power: cadence_throttled is on the attempt and the verdict is the same either way', () => {
    const slow = run(33.4)
    const fast = run(16.6)
    expect(slow.cadence_throttled).toBe(true)
    expect(fast).not.toHaveProperty('cadence_throttled')
    expect(slow.outcome).toBe(fast.outcome)
  })
})
