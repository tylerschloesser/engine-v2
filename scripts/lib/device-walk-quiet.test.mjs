// M39p: a measuring window measures only itself, and nothing runs beside it. The agent and the walk driver run in a
// `vm` on a virtual clock (`fake-agent-page.mjs`); the drive loop runs over a recording backend.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { QuietWindowError } from './device-walk/drive/backend.mjs'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import { startDrive } from './device-walk/drive/loop.mjs'
import { devicePerson } from './device-walk/drive/person.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 3000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('until: condition not met in time')
    await pause(2)
  }
}

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

describe('device-walk quiet: the Mac side', () => {
  const WINDOW_MS = 400
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'))
    const file = join(dir, 'r.jsonl')
    for (const e of [
      { type: 'start', only: null, mode: 'auto' },
      { type: 'walk', phase: 'start' },
      { type: 'attempt', id: 'M09b-fill-rate', n: 1, variant: 'fixture', page: 'p', rung: 0 },
    ])
      appendEvent(file, e)
    const b = createFakeBackend({ pages: { autolock: { runner: false } } })
    const quiets = []
    const quiet = b.quiet
    b.quiet = (u) => {
      quiets.push(u)
      quiet(u)
    }
    return { dir, file, b, quiets }
  }
  const start = (x, extra = {}) => {
    let done = false
    const d = startDrive({
      backend: x.b,
      person: devicePerson(x.b, { returnLagMs: 0, sleep: async () => {} }),
      file: x.file,
      ids: ['M09b-fill-rate'],
      joinUrl: 'http://127.0.0.1:1/__walk/runner.html?walk=t',
      seriesDir: x.dir,
      append: (e) => appendEvent(x.file, e),
      settle: () => {},
      isDone: () => done,
      lastSeen: () => (extra.stale?.() ? Date.now() - 60_000 : Date.now()), // a stale phone: the watchdog would reopen it
      idleMs: 30,
      pollMs: 5,
      quietGraceMs: 20,
      ...extra,
    })
    return {
      d,
      stop: async () => {
        done = true
        await d.stop()
      },
    }
  }

  test('device-walk quiet: the drive loop makes no backend call between a window start and its end, and answers the prompt after', async () => {
    const x = setup()
    let stale = false
    const { d, stop } = start(x, { stale: () => stale })
    await d.ready
    await pause(30) // the loop is idle
    stale = true
    const openedAt = x.b.calls.length
    const t0 = Date.now()
    appendEvent(x.file, {
      type: 'window',
      phase: 'start',
      id: 'M09b-fill-rate',
      n: 1,
      ms: WINDOW_MS,
    })
    appendEvent(x.file, {
      type: 'prompt',
      id: 'M09b-fill-rate',
      n: 1,
      kind: 'act',
      text: 'Rotate the phone to landscape.',
    })
    await until(() => x.b.calls.some((c) => c.m === 'rotate'))
    await stop()
    const inside = x.b.calls
      .map((c, i) => ({ m: c.m, at: x.b.times[i] }))
      .slice(openedAt)
      .filter((c) => c.at < t0 + WINDOW_MS)
    expect(inside, 'calls to the phone inside the window').toEqual([])
    const rot = x.b.times[x.b.calls.findIndex((c) => c.m === 'rotate')]
    expect(rot).toBeGreaterThanOrEqual(t0 + WINDOW_MS)
    expect(x.quiets[0]).toBeGreaterThan(t0)
    expect(x.quiets.at(-1)).toBe(0)
  })

  test('device-walk quiet: the end marker ends the wait before the timer does', async () => {
    const x = setup()
    const ends = new Set()
    const { d, stop } = start(x, { onWindow: (fn) => ends.add(fn), quietGraceMs: 60_000 })
    await d.ready
    appendEvent(x.file, { type: 'window', phase: 'start', id: 'M09b-fill-rate', n: 1, ms: 60_000 })
    await until(() => x.quiets.length > 0)
    appendEvent(x.file, { type: 'window', phase: 'end', id: 'M09b-fill-rate', n: 1 })
    for (const fn of ends) fn({ phase: 'end' })
    await until(() => x.quiets.at(-1) === 0)
    await stop()
  })

  test('device-walk quiet: a call inside a window is refused with QuietWindowError, and counted; cleanup still runs', async () => {
    const b = createFakeBackend()
    b.quiet(Date.now() + 150)
    await expect(b.readPage('innerWidth, h: innerHeight')).rejects.toBeInstanceOf(QuietWindowError)
    await expect(b.tap(1, 2)).rejects.toThrow(/quiet window: backend\.tap/)
    expect(b.violations.map((v) => v.m)).toEqual(['readPage', 'tap'])
    expect(b.calls).toEqual([])
    await b.cleanup() // an abort during a window must still restore the phone
    expect(b.calls.map((c) => c.m)).toEqual(['cleanup'])
    await pause(160)
    await b.tap(1, 2)
    expect(b.calls.map((c) => c.m)).toEqual(['cleanup', 'tap'])
  })
})

describe('device-walk quiet: the phone side', () => {
  test('device-walk quiet: the agent sends no WebSocket frame inside a window, only its two markers around them; the queue goes out at the end', async () => {
    const page = createFakePage()
    await page.connect()
    await page.advance(2500) // a ping goes out before the window
    expect(page.frames.some((f) => f.msg.type === 'ping')).toBe(true)
    const mark = page.frames.length
    const t0 = page.now()
    page.A.beginMeasure('M09b-fill-rate', 1, 6000)
    await page.advance(100)
    page.A.send('reading', { id: 'x', n: 1, key: 'queued' }) // a collector's message inside the window
    await page.advance(5900)
    const t1 = page.now()
    const during = page.frames.slice(mark)
    expect(during.map((f) => f.msg.type)).toEqual(['window'])
    expect(during[0].msg).toMatchObject({ phase: 'start', ms: 6000 })
    page.A.endMeasure()
    await page.advance(10)
    const after = page.frames.slice(mark + 1).map((f) => `${f.msg.type}${f.msg.phase ?? ''}`)
    expect(after).toEqual(['reading', 'windowend'])
    expect(page.frames.slice(mark).every((f) => f.at >= t0)).toBe(true)
    expect(page.frames.at(-1).at).toBeGreaterThanOrEqual(t1)
    await page.advance(2100) // and the heartbeat is back
    expect(page.frames.at(-1).msg.type).toBe('ping')
  })
})
