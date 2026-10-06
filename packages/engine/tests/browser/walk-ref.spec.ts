// `pnpm device:walk --auto`'s reference-game checks of delegation 4 (docs/plan/39f-device-auto-runner.md steps
// 10-12) end to end in headless Chromium and WebKit: a fake phone (`fake-phone.mjs`) is the person, the
// release build of `games/reference` (and its bench/check build) is served by `device-serve --walk`
// (`support/walk-rig.ts`, `--no-build`: `pnpm test`'s `reference` step built `dist/`).
// What a headless engine cannot do is simulated and said so in each test: the app switch is a
// `visibilitychange` with `document.hidden` overridden (`simulateVisibility`), the memory-pressure kill is
// not simulated at all (a reload is a closed and reopened page), a lost WebGPU device is the page's own
// device `destroy()`ed through a handle the test's init script keeps. All `@slow @webkit-gpu`.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { ensureBenchBuild } from './support/reference-build.js'
import { type Final, fake, finalOf, type Handler, type Run, start } from './support/walk-rig.js'

/**
 * What a red M34 round says about itself (M39n): the bot's phases and `diag`, `botView` (roster, circles, the
 * view it decided on), the phone's phases, each attempt's outcome, and the phone's `why` (which join
 * condition failed) from the collected series.
 */
function diagnose(r: Run): string {
  const lines: string[] = []
  for (const e of r.events()) {
    if (e.type === 'reading') lines.push(`${e.key}#${e.n}: ${JSON.stringify(e.data)}`)
    else if (e.type === 'attempt')
      lines.push(
        `attempt ${e.n} ${e.status ?? 'open'} ${JSON.stringify(e.outcome ?? e.reason ?? '')}`,
      )
  }
  try {
    const dir = join(dirname(r.file), 'series')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (d?.why || d?.ready === false) lines.push(`series ${f}: ${JSON.stringify(d.why ?? d)}`)
    }
  } catch {
    // no series yet
  }
  return lines.join('\n')
}

const crit = (e: Final, n: string) => e.criteria.find((c) => c.name === n)

/** Keeps every device the page creates on `window.__devs` (before the agent wraps `requestDevice` on top). */
async function keepDevices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = (self as unknown as { GPUAdapter?: { prototype: Record<string, unknown> } })
      .GPUAdapter?.prototype
    const orig = proto?.requestDevice as ((...a: unknown[]) => Promise<unknown>) | undefined
    if (!proto || !orig) return
    proto.requestDevice = async function (this: unknown, ...a: unknown[]) {
      const d = await orig.apply(this, a)
      const w = window as unknown as { __devs?: unknown[] }
      w.__devs = [...(w.__devs ?? []), d]
      return d
    }
  })
}

test('walk-ref: M35 on the release build, DOM only: the iPhone row is judged, the Mac row is not a phone row; a Mac client walks it @slow @webkit-gpu', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000)
  const ids = ['M35-safari-build-mac', 'M35-safari-build-iphone']
  const r = await start(ids, { observeMs: 2500 }, 15700)
  try {
    const seen = await r.phone(page, { timeoutMs: 150_000 })
    expect(seen.judged, 'one confirm tap').toBe(1)
    const iphone = finalOf(r, 'M35-safari-build-iphone')
    expect(iphone).toMatchObject({ result: 'pass', by: 'mixed' })
    for (const n of [
      'capability_screen',
      'fatal_screen',
      'canvas_present',
      'delivery_line_absent',
      'gpu_errors',
      'device_lost',
      'reloads',
    ])
      expect(crit(iphone, n), n).toMatchObject({ ok: true })
    expect(crit(iphone, 'canvas_present')).toMatchObject({ value: true })
    expect(iphone.metrics.canvas_w).toBeGreaterThan(0)
    expect(typeof iphone.metrics.raf_p95_ms).toBe('number')
    // Simulated: nothing. The release build is served as it ships, plus the injected agent tag.
    const mac = finalOf(r, 'M35-safari-build-mac')
    expect(mac).toMatchObject({ result: 'skip', by: 'auto' })
    expect(mac.notes).toMatch(/Mac browser row/)
  } finally {
    await r.stop()
  }

  // The same row walked by a "Mac" client: a second round, `params.client: 'mac'`, a desktop page.
  const m = await start(['M35-safari-build-mac'], { observeMs: 2500, client: 'mac' }, 15750)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const tab = await ctx.newPage()
  try {
    await m.phone(tab, { timeoutMs: 150_000 })
    expect(finalOf(m, 'M35-safari-build-mac')).toMatchObject({ result: 'pass', by: 'mixed' })
  } finally {
    await ctx.close()
    await m.stop()
  }
})

test('walk-ref: M37b, three leaves with the wrapped device lost during each: counts, banner and rAF per run, a judge tap @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const f = await fake()
  const r = await start(
    ['M37b-ios-background'],
    { leaveMs: 1500, actTimeoutMs: 40_000, timeoutMs: 60_000 },
    15800,
  )
  const handlers: Handler[] = [
    {
      // The tab goes to the background (simulated), the GPU process loses the device meanwhile (the page's
      // newest device `destroy()`ed: the real thing on a phone is memory pressure), and the person comes back.
      match: /^Run \d of 3/,
      run: async ({ page: p, bar }) => {
        const secs = Number(/about ([\d.]+) seconds/.exec(bar.text)?.[1])
        await new Promise((res) => setTimeout(res, 300))
        await f.simulateVisibility(p, true, { pagehide: true })
        await p.evaluate(() => {
          const d = (window as unknown as { __devs?: { destroy(): void }[] }).__devs
          d?.at(-1)?.destroy()
        })
        await new Promise((res) => setTimeout(res, secs * 1000))
        await f.simulateVisibility(p, false)
      },
    },
  ]
  try {
    await keepDevices(page)
    const seen = await r.phone(page, { timeoutMs: 220_000, handlers })
    expect(seen.judged, 'one judge sheet for the three runs').toBe(1)
    const e = finalOf(r, 'M37b-ios-background')
    expect(e).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(crit(e, 'runs_done')).toMatchObject({ value: 3, ok: true })
    expect(crit(e, 'black_or_frozen_runs')).toMatchObject({ value: false, ok: true })
    expect(crit(e, 'reloads')).toMatchObject({ value: 0, ok: true })
    expect(Number(e.metrics.device_lost_total)).toBeGreaterThanOrEqual(2)
    // Two losses within the engine's 10 s window end in the rendererLost prompt: allowed by the Pass text.
    expect(Number(e.metrics.renderer_lost_banners)).toBeGreaterThanOrEqual(1)
  } finally {
    await r.stop()
  }
})

test('walk-ref: M39-large-save and M39-frame-shares read the bench HUD through __check after the warm-up, 1/64 save @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(600_000)
  await ensureBenchBuild()
  // `benchScale: 64` is the 1/64 save (4,096 furnaces): the full one is the phone's, and the device walk
  // reads it after ten seconds; here the window is 12 s with a 4 s warm-up.
  const r = await start(
    ['M39-large-save', 'M39-frame-shares'],
    { windowMs: 12_000, warmupMs: 4000, benchScale: 64, timeoutMs: 90_000 },
    15900,
  )
  try {
    await r.phone(page, { timeoutMs: 240_000 })
    const large = finalOf(r, 'M39-large-save')
    const shares = finalOf(r, 'M39-frame-shares')
    for (const e of [large, shares]) expect(e, e.id as string).toMatchObject({ by: 'auto' })
    // The memory counters and the reload nonce are exact (strict on every engine); the three p95 limits are
    // the phone's (10 / 4 / 8 ms), and a software WebGPU adapter in a headless engine may miss them.
    expect(large.criteria.slice(0, 3).map((c) => [c.name, c.value, c.ok])).toEqual([
      ['engine_mem_grows_sim', 0, true],
      ['engine_mem_grows_client', 0, true],
      ['reloads', 0, true],
    ])
    for (const e of [large, shares]) {
      const readings = e.metrics as Record<string, number>
      expect(
        Number.isFinite(readings.tick_p95_ms ?? readings.tick_p95_ms_last),
        e.id as string,
      ).toBe(true)
    }
    expect(typeof large.metrics.tick_p95_ms).toBe('number')
    expect(typeof large.metrics.ticks).toBe('number')
    expect(typeof shares.metrics.main_p95_ms).toBe('number')
    expect(typeof shares.metrics.frame_p95_ms).toBe('number')
    // The 1/64 save is a world a headless engine plays easily: all five p95 limits hold here.
    expect([large.result, shares.result]).toEqual(['pass', 'pass'])
    // The pages the round walked: the zoom is the scripted one.
    const pages = r
      .events()
      .filter((e) => e.type === 'attempt' && e.status === undefined)
      .map((e) => e.page)
    expect(pages).toEqual([
      '?bench=large-save&scale=64',
      '?bench=large-save&pan=2&zoom=max&scale=64',
    ])
  } finally {
    await r.stop()
  }
})

// M34: the phone and a bot partner (headless Chromium, started by the service) in one world on the check
// build with its own-feature real-time server. Simulated: the "Wi-Fi off" prompt is a tap on its button (the
// link itself is not throttled here), the drop of the bot is its page closing, fingers are `button.click()`
// of the page's own collect button, and the camera is moved by `__check.act.moveTo`.
test('walk-ref: M34-own-timer-bar (three collects per link, tap to result) and M34-remote-motion (the bot walks, goes; per-frame jumps and fade) @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(420_000)
  await ensureBenchBuild()
  const f = await fake()
  const r = await start(
    ['M34-own-timer-bar', 'M34-remote-motion'],
    { timeoutMs: 90_000, botTimeoutMs: 120_000, fadeMs: 12_000, settleMs: 500 },
    16000,
    { botTimings: { walkMs: 6000 } },
  )
  const handlers: Handler[] = [
    {
      match: /^Switch the phone off Wi-Fi now/,
      run: async ({ page: p }) => {
        await new Promise((res) => setTimeout(res, 300))
        await f.tapBar(p, 'Wi-Fi is off')
      },
    },
  ]
  try {
    const seen = await r.phone(page, { timeoutMs: 380_000, handlers })
    expect(seen.judged, 'one confirm tap, for remote-motion only').toBe(1)
    const timer = finalOf(r, 'M34-own-timer-bar')
    // Measured here, on loopback with the engine's own lead: the bar's fill ends before the host's result and
    // stays full for `gap_ms` (see the step's Deviations); the flow is what this test pins: six timed collects
    // on two links, a verdict from the numbers, and the only criterion allowed to fail is the bar waiting.
    test.info().annotations.push({ type: 'own-timer', description: JSON.stringify(timer.metrics) })
    expect(['pass', 'fail']).toContain(timer.result)
    expect(timer).toMatchObject({ by: 'auto' })
    const failed = timer.criteria.filter((c) => c.ok === false).map((c) => c.name)
    expect(
      failed.every((n) => n === 'bar_waiting_after_full'),
      failed.join(),
    ).toBe(true)
    expect(crit(timer, 'links_measured')).toMatchObject({ value: 2, ok: true })
    expect(crit(timer, 'timers_completed')).toMatchObject({ ok: true })
    expect(crit(timer, 'result_before_bar_full')).toMatchObject({ ok: true })
    expect(Number(timer.metrics.runs)).toBe(6)
    expect(typeof timer.metrics.gap_ms_max).toBe('number')
    expect(Number(timer.metrics.bar_ms_median)).toBeGreaterThan(500)
    const motion = finalOf(r, 'M34-remote-motion')
    test
      .info()
      .annotations.push({ type: 'remote-motion', description: JSON.stringify(motion.metrics) })
    // A bot that closes its page is a clean close (0013: `Gone`, its circle vanishes at once; the 2 s fade of
    // 0012 is a viewer's stalled link, `remote-fade.spec.ts`): `vanished_at_once` is a criterion, and the
    // person only confirms "no snap".
    expect(motion, JSON.stringify(motion.criteria)).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(crit(motion, 'remote_moved')).toMatchObject({ ok: true })
    expect(crit(motion, 'vanished_at_once')).toMatchObject({ ok: true })
    expect(Number(motion.metrics.vanish_ms)).toBeLessThanOrEqual(1000)
    expect(Number(motion.metrics.travel_tiles)).toBeGreaterThan(1)
    expect(Number(motion.metrics.frames)).toBeGreaterThan(30)
    // 39l: the drawn remote circle moves on (nearly) every frame while it moves, not once per 10 Hz presence
    // sample (the staircase of a render time that sat far behind the newest sample).
    expect(
      Number(motion.metrics.moving_frames_changed_ratio),
      'share of frames the remote circle changed position',
    ).toBeGreaterThanOrEqual(0.9)
    expect(
      Number(motion.metrics.max_still_ms),
      'longest still stretch while moving',
    ).toBeLessThanOrEqual(50)
  } finally {
    await r.stop()
  }
})

test('walk-ref: M34-two-devices (the bot collects, crafts, places, drops and returns; both sides see each other) @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(420_000)
  await ensureBenchBuild()
  const r = await start(
    ['M34-two-devices'],
    { timeoutMs: 90_000, botTimeoutMs: 150_000, graceMs: 60_000 },
    16100,
  )
  try {
    const seen = await r.phone(page, { timeoutMs: 380_000 })
    expect(seen.judged, `one confirm tap: I see its circle\n${diagnose(r)}`).toBe(1)
    const e = finalOf(r, 'M34-two-devices')
    expect(e, `${JSON.stringify(e.criteria)}\n${diagnose(r)}`).toMatchObject({
      result: 'pass',
      by: 'mixed',
    })
    for (const n of [
      'remote_entity_seen',
      'furnace_seen',
      'bot_sees_phone',
      'roster_dot_hollow_after_drop',
      'roster_dot_filled_on_return',
    ])
      expect(crit(e, n), n).toMatchObject({ ok: true })
  } catch (e) {
    if (e instanceof Error && !e.message.includes('attempt 1')) e.message += `\n${diagnose(r)}`
    throw e
  } finally {
    await r.stop()
  }
})
