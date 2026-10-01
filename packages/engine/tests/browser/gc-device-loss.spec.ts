// `device loss then zero-GC window @slow` (docs/plan/37b-device-loss.md step 5, Exit criteria 3): a
// real connected client panning under a real renderer (`gc-device-loss.ts`), the device lost on
// purpose and rebuilt, then the standard M04 window (two 600-frame windows, 0016/0028) on `main` and
// every worker isolate against `gc.pages.device-loss` in `budgets.json` -- the `connected-terrain`
// rows unchanged (0029: a budget is never moved to fit). The loss itself is outside the window
// (0016 §2); what is measured is the device generation after recovery and the client worker after it
// answered `RENDERER_RESET`.
import { expect, test } from '@playwright/test'
import { gcPage } from '../support/budgets.ts'
import { measure } from './gc/instrument.ts'
import type {} from './support/device-loss-window.d.ts'
import { expectAdapter } from './support/gpu.ts'
import { allowDeviceLoss, openPage } from './support/page.ts'

test('device loss then zero-GC window @slow', async ({ page, browser }, testInfo) => {
  await openPage(page, '/gc-device-loss.html')
  allowDeviceLoss(page)
  const isolates = Object.keys(gcPage('device-loss').isolates)
  const lost = await page.evaluate(() => window.__lossThenGc?.loseAndRecover())
  expect(lost?.generation, 'the device was rebuilt once').toBe(1)
  expect(lost?.outageFrames).toBeGreaterThan(0)

  const r = await measure(page, browser, { pageId: 'device-loss', control: null })
  expectAdapter(testInfo, (r.adapter as Parameters<typeof expectAdapter>[1]) ?? null)
  expect(r.crossOriginIsolated).toBe(true)
  expect(r.errors, 'errors').toEqual([])
  for (const name of isolates) {
    expect(r.presentIsolates, `${name} thread present in trace`).toContain(name)
    if (name === 'main') continue
    expect(r.memoryBytes.after[name], `${name} memoryBytes`).toBe(r.memoryBytes.before[name])
    expect(r.memGrows[name], `${name} memGrows`).toBe(0)
  }
  const A = Object.fromEntries(isolates.map((n) => [n, true]))
  const detail = JSON.stringify(
    {
      mode: r.mode,
      bytesPerFrame: r.bytesPerFrame,
      attributedBytesPerFrame: r.attributedBytesPerFrame,
      gc: r.gc,
      byFn: r.byFn,
      windowBytes: r.windowBytes,
      windowByFn: r.windowByFn,
      verdict: r.verdict,
    },
    null,
    2,
  )
  expect(r.verdict, detail).toEqual({ pass: true, A, B: A })
})
