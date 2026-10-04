// `pnpm device:walk --auto`'s reference-game checks of delegation 4 (docs/plan/39f-device-auto-runner.md steps
// 10-12) end to end in headless Chromium and WebKit: a fake phone (`fake-phone.mjs`) is the person, the
// release build of `games/reference` (and its bench/check build) is served by `device-serve --walk`
// (`support/walk-rig.ts`, `--no-build`: `pnpm test`'s `reference` step built `dist/`).
// What a headless engine cannot do is simulated and said so in each test: the app switch is a
// `visibilitychange` with `document.hidden` overridden (`simulateVisibility`), the memory-pressure kill is
// not simulated at all (a reload is a closed and reopened page), a lost WebGPU device is the page's own
// device `destroy()`ed through a handle the test's init script keeps. All `@slow @webkit-gpu`.
import { expect, type Page, test } from '@playwright/test'
import { type Final, fake, finalOf, type Handler, start } from './support/walk-rig.js'

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
