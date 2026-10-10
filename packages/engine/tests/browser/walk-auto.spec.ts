// `pnpm device:walk --auto`'s checks of delegation 2 (M39f steps 5-6)
// end to end in headless Chromium and WebKit: a fake phone (`fake-phone.mjs`: a Playwright page doing
// what Tyler does with his finger) opens the runner page of a real round, and the real pages are served
// by `device-serve --walk` (the fixture app's own `vite preview`, agent injected at serve time). What the
// phone collects goes to the real phone API; the step machine judges it against `checks.mjs`. No tunnel:
// the loopback origin is the origin. Hardware numbers (GPU p95, flush p95) are not asserted to pass in a
// headless engine; their shape, their `by: auto`, and the flow are. All are `@slow` and `@webkit-gpu`.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const lib = new URL('../../../../scripts/lib/device-walk/', import.meta.url).href
type Ev = Record<string, unknown> & { type: string; id?: string; n?: number; src?: unknown }
type Started = {
  joinUrl: string
  stop(): Promise<void>
  machine: { done(): boolean }
}
type Run = {
  events(): Ev[]
  results(): Ev[]
  stop(): Promise<void>
  phone(page: Page, o?: Record<string, unknown>): Promise<Record<string, unknown>>
  until(what: string, fn: () => boolean, ms?: number): Promise<void>
}
type Final = Ev & {
  result: string
  by: string
  attempt: number
  notes?: string
  criteria: { name: string; value: unknown; ok: boolean | null }[]
  metrics: Record<string, unknown>
  evidence?: string
}

async function start(
  ids: string[],
  params: Record<string, unknown> = {},
  desktop = false,
): Promise<Run> {
  const auto = (await import(`${lib}auto-cli.mjs`)) as {
    startAutoRound(o: Record<string, unknown>): Promise<Started>
  }
  const serve = (await import(`${lib}spawn-serve.mjs`)) as {
    spawnServe(args: string[], io: unknown): unknown
  }
  const rounds = (await import(`${lib}rounds.mjs`)) as { readEvents(f: string): Ev[] }
  const parse = (await import(`${lib}parse.mjs`)) as {
    parseChecks(t: string): { items: { id: string }[] }
  }
  const fake = (await import(`${lib}fake-phone.mjs`)) as {
    walkAsPhone(p: Page, o: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  const text = readFileSync(
    new URL('../../../../docs/plan/device-checks.md', import.meta.url),
    'utf8',
  )
  const items = parse.parseChecks(text).items.filter((i) => ids.includes(i.id))
  const dir = mkdtempSync(join(tmpdir(), 'walk-auto-'))
  const file = join(dir, 'r.jsonl')
  // The chromium and the engines legs run at once, each with its own parallel indexes: ports per project.
  const port =
    14800 + (test.info().project.name === 'chromium' ? 0 : 200) + test.info().parallelIndex * 20
  // `--no-build`: `pnpm test`'s `pages` step built the fixture app; this serves that output.
  const round = await auto.startAutoRound({
    round: 'spec',
    file,
    seriesDir: join(dir, 'series'),
    items,
    only: ids,
    tunnel: false,
    params: { probeMs: 700, ...params },
    basePort: port,
    wsBasePort: port + 1,
    log: () => {},
    spawnServe: (args: string[], io: unknown) => serve.spawnServe([...args, '--no-build'], io),
    ...(desktop ? { desktop: async () => 0.05 } : {}),
  })
  const events = () => rounds.readEvents(file)
  return {
    events,
    results: () => events().filter((e) => e.type === 'result'),
    stop: () => round.stop(),
    phone: (page, o = {}) =>
      fake.walkAsPhone(page, {
        runnerUrl: round.joinUrl,
        isDone: () => round.machine.done(),
        ...o,
      }),
    until: async (what, fn, ms = 60_000) => {
      const t0 = Date.now()
      while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 100))
      }
    },
  }
}

const finalOf = (r: Run, id: string) => r.results().find((e) => e.id === id) as Final

test('walk-auto: the static family (determinism, worldgen with the Mac-side desktop median, OPFS latency) is walked with no human input @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const ids = [
    'M03-determinism',
    'M08-worldgen-ms-per-chunk',
    'M08-warn-threshold',
    'M23-opfs-latency',
  ]
  const r = await start(ids, {}, true)
  try {
    const seen = await r.phone(page, { timeoutMs: 150_000 })
    expect(seen).toMatchObject({ judged: 0, rotated: 0, redone: 0 })
    const res = r.results() as Final[]
    expect(res.map((e) => e.id)).toEqual(ids)
    for (const e of res) {
      expect(e.by, e.id).toBe('auto')
      expect(['pass', 'fail'], e.id).toContain(e.result)
      expect(e.criteria.length, e.id).toBeGreaterThan(0)
    }
    // Determinism is not a hardware number: the page's own banner, checkpoints and isolation.
    expect(finalOf(r, 'M03-determinism').result).toBe('pass')
    expect(finalOf(r, 'M03-determinism').criteria.map((c) => c.name)).toEqual([
      'banner',
      'checkpoint_mismatches',
      'cross_origin_isolated',
    ])
    // The numbers the page reported reached the log as metrics (what `--apply` writes as **Run on**).
    expect(typeof finalOf(r, 'M08-worldgen-ms-per-chunk').metrics.median_ms).toBe('number')
    expect(finalOf(r, 'M08-warn-threshold').metrics).toMatchObject({ desktop_median_ms: 0.05 })
    expect(typeof finalOf(r, 'M23-opfs-latency').metrics.append_p95_ms).toBe('number')
    // The raw page data is evidence beside the log, and the log names it.
    expect(finalOf(r, 'M03-determinism').evidence).toMatch(/M03-determinism-1\.json$/)
    // The phone's environment came with the round, from the agent, not from a form.
    const env = r.events().find((e) => e.type === 'env') as Ev & { ua: string; gpu: unknown }
    expect(env.ua).toBe(await page.evaluate(() => navigator.userAgent))
    expect(env.gpu).toBeTruthy()
  } finally {
    await r.stop()
  }
})

test('walk-auto: device.html boot and the fill-rate windows (a window per orientation, a rotate prompt between, the ladder when it fails) @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const ids = ['M11-boot', 'M09b-fill-rate']
  const r = await start(ids, { windowMs: 3000, warmupMs: 0, actTimeoutMs: 20_000 })
  try {
    const seen = await r.phone(page, { timeoutMs: 220_000, judge: 'pass' })
    expect(
      seen.rotated,
      'the fake phone rotated once per fill-rate attempt',
    ).toBeGreaterThanOrEqual(1)
    const boot = finalOf(r, 'M11-boot')
    expect(boot).toMatchObject({ result: 'pass', by: 'auto' })
    expect(boot.criteria.map((c) => c.name)).toEqual([
      'isolated',
      'adapter',
      'workers_ready',
      'delivery',
    ])
    expect(boot.metrics.delivery).toBe('posted Module')
    // The fill-rate check always ends in one result; its first attempt has two windows in two orientations.
    const fill = finalOf(r, 'M09b-fill-rate')
    expect(['pass', 'fail']).toContain(fill.result)
    expect(['auto', 'mixed']).toContain(fill.by)
    const first = r
      .events()
      .find(
        (e) => e.type === 'attempt' && e.id === 'M09b-fill-rate' && e.status === 'done',
      ) as Ev & { evidence: string }
    const data = JSON.parse(readFileSync(first.evidence, 'utf8')) as {
      windows: {
        orientation: string
        samples: { t: number; raf_p95_ms: number }[]
        raf: { frames: number }
      }[]
    }
    expect(data.windows.map((w) => w.orientation).sort()).toEqual(['landscape', 'portrait'])
    for (const w of data.windows) {
      expect(w.samples.length, 'one reading a second for the window').toBeGreaterThanOrEqual(2)
      expect(w.raf.frames).toBeGreaterThan(10)
      expect(typeof w.samples[0]?.raf_p95_ms).toBe('number')
    }
    // The rotate prompt came between the windows (the bar is not on screen while one is measured).
    expect(seen.sheets as string[]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Rotate the phone/)]),
    )
  } finally {
    await r.stop()
  }
})

test('walk-auto: a page hidden during a measuring window discards that attempt and offers a redo, never a failure @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const r = await start(['M09b-fill-rate'], { windowMs: 4000, warmupMs: 0, actTimeoutMs: 20_000 })
  const visibility = (hidden: boolean) =>
    page.evaluate((h) => {
      for (const [k, v] of [
        ['hidden', h],
        ['visibilityState', h ? 'hidden' : 'visible'],
      ] as const)
        Object.defineProperty(document, k, { configurable: true, get: () => v })
      document.dispatchEvent(new Event('visibilitychange'))
    }, hidden)
  try {
    const hide = async () => {
      await r.until('the first attempt to be opened', () =>
        r.events().some((e) => e.type === 'attempt' && e.n === 1 && e.status === undefined),
      )
      // The page loads, the window opens, a couple of seconds in the screen "locks".
      await page.waitForFunction(() => window.__walkAgent?.measure().on === true, undefined, {
        timeout: 60_000,
        polling: 100,
      })
      await new Promise((res) => setTimeout(res, 1500))
      await visibility(true)
      await r.until('the interrupted attempt in the log', () =>
        r.events().some((e) => e.type === 'attempt' && e.status === 'interrupted'),
      )
      await visibility(false)
    }
    const [seen] = await Promise.all([r.phone(page, { timeoutMs: 170_000 }), hide()])
    expect(seen.redone).toBe(1)
    const ev = r.events()
    const attempts = ev.filter((e) => e.type === 'attempt' && e.id === 'M09b-fill-rate')
    expect(attempts.find((e) => e.status === 'interrupted')).toMatchObject({
      n: 1,
      reason: 'hidden',
    })
    // No data from the interrupted attempt: no series for n=1; attempt 2 (same rung) carries the result.
    expect(ev.some((e) => e.type === 'series' && e.n === 1)).toBe(false)
    expect(ev.some((e) => e.type === 'redo' && e.id === 'M09b-fill-rate')).toBe(true)
    expect(attempts.some((e) => e.n === 2 && e.status === undefined && e.rung === 0)).toBe(true)
    expect(finalOf(r, 'M09b-fill-rate').attempt).toBeGreaterThanOrEqual(2)
  } finally {
    await r.stop()
  }
})

test('walk-auto: the memory probe: a reload mid-probe is the failure (fail at step N), then the ladder runs @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const r = await start(['M11-memory'], { probeS: 4 })
  try {
    const reloadOnce = async () => {
      await r.until('the probe attempt', () =>
        r.events().some((e) => e.type === 'attempt' && e.id === 'M11-memory' && e.n === 1),
      )
      // Past the scratch-memory step and into a session: the page dies the way iOS kills a tab.
      await page.waitForFunction(
        () =>
          (window as unknown as { __check?: { readings(): { steps?: string[] } } }).__check
            ?.readings()
            .steps?.some((l) => l.startsWith('(2) touch=0:')),
        undefined,
        { timeout: 90_000, polling: 200 },
      )
      await new Promise((res) => setTimeout(res, 1500)) // the driver stores the lines once a second
      await page.reload()
    }
    await Promise.all([r.phone(page, { timeoutMs: 200_000 }), reloadOnce()])
    const ev = r.events()
    const done = ev.filter(
      (e) => e.type === 'attempt' && e.id === 'M11-memory' && e.status === 'done',
    )
    expect(done.map((a) => [a.n, a.outcome])).toEqual([
      [1, 'fail'],
      [2, 'pass'],
    ])
    expect(
      ev
        .filter((e) => e.type === 'attempt' && e.id === 'M11-memory' && e.status === undefined)
        .map((e) => [e.n, e.rung]),
    ).toEqual([
      [1, 0],
      [2, 1],
    ])
    const first = done[0] as Ev & {
      criteria: { name: string; ok: boolean }[]
      metrics: Record<string, unknown>
    }
    expect(first.criteria.filter((c) => !c.ok).map((c) => c.name)).toContain('reloads')
    expect(String(first.metrics.last_line)).toMatch(/touch=0/) // fail at step N: the last line reached
    const res = finalOf(r, 'M11-memory')
    expect(res).toMatchObject({ result: 'fail', by: 'auto' })
    expect(res.notes).toBe('fails in its default configuration; passes with &sim=64&client=32')
    expect(res.metrics).toMatchObject({ ladder_pass: '&sim=64&client=32' })
    const second = ev.find(
      (e) => e.type === 'attempt' && e.n === 2 && e.id === 'M11-memory',
    ) as Ev & { page: string }
    expect(second.page).toBe('device.html?probe=memory&sim=64&client=32&probeS=4')
  } finally {
    await r.stop()
  }
})
