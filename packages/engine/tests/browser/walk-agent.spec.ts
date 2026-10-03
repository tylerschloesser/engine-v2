// The device-walk agent and runner page (docs/plan/39f-device-auto-runner.md step 3) in headless
// Chromium and WebKit, against the real phone API and the self-test state machine (no tunnel: the two
// "origins" are `127.0.0.1` and `localhost` on one port). `@webkit-gpu` puts a test in WebKit as well as
// Chromium (never Firefox, which has no WebGPU for the wrapper test); all are `@slow` (the browser
// suite is full: docs/plan/39f, Tests added). The wake lock is a stub here: what the real iPhone does
// with it is the phone self-test (`pnpm device:walk --selftest`), not something a headless engine can say.
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAdapter } from './support/gpu.js'

const scripts = new URL('../../../../scripts/lib/device-walk/', import.meta.url).href
type Ev = Record<string, unknown> & { type: string; src?: { tab: string; seq: number } }
type Api = {
  handler: (req: unknown, res: unknown) => void
  upgrade: (req: unknown, socket: unknown, head: unknown) => void
  allowHost: (h: string) => void
  cut: (ms: number) => void
  close: () => Promise<void>
}
type Rig = {
  a: string
  b: string
  token: string
  file: string
  api: Api
  events: () => Ev[]
  runner: (origin?: string) => string
  page: (origin?: string) => string
  close: () => Promise<void>
}

declare global {
  interface Window {
    __walkAgent?: {
      send(type: string, body?: Record<string, unknown>): number
      state(): {
        connected: boolean
        outbox: number
        seq: number
        lastAck: number
        reconnects: number
      }
      bar: { show(s: unknown): void; tick(n: string, ok: boolean): void; present(): boolean }
      setMeasuring(on: boolean): void
      beginMeasure(id: string, n: number): void
      endMeasure(): { id: string; n: number; interrupted: boolean }
      measure(): { on: boolean; interrupted: boolean }
      rafStats(): { frames: number }
    }
  }
}

async function rig(
  params = { holdMs: 9000, dropAtMs: 3000, dropMs: 3000, probeMs: 1200 },
): Promise<Rig> {
  const { createPhoneApi } = (await import(`${scripts}phone-api.mjs`)) as {
    createPhoneApi: (o: Record<string, unknown>) => Api
  }
  const st = (await import(`${scripts}selftest.mjs`)) as {
    createSelftest: (o: Record<string, unknown>) => Record<string, unknown>
  }
  const { readEvents } = (await import(`${scripts}rounds.mjs`)) as {
    readEvents: (f: string) => Ev[]
  }
  const dir = mkdtempSync(join(tmpdir(), 'walk-agent-'))
  const file = join(dir, 'r.jsonl')
  const token = '0123456789abcdef0123456789abcdef'
  const origins: string[] = []
  const selftest = st.createSelftest({ origins, params })
  const api = createPhoneApi({ file, round: 'r', token, seriesDir: join(dir, 's'), ...selftest })
  const html = (body: string) =>
    `<!doctype html><html><head><script src="/__walk/agent.js"></script></head><body>${body}</body></html>`
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/__walk/')) return api.handler(req, res)
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html('<h1>page</h1>'))
  })
  server.on('upgrade', (req, socket, head) => api.upgrade(req, socket, head))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const a = `http://127.0.0.1:${port}`
  const b = `http://localhost:${port}`
  origins.push(a, b)
  api.allowHost(`127.0.0.1:${port}`)
  api.allowHost(`localhost:${port}`)
  return {
    a,
    b,
    token,
    file,
    api,
    events: () => readEvents(file),
    runner: (o = a) => `${o}/__walk/runner.html?walk=${token}&run=r`,
    page: (o = a) => `${o}/page.html?walk=${token}&run=r`,
    close: async () => {
      await api.close() // terminates the agents' sockets first: an upgraded socket would hold server.close open
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

/** A deterministic stand-in for `navigator.wakeLock` (headless engines vary). */
async function stubWakeLock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const make = () => {
      const s = new EventTarget() as EventTarget & { release(): Promise<void> }
      s.release = async () => {
        s.dispatchEvent(new Event('release'))
      }
      return s
    }
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: async () => make() },
    })
  })
}

/** Pretend the screen locked / came back: what Safari does to a page on Auto-Lock. */
async function hidePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const [k, v] of [
      ['hidden', true],
      ['visibilityState', 'hidden'],
    ] as const)
      Object.defineProperty(document, k, { configurable: true, get: () => v })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}
async function showPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const [k, v] of [
      ['hidden', false],
      ['visibilityState', 'visible'],
    ] as const)
      Object.defineProperty(document, k, { configurable: true, get: () => v })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('walk: the self-test runs end to end (two-origin hop, hold, link cut with taps, outbox flush, verdict) @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await rig()
  try {
    await stubWakeLock(page)
    await page.goto(r.runner())
    await expect(page.locator('#idle')).toBeVisible()
    // Pre-flight: Start is locked until an idle probe passes. The first probe is spoiled by hiding the
    // page (a locked screen); the message shows on return and the probe repeats.
    await expect(page.locator('#start')).toBeHidden()
    await page.locator('#autolock').click()
    await page.locator('#probe').click()
    await hidePage(page)
    await showPage(page)
    await expect(page.locator('#probemsg')).toContainText('set Auto-Lock to Never')
    await expect(page.locator('#start')).toBeHidden()
    await page.locator('#probe').click()
    await expect(page.locator('#start')).toBeVisible({ timeout: 10_000 })
    await page.locator('#start').click()
    // The cut: while the Mac refuses the phone, taps are queued in the outbox, not lost.
    await expect(page.locator('#tapbox')).toBeVisible({ timeout: 30_000 })
    await until(
      'the link to be down',
      async () => !(await page.evaluate(() => window.__walkAgent?.state().connected)),
    )
    for (let i = 0; i < 3; i++) await page.locator('#tap').click()
    const queued = await page.evaluate(() => window.__walkAgent?.state().outbox)
    expect(queued, 'taps wait in the outbox while the link is cut').toBeGreaterThanOrEqual(3)
    await expect(page.locator('#done')).toBeVisible({ timeout: 40_000 })
    const verdict = (await page.locator('#verdict').textContent()) ?? ''
    expect(verdict, verdict).toMatch(/^PASS/)

    const ev = r.events()
    const phases = ev.filter((e) => e.type === 'selftest').map((e) => e.phase)
    expect(phases.filter((p) => p !== 'tap')).toEqual([
      'preflight',
      'preflight',
      'start',
      'hop-arrive',
      'hop-arrive',
      'drop-begin',
      'drop-end',
      'drop-report',
      'hold-end',
    ])
    expect(phases.filter((p) => p === 'tap')).toHaveLength(3)
    expect(ev.filter((e) => e.phase === 'preflight').map((e) => e.ok)).toEqual([false, true])
    const arrivals = ev.filter((e) => e.phase === 'hop-arrive')
    expect(arrivals.map((e) => e.origin)).toEqual([r.b, r.a]) // started on A, hopped to B, came back
    // Each hop starts a new tab id (`<base>-<x>`) with its own counter: per tab `src.seq` is 1, 2, 3...
    const byTab = new Map<string, number[]>()
    for (const e of ev)
      if (e.src) byTab.set(e.src.tab, [...(byTab.get(e.src.tab) ?? []), e.src.seq])
    expect(byTab.size, 'A, B and A again').toBeGreaterThanOrEqual(3)
    expect(new Set([...byTab.keys()].map((t) => t.split('-')[0])).size, 'one base id').toBe(1)
    for (const [tab, seqs] of byTab) expect(seqs, tab).toEqual(seqs.map((_, i) => i + 1))
    const result = ev.find((e) => e.type === 'result') as Ev & { criteria: { ok: boolean }[] }
    expect(result).toMatchObject({ id: 'M39f-selftest', result: 'pass', by: 'auto' })
    expect(result.criteria.every((c) => c.ok)).toBe(true)
  } finally {
    await r.close()
  }
})

test('walk: hello resumes (lastSeq, step), a resent seq is not logged twice, env is reported @slow @webkit-gpu', async ({
  page,
}) => {
  const r = await rig()
  try {
    await page.goto(r.page())
    await until(
      'the agent to connect',
      async () => !!(await page.evaluate(() => window.__walkAgent?.state().connected)),
    )
    const [sa, sb] = await page.evaluate(() => [
      window.__walkAgent?.send('visibility', { state: 'visible', path: '/a' }) ?? 0,
      window.__walkAgent?.send('visibility', { state: 'visible', path: '/b' }) ?? 0,
    ])
    await until(
      'acks',
      async () =>
        ((await page.evaluate(() => window.__walkAgent?.state().lastAck)) ?? 0) >= (sb ?? 0),
    )
    // Plant an already-acked message in the outbox for the next load (the page's own pagehide handler
    // rewrites the outbox while unloading, so an init script puts it there after that): the agent
    // resends it on connect, and the service must treat it as the duplicate it is.
    await page.evaluate((seq) => {
      const tab = JSON.parse(sessionStorage.getItem('__walk_id') as string).tab
      const m = { run: 'r', tab, seq, t: 1, type: 'visibility', state: 'visible', path: '/a' }
      sessionStorage.setItem('__plant', JSON.stringify([m]))
    }, sa)
    await page.addInitScript(() => {
      const plant = sessionStorage.getItem('__plant')
      if (!plant) return
      sessionStorage.removeItem('__plant')
      sessionStorage.setItem('__walk_out', plant)
    })
    await page.reload()
    await until('hello and flush after the reload', async () => {
      const s = await page.evaluate(() => window.__walkAgent?.state())
      return !!s?.connected && s.outbox === 0
    })
    const vis = r
      .events()
      .filter((e) => e.type === 'visibility' && (e.path === '/a' || e.path === '/b'))
    expect(vis.map((e) => e.src?.seq)).toEqual([sa, sb]) // the resend of an acked seq never reached the log
    // The reload kept the counter: the next message continues it, not a restart at 1.
    const next = await page.evaluate(() =>
      window.__walkAgent?.send('visibility', { state: 'visible', path: '/c' }),
    )
    expect(next).toBeGreaterThan(sb ?? 0)
    // Environment facts arrive once per tab and origin.
    await until('env', () => r.events().some((e) => e.type === 'env'))
    const env = r.events().find((e) => e.type === 'env') as Ev & Record<string, unknown>
    expect(env.ua).toBe(await page.evaluate(() => navigator.userAgent))
    expect(env).toMatchObject({ origin: r.a })
    expect(typeof env.crossOriginIsolated).toBe('boolean')
    expect(typeof env.dpr).toBe('number')
    expect(env.screen).toMatchObject({ w: expect.any(Number) })
  } finally {
    await r.close()
  }
})

test('walk: the outbox flushes in order after the socket is dropped @slow @webkit-gpu', async ({
  page,
}) => {
  const r = await rig()
  try {
    await page.goto(r.page())
    await until(
      'connected',
      async () => !!(await page.evaluate(() => window.__walkAgent?.state().connected)),
    )
    r.api.cut(1500) // closes every socket and refuses the phone for 1.5 s
    await until(
      'the drop',
      async () => !(await page.evaluate(() => window.__walkAgent?.state().connected)),
    )
    await page.evaluate(() => {
      for (let i = 1; i <= 5; i++)
        window.__walkAgent?.send('visibility', { state: 'visible', path: `/q${i}` })
    })
    expect(await page.evaluate(() => window.__walkAgent?.state().outbox)).toBe(5)
    await until(
      'the flush',
      async () => (await page.evaluate(() => window.__walkAgent?.state().outbox)) === 0,
      20_000,
    )
    const q = r.events().filter((e) => String(e.path).startsWith('/q'))
    expect(q.map((e) => e.path)).toEqual(['/q1', '/q2', '/q3', '/q4', '/q5'])
    const seqs = q.map((e) => e.src?.seq as number)
    expect(seqs.every((s, i) => i === 0 || s === (seqs[i - 1] as number) + 1)).toBe(true)
  } finally {
    await r.close()
  }
})

test('walk: the requestDevice wrapper reports an uncapturederror and a device loss @slow @webkit-gpu', async ({
  page,
}) => {
  const r = await rig()
  try {
    await page.goto(r.page())
    const info = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter()
      if (!a) return null
      const d = await a.requestDevice()
      d.createBuffer({ size: 16, usage: 0xffff }) // invalid usage: a validation error nobody catches
      await new Promise((res) => setTimeout(res, 300))
      d.destroy()
      await d.lost
      return {
        vendor: a.info?.vendor ?? '',
        architecture: a.info?.architecture ?? '',
        device: '',
        description: '',
        isFallbackAdapter: null,
      }
    })
    expectAdapter(test.info(), info)
    await until('both gpu events', () => {
      const kinds = r
        .events()
        .filter((e) => e.type === 'gpu')
        .map((e) => e.kind)
      return kinds.includes('uncapturederror') && kinds.includes('lost')
    })
    const lost = r.events().find((e) => e.type === 'gpu' && e.kind === 'lost')
    expect(lost?.reason).toBe('destroyed')
  } finally {
    await r.close()
  }
})

test('walk: the walk bar is removed from the DOM during a measuring window and returns after @slow @webkit-gpu', async ({
  page,
}) => {
  await stubWakeLock(page)
  const r = await rig()
  try {
    await page.goto(r.page())
    await until(
      'connected',
      async () => !!(await page.evaluate(() => window.__walkAgent?.state().connected)),
    )
    const bar = () => page.evaluate(() => document.getElementById('walk-bar') !== null)
    expect(await bar()).toBe(false)
    await page.evaluate(() =>
      window.__walkAgent?.bar.show({
        kind: 'act',
        text: 'Rotate the phone',
        id: 'M09b',
        n: 1,
        detected: { rotated: false },
      }),
    )
    expect(await bar()).toBe(true)
    const before = await page.evaluate(() => document.body.children.length)
    await page.evaluate(() => window.__walkAgent?.setMeasuring(true))
    expect(await bar(), 'no walk bar element while measuring').toBe(false)
    expect(await page.evaluate(() => document.body.children.length)).toBe(before - 1)
    await page.evaluate(() => window.__walkAgent?.bar.tick('rotated', true)) // state changes, nothing is drawn
    expect(await bar()).toBe(false)
    await page.evaluate(() => window.__walkAgent?.setMeasuring(false))
    expect(await bar()).toBe(true)
    expect(
      await page.evaluate(() => document.getElementById('walk-bar')?.shadowRoot?.textContent),
    ).toContain('rotated')
    // A judge prompt answers through the log.
    await page.evaluate(() =>
      window.__walkAgent?.bar.show({ kind: 'judge', text: 'Drawn?', id: 'M35', n: 2 }),
    )
    await page.evaluate(() => {
      const first = document.getElementById('walk-bar')?.shadowRoot?.querySelector('button')
      first?.click()
    })
    await until('answer', () => r.events().some((e) => e.type === 'answer'))
    // Every tap on the bar asks for the wake lock (best effort; a denial is only recorded).
    expect(r.events().some((e) => e.type === 'wake' && e.reason === 'tap')).toBe(true)
    expect(r.events().find((e) => e.type === 'answer')).toMatchObject({
      id: 'M35',
      n: 2,
      value: 'pass',
    })
    expect(r.events().some((e) => e.type === 'prompt' && e.kind === 'judge')).toBe(true)
  } finally {
    await r.close()
  }
})

test('walk: a page opened without the run token or with a wrong one has no agent and says nothing @slow @webkit-gpu', async ({
  page,
}) => {
  const r = await rig()
  try {
    await page.goto(`${r.a}/page.html`)
    expect(await page.evaluate(() => window.__walkAgent)).toBeUndefined()
    await page.goto(`${r.a}/page.html?walk=${'9'.repeat(32)}&run=r`)
    await new Promise((res) => setTimeout(res, 1500))
    expect(await page.evaluate(() => window.__walkAgent?.state().connected)).toBe(false)
    expect(r.events()).toEqual([])
  } finally {
    await r.close()
  }
})

test('walk: a page hidden during a measuring window interrupts that attempt, keeps no data, and offers Redo this check @slow @webkit-gpu', async ({
  page,
}) => {
  const r = await rig()
  try {
    await page.goto(r.page())
    await until(
      'connected',
      async () => !!(await page.evaluate(() => window.__walkAgent?.state().connected)),
    )
    await page.evaluate(() => window.__walkAgent?.beginMeasure('M09b-fill-rate', 2))
    await until(
      'frames recorded',
      async () => ((await page.evaluate(() => window.__walkAgent?.rafStats().frames)) ?? 0) > 5,
    )
    expect(await page.evaluate(() => document.getElementById('walk-bar') !== null)).toBe(false)
    await hidePage(page)
    const m = await page.evaluate(() => window.__walkAgent?.measure())
    expect(m).toMatchObject({ on: false, interrupted: true })
    // Nothing recorded before the gap survives it.
    expect(await page.evaluate(() => window.__walkAgent?.rafStats().frames)).toBe(0)
    await showPage(page)
    const sheet = await page.evaluate(
      () => document.getElementById('walk-bar')?.shadowRoot?.textContent ?? '',
    )
    expect(sheet).toContain('Redo this check')
    await until('interrupted attempt in the log', () =>
      r
        .events()
        .some(
          (e) =>
            e.type === 'attempt' &&
            e.status === 'interrupted' &&
            e.id === 'M09b-fill-rate' &&
            e.n === 2,
        ),
    )
    await page.evaluate(() =>
      (
        document
          .getElementById('walk-bar')
          ?.shadowRoot?.querySelector('button') as HTMLButtonElement | null
      )?.click(),
    )
    await until('redo', () =>
      r.events().some((e) => e.type === 'redo' && e.id === 'M09b-fill-rate'),
    )
    expect(await page.evaluate(() => window.__walkAgent?.measure().interrupted)).toBe(false)
    expect(await page.evaluate(() => document.getElementById('walk-bar') !== null)).toBe(false) // the sheet closed
  } finally {
    await r.close()
  }
})
