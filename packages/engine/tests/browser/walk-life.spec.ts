// `pnpm device:walk --auto`'s lifecycle and choreography checks of delegation 3 (docs/plan/39f-device-auto-
// runner.md steps 7-8) end to end in headless Chromium and WebKit: a fake phone (`fake-phone.mjs`) is the
// person, the fixture pages are served by `device-serve --walk` (`support/walk-rig.ts`). What a headless
// engine cannot do is simulated and said so in the test: the app switch and the lock screen are a
// `visibilitychange` with `document.hidden` overridden (`simulateVisibility`), Low Power Mode is every
// second animation frame dropped (`simulateLowPower`), Private Browsing is the page's own `?noOpfs=1`, a
// swiped-away Safari is a closed page and a new one on the join URL. All `@slow @webkit-gpu`.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type Final, fake, finalOf, type Handler, sleep, start } from './support/walk-rig.js'

const crit = (e: { criteria: { name: string; value: unknown; ok: boolean | null }[] }, n: string) =>
  e.criteria.find((c) => c.name === n)

test('walk-life: slice boot (M03 inherited from the round, terrain drawn, one confirm tap) and the ten-paint round trip @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const ids = ['M03-determinism', 'M16-slice-boot', 'M16-round-trip']
  const r = await start(ids)
  try {
    const seen = await r.phone(page, { timeoutMs: 170_000 })
    expect(seen.judged, 'one confirm tap, for slice-boot only').toBe(1)
    const boot = finalOf(r, 'M16-slice-boot')
    expect(boot).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(crit(boot, 'm03_criterion')).toMatchObject({ value: true, ok: true })
    expect(crit(boot, 'terrain_drawn')).toMatchObject({ value: true, ok: true })
    expect(crit(boot, 'workers_ready')).toMatchObject({ ok: true })
    const rt = finalOf(r, 'M16-round-trip')
    expect(rt).toMatchObject({ result: 'pass', by: 'auto' })
    expect(rt.criteria.map((c) => [c.name, c.value])).toEqual([
      ['confirmed', 10],
      ['rejected', 0],
      ['ring_drops', 0],
    ])
    expect(typeof rt.metrics.confirm_latency_max_ms).toBe('number')
  } finally {
    await r.stop()
  }
})

test('walk-life: coexist (a window with scripted pan and paints), background (two deliberate leaves, measured across the hide) and low power (a 30 Hz cadence, two flicks) @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const f = await fake()
  const ids = ['M16-coexist', 'M16-background', 'M16-low-power']
  const r = await start(ids, { windowMs: 3000, warmupMs: 0, leaveMs: 1500, actTimeoutMs: 30_000 })
  const leaves: number[] = []
  const handlers: Handler[] = [
    {
      // The app switch and the lock screen: the page is hidden for the stated time, then comes back.
      match: /^(Switch to another app|Lock the screen) for/,
      run: async ({ page: p, bar }) => {
        const secs = Number(/for ([\d.]+) seconds/.exec(bar.text)?.[1])
        await new Promise((res) => setTimeout(res, 300)) // let the sheet draw
        await f.simulateVisibility(p, true, { pagehide: true })
        await new Promise((res) => setTimeout(res, secs * 1000))
        await f.simulateVisibility(p, false)
        leaves.push(secs)
      },
    },
    {
      match: /^Turn Low Power Mode on/,
      run: async ({ page: p }) => {
        await f.simulateLowPower(p)
      },
    },
  ]
  try {
    const seen = await r.phone(page, { timeoutMs: 230_000, handlers })
    expect(leaves).toEqual([1.5, 1.5])
    // Nothing was discarded: the leaves were the event under test, never a window interrupted by a hide.
    const ev = r.events()
    expect(ev.some((e) => e.type === 'attempt' && e.status === 'interrupted')).toBe(false)
    expect(seen.redone).toBe(0)

    const co = finalOf(r, 'M16-coexist')
    expect(['auto', 'mixed']).toContain(co.by)
    expect(crit(co, 'reloads')).toMatchObject({ value: 0, ok: true })
    expect(crit(co, 'engine_mem_grows')).toMatchObject({ value: 0, ok: true })
    expect(Number(co.metrics.paints)).toBeGreaterThanOrEqual(2)

    // The simulated hide cannot stop slice.html's sim (a real phone suspends the worker), so the tick
    // criterion may fail here; what is proved is the flow: two leaves measured, the frame loop resumed.
    const bg = finalOf(r, 'M16-background')
    expect(bg.by).toBe('auto')
    expect(crit(bg, 'left_twice')).toMatchObject({ value: 2, ok: true })
    expect(crit(bg, 'frame_loop_resumed')).toMatchObject({ value: true, ok: true })
    expect(crit(bg, 'reloads')).toMatchObject({ value: 0, ok: true })
    expect(typeof crit(bg, 'tick_advanced_while_hidden')?.value).toBe('number')
    expect(Number(bg.metrics.hidden_ms)).toBeGreaterThanOrEqual(1050)

    const lp = finalOf(r, 'M16-low-power')
    // M39m: the ratio is a failable criterion (0.95-1.05), no longer a judge sheet, so the item is `auto`.
    expect(lp).toMatchObject({ result: 'pass', by: 'auto' })
    expect(crit(lp, 'low_power_detected')).toMatchObject({ value: true, ok: true })
    expect(Number(lp.metrics.rafp50_low_power_ms)).toBeGreaterThan(25)
    expect(Number(lp.metrics.rafp50_normal_ms)).toBeLessThanOrEqual(20)
    expect(crit(lp, 'flick_distance_ratio')).toMatchObject({ ok: true })
    expect(crit(lp, 'flick_distance_ratio_max')).toMatchObject({ ok: true })
  } finally {
    await r.stop()
  }
})

type Rig = Awaited<ReturnType<typeof start>>

/** The fake person of the world checks: every prompt the five of them can show. */
function worldHandlers(page: Page, r: Rig, f: Awaited<ReturnType<typeof fake>>): Handler[] {
  const ctx = page.context()
  let exported = ''
  return [
    {
      match: /^Switch to another app for/,
      run: async ({ page: p, bar }) => {
        const secs = Number(/for ([\d.]+) seconds/.exec(bar.text)?.[1])
        await sleep(300)
        await f.simulateVisibility(p, true, { pagehide: true })
        await sleep(secs * 1000)
        await f.simulateVisibility(p, false)
      },
    },
    {
      // Private Browsing: a second tab on the link from the bar; the page's own `?noOpfs=1` is its
      // `durable: false` (a headless context cannot be made private).
      match: /^Open this link in a Private tab: /,
      run: async ({ bar }) => {
        const url = /Private tab: (\S+?)(?:[○✓]|$)/.exec(bar.text)?.[1] as string
        const second = await ctx.newPage()
        const u = new URL(url)
        u.searchParams.set('world', 'walk-private-sim') // a Private tab has its own storage and locks
        u.searchParams.set('noOpfs', '1')
        await second.goto(u.href)
      },
    },
    {
      match: (bar) => bar.buttons.includes('Open second tab'),
      run: async ({ page: p }) => {
        await Promise.all([ctx.waitForEvent('page'), f.tapBar(p, 'Open second tab')])
      },
    },
    {
      // Safari swiped away: the page is gone (no `pagehide` courtesy), the phone opens the QR link again.
      match: /^Swipe Safari away/,
      run: async ({ page: p }) => {
        await p.close()
        const again = await ctx.newPage()
        await again.goto(r.joinUrl)
        return { page: again }
      },
    },
    {
      match: /^Tap Export on the page/,
      run: async ({ page: p }) => {
        const [dl] = await Promise.all([
          p.waitForEvent('download'),
          p.locator('#export-btn').dispatchEvent('click'),
        ])
        exported = join(tmpdir(), `walk-life-${Date.now()}.world`)
        await dl.saveAs(exported)
      },
    },
    {
      match: /^Now choose the downloaded file/,
      run: async ({ page: p, bar }) => {
        const id = /type the id (\S+),/.exec(bar.text)?.[1] as string
        await p.locator('#import-file').setInputFiles(exported)
        await p.locator('#import-worldid').fill(id)
        await p.locator('#import-btn').dispatchEvent('click')
        await p.waitForFunction(() =>
          /^imported as/.test(document.getElementById('world-op-status')?.textContent ?? ''),
        )
        await Promise.all([ctx.waitForEvent('page'), f.tapBar(p, 'Open the imported world')])
      },
    },
  ]
}

async function worldRound(page: Page, id: string, port: number) {
  const f = await fake()
  const r = await start([id], { leaveMs: 1500, playMs: 3000, actTimeoutMs: 40_000 }, port)
  try {
    const seen = await r.phone(page, { timeoutMs: 100_000, handlers: worldHandlers(page, r, f) })
    // Every hide here was the event under test: nothing was interrupted, discarded or retried.
    expect(r.events().some((e) => e.type === 'attempt' && e.status === 'interrupted')).toBe(false)
    return { r, seen, res: finalOf(r, id) as Final }
  } finally {
    await r.stop()
  }
}

// Playwright's WebKit has no durable OPFS in a test context (the page itself reports `durable: false`), so
// there the world checks are proved as a flow (the round finishes, every criterion is measured, by the
// right hand) and not as a pass; Chromium has OPFS and passes them for real.
const strict = () => test.info().project.name === 'chromium'
const outcome = (e: Final, by: string[]) => {
  expect(by, JSON.stringify(e)).toContain(e.by)
  expect(['pass', 'fail'], JSON.stringify(e)).toContain(e.result)
  if (strict()) expect(e.result, JSON.stringify(e)).toBe('pass')
}

test('walk-life: M23-hidden-pause leaves the app on purpose; the world pauses and the second Paint reads a few ticks on @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { res: hp } = await worldRound(page, 'M23-hidden-pause', 15500)
  outcome(hp, ['mixed', 'auto'])
  expect(Number(hp.metrics.hidden_ms)).toBeGreaterThanOrEqual(1050)
  // The world paused for the hide: a few ticks, not the ~20 a second a running one racks up.
  expect(Number(crit(hp, 'tick_delta')?.value)).toBeLessThan(40)
  expect(crit(hp, 'durable')?.value).toBe(strict())
  expect(crit(hp, 'reloads')).toMatchObject({ value: 0, ok: true })
})

test('walk-life: M23-private is measured in a second tab opened from the link on the bar, which sends the result @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { res: pr } = await worldRound(page, 'M23-private', 15600)
  outcome(pr, ['auto'])
  expect(crit(pr, 'durable')).toMatchObject({ value: false, ok: true })
  expect(Number(crit(pr, 'tick_advanced')?.value)).toBeGreaterThanOrEqual(1)
})

test('walk-life: M23-world-busy opens a second tab from the bar; both report and the first keeps playing @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { r, res: busy } = await worldRound(page, 'M23-world-busy', 15700)
  outcome(busy, ['auto'])
  expect(busy.criteria.map((c) => [c.name, c.value, c.ok])).toEqual([
    ['second_tab_busy', true, true],
    ['second_tab_banner', true, true],
    ['first_keeps_playing', false, true],
  ])
  // The second tab is a second tab of one attempt, not a reload of the first: one attempt, no retry.
  expect(r.events().filter((e) => e.type === 'attempt' && e.status === undefined)).toHaveLength(1)
})

test('walk-life: M23-kill-resume keeps the before reading on the service, the page is killed, a new one on the join URL compares @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { r, res: kill } = await worldRound(page, 'M23-kill-resume', 15800)
  expect(['auto']).toContain(kill.by)
  expect(['pass', 'fail']).toContain(kill.result)
  expect(r.events().some((e) => e.type === 'reading' && e.key === 'before')).toBe(true)
  expect(Number(kill.metrics.admitted_before)).toBeGreaterThanOrEqual(2)
  expect(typeof kill.metrics.tick_after).toBe('number')
  if (strict()) {
    expect(kill.result).toBe('pass')
    expect(crit(kill, 'admitted_actions_lost')).toMatchObject({ value: 0, ok: true })
    expect(Number(kill.metrics.tick_after)).toBeGreaterThanOrEqual(
      Number(kill.metrics.tick_last_action),
    )
  }
})

test("walk-life: M23-export-import: the page's own Export and Import, the imported world opened from the bar and read @slow @webkit-gpu", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const { seen, res: ex } = await worldRound(page, 'M23-export-import', 15900)
  expect(seen.judged).toBe(1)
  outcome(ex, ['mixed'])
  expect(crit(ex, 'imported_loads')).toMatchObject({ value: true, ok: true })
  expect(Number(ex.metrics.export_bytes)).toBeGreaterThan(0)
})

// --- M29: the drop choreographer (mp.html against `--ws puts`) ------------------------------------------
declare global {
  interface Window {
    __mpLinkEvent?: (state: 'up' | 'down', reason?: string) => void
  }
}
const SCENARIO_MS = {
  'app-5s': 1200,
  'app-30s': 1200,
  'app-5min': 1200,
  'lock-60s': 1200,
  'airplane-15s': 1200,
}
const link = (p: Page, state: 'up' | 'down') =>
  p.evaluate((s) => window.__mpLinkEvent?.(s, 'close'), state)

/**
 * The person doing M29's drops, simulated: a hide (app switch, lock screen) is `visibilitychange` plus the
 * net worker's report that the socket closed (the real net worker's socket is untouched in a headless page,
 * so the report is injected with the page's own `__mpLinkEvent`); a drop in front of the person is the same
 * report with `offline` and `online`. The reconnect it measures is the injected "up", not a real radio.
 */
function dropHandlers(f: Awaited<ReturnType<typeof fake>>, shortFirst: string | null): Handler[] {
  let cut = false
  return [
    {
      match: /(Switch to another app|Lock the screen) for/,
      run: async ({ page: p, bar }) => {
        const secs = Number(/for ([\d.]+) seconds/.exec(bar.text)?.[1])
        const stay = shortFirst && bar.text.includes(`(${shortFirst})`) && !cut ? 0.5 : secs
        if (stay !== secs) cut = true // one run too short: the service must ask for it again
        await sleep(300)
        await f.simulateVisibility(p, true, { pagehide: true })
        await link(p, 'down')
        await sleep(stay * 1000)
        await f.simulateVisibility(p, false)
        await sleep(300)
        await link(p, 'up')
      },
    },
    {
      match: /Turn Wi-Fi off/,
      run: async ({ page: p }) => {
        await sleep(300)
        await link(p, 'down')
        await sleep(1500) // past the 1 s the link waits before it shows a reconnect
        await link(p, 'up')
      },
    },
    {
      match: /Turn airplane mode on for/,
      run: async ({ page: p, bar }) => {
        const secs = Number(/for ([\d.]+) seconds/.exec(bar.text)?.[1])
        await sleep(300)
        await p.evaluate(() => window.dispatchEvent(new Event('offline')))
        await link(p, 'down')
        await sleep(secs * 1000)
        await p.evaluate(() => window.dispatchEvent(new Event('online')))
        await sleep(300)
        await link(p, 'up')
      },
    },
  ]
}

test('walk-life: M29-socket-resume: six drops, a run outside +-30% is asked for again; M29-play-through-drop reads the same runs @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const f = await fake()
  const ids = ['M29-socket-resume', 'M29-play-through-drop']
  const r = await start(ids, { runsEach: 1, scenarioMs: SCENARIO_MS, actTimeoutMs: 30_000 }, 16100)
  try {
    const seen = await r.phone(page, { timeoutMs: 230_000, handlers: dropHandlers(f, 'app-5s') })
    const runs = r.events().filter((e) => e.type === 'reading' && e.key === 'run')
    const data = runs.map((e) => e.data as Record<string, unknown>)
    expect(data.map((d) => d.scenario)).toEqual([
      'app-5s',
      'app-5s', // the first was 0.5 s of 1.2 s: outside, repeated
      'app-30s',
      'app-5min',
      'lock-60s',
      'wifi-cellular',
      'airplane-15s',
    ])
    expect(Number(data[0]?.ms)).toBeLessThan(840)
    expect(seen.sheets as string[]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^That run was 0\.\d s, outside the time asked/),
      ]),
    )
    const sr = finalOf(r, 'M29-socket-resume')
    expect(sr).toMatchObject({ result: 'pass', by: 'auto' })
    expect(sr.metrics.runs).toBe(6) // the repeated one is not one of the six
    expect(Number(crit(sr, 'visible_to_welcome_max_ms')?.value)).toBeLessThan(4000)
    // Every run of the hides saw the socket close and the Welcome come back.
    for (const d of data.filter((x) =>
      ['app-30s', 'app-5min', 'lock-60s'].includes(String(x.scenario)),
    )) {
      expect(d.dropped).toBe(true)
      expect(typeof d.welcomeMs).toBe('number')
      expect(d.discarded).toBe(false)
    }
    const pt = finalOf(r, 'M29-play-through-drop')
    expect(pt).toMatchObject({
      result: 'pass',
      by: 'auto',
      notes: 'the same runs as M29-socket-resume',
    })
    expect(crit(pt, 'stayed_interactive')).toMatchObject({ value: true, ok: true })
    expect(crit(pt, 'modal_for_short_outage')).toMatchObject({ value: false, ok: true })
    // 6 drops, not 12: the person was never sent to do them a second time.
    expect(
      r.events().filter((e) => e.type === 'prompt' && /Drop \d of 1 \(/.test(String(e.text)))
        .length,
    ).toBe(7)
  } finally {
    await r.stop()
  }
})

test('walk-life: M29 a page the browser discards mid-run is a discarded run, not a failed attempt @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const f = await fake()
  const r = await start(
    ['M29-socket-resume'],
    { runsEach: 1, scenarioMs: SCENARIO_MS, actTimeoutMs: 30_000 },
    16200,
  )
  const base = dropHandlers(f, null)
  const handlers: Handler[] = [
    {
      // The lock-screen run: the page is discarded (the engine reloads it) instead of coming back.
      match: /\(lock-60s\)/,
      run: async ({ page: p }) => {
        await sleep(300)
        await p.reload()
      },
    },
    ...base,
  ]
  try {
    await r.phone(page, { timeoutMs: 230_000, handlers })
    const data = r
      .events()
      .filter((e) => e.type === 'reading' && e.key === 'run')
      .map((e) => e.data as Record<string, unknown>)
    expect(data.find((d) => d.scenario === 'lock-60s')).toMatchObject({
      discarded: true,
      ms: null,
    })
    expect(r.events().some((e) => e.type === 'attempt' && e.status === 'interrupted')).toBe(false)
    const sr = finalOf(r, 'M29-socket-resume')
    expect(sr.by).toBe('auto')
    expect(sr.metrics.discarded_runs).toBe(true)
    expect(sr.metrics.runs).toBe(6)
  } finally {
    await r.stop()
  }
})

test('walk-life: M29-net-heap: a window of steady Paints with the long-frame counters (hitch proxy) @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const r = await start(['M29-net-heap'], { windowMs: 4000, warmupMs: 0 }, 16300)
  try {
    await r.phone(page, { timeoutMs: 170_000 })
    const nh = finalOf(r, 'M29-net-heap')
    expect(['auto', 'mixed']).toContain(nh.by)
    expect(nh.criteria.map((c) => c.name)).toEqual(['reloads', 'hitch_gaps_over_25ms'])
    expect(crit(nh, 'reloads')).toMatchObject({ value: 0, ok: true })
    // Four Paints a second of steady traffic: one batch per one-second sample of the window.
    const att = r
      .events()
      .find((e) => e.type === 'attempt' && e.id === 'M29-net-heap' && e.status === 'done')
    const series = JSON.parse(readFileSync(att?.evidence as string, 'utf8')) as {
      windows: { samples: unknown[] }[]
    }
    expect(series.windows).toHaveLength(1) // one window, not a retry
    expect(Number(nh.metrics.paints)).toBe(4 * (series.windows[0]?.samples.length ?? -1))
    expect(typeof nh.metrics.raf_gap_max_ms).toBe('number')
  } finally {
    await r.stop()
  }
})
