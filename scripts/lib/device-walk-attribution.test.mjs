// M39v: each long rAF gap carries what ran before it, the heartbeat lives only inside a window, and a driven round
// can leave the inspector detached during a window. The agent runs in a `vm` on a virtual clock; the drive loop runs
// over the recording backend.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import { startDrive } from './device-walk/drive/loop.mjs'
import { devicePerson } from './device-walk/drive/person.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'
import { appendEvent } from './device-walk/rounds.mjs'

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

describe('device-walk attribution: the phone side', () => {
  test('device-walk attribution: a synthetic gap carries its stamp, lateness, heartbeat stall and the tasks before it', async () => {
    const page = createFakePage({
      frames: (t) => {
        const f = grid(t)
        return f > 4960 && f < 5040 ? 5040 : f
      },
      messageDelay: (t) => (t > 4980 && t < 5030 ? 35 : 0),
    })
    await page.connect()
    page.A.beginMeasure('M09b-fill-rate', 1, 20_000)
    const t0 = page.now()
    await page.advance(5005)
    page.A.task('paint')
    await page.advance(5000)
    page.A.endMeasure()
    const g = page.A.rafGaps()
    expect(g.list).toHaveLength(1)
    const e = g.list[0]
    expect(e.gap).toBeGreaterThan(70)
    expect(e.at).toBeGreaterThan(t0 + 4900)
    expect(e.at).toBeLessThan(t0 + 5200)
    expect(e.late).toBeGreaterThanOrEqual(0)
    expect(e.stall).toBeGreaterThan(16)
    expect(e.tasks).toContain('paint')
    expect(g.summary.withStall).toBe(1)
    expect(g.summary.withoutStall).toBe(0)
    expect(g.summary.topTasks[0]).toEqual({ name: 'paint', n: 1 })
  })

  test('device-walk attribution: a gap with a quiet heartbeat and no tasks is counted without a stall', async () => {
    const page = createFakePage({
      frames: (t) => (grid(t) > 2000 && grid(t) < 2030 ? 2030 : grid(t)),
    })
    await page.connect()
    page.A.beginMeasure('M09b-fill-rate', 1, 20_000)
    await page.advance(4000)
    const g = page.A.rafGaps()
    expect(g.list).toHaveLength(1)
    expect(g.list[0].stall).toBeLessThanOrEqual(16)
    expect(g.list[0].tasks).toEqual([])
    expect(g.summary).toMatchObject({ withStall: 0, withoutStall: 1 })
  })

  test('device-walk attribution: the gap ring keeps up to 2048 gaps', async () => {
    // a 25 ms cadence: every gap is over 20 ms
    const page = createFakePage({ frames: (t) => (Math.floor(t / 25 + 1e-9) + 1) * 25 })
    await page.connect()
    page.A.beginMeasure('M09b-fill-rate', 1, 120_000)
    await page.advance(100_000)
    const g = page.A.rafGaps()
    expect(g.total).toBeGreaterThan(2048)
    expect(g.kept).toBe(2048)
  })

  test('device-walk attribution: the heartbeat runs inside a window only', async () => {
    const page = createFakePage()
    await page.connect()
    await page.advance(1000)
    expect(page.posts(), 'no heartbeat before a window').toBe(0)
    expect(page.A.heartbeat().running).toBe(false)
    page.A.beginMeasure('M09b-fill-rate', 1, 20_000)
    await page.advance(1000)
    expect(page.A.heartbeat().running).toBe(true)
    const inside = page.posts()
    expect(inside).toBeGreaterThan(150)
    page.A.endMeasure()
    await page.advance(2000)
    expect(page.posts(), 'no heartbeat after endMeasure').toBe(inside)
    expect(page.A.heartbeat().running).toBe(false)
    // an interrupted window stops it too
    page.A.beginMeasure('M09b-fill-rate', 2, 20_000)
    await page.advance(100)
    page.document.hidden = true
    page.document.visibilityState = 'hidden'
    page.fire('visibilitychange', {})
    await page.advance(100)
    const after = page.posts()
    await page.advance(1000)
    expect(page.posts()).toBe(after)
  })
})

describe('device-walk attribution: --detach-inspector', () => {
  const WINDOW_MS = 300
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'detach-'))
    const file = join(dir, 'r.jsonl')
    for (const e of [
      { type: 'start', only: null, mode: 'auto' },
      { type: 'walk', phase: 'start' },
      { type: 'attempt', id: 'M09b-fill-rate', n: 1, variant: 'fixture', page: 'p', rung: 0 },
    ])
      appendEvent(file, e)
    const b = createFakeBackend({ inspector: true, pages: { autolock: { runner: false } } })
    return { dir, file, b }
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
      lastSeen: () => Date.now(),
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
  const windowed = async (x, opts) => {
    const { d, stop } = start(x, opts)
    await d.ready
    await pause(20)
    const mark = x.b.calls.length
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
    return {
      t0,
      seen: x.b.calls.slice(mark).map((c, i) => ({ m: c.m, at: x.b.times[mark + i] })),
    }
  }

  test('device-walk attribution: detached, the loop makes native before the window and web after it, and nothing between', async () => {
    const x = setup()
    const { seen, t0 } = await windowed(x, { detachInspector: true })
    const names = seen.map((c) => c.m)
    expect(names.slice(0, 2)).toEqual(['native', 'web'])
    expect(names.indexOf('rotate')).toBeGreaterThan(1)
    expect(names.filter((m) => m === 'native' || m === 'web')).toEqual(['native', 'web'])
    expect(seen[1].at, 'web is called after the window ends').toBeGreaterThanOrEqual(t0 + WINDOW_MS)
  })

  test('device-walk attribution: attached (the default), the loop switches no context', async () => {
    const x = setup()
    const { seen } = await windowed(x, {})
    expect(seen.map((c) => c.m).filter((m) => m === 'native' || m === 'web')).toEqual([])
  })
})
