// M39ac: M09b-fill-rate on iOS measures one portrait window per rung and asks for no rotation (ADR 0057).
import { describe, expect, test } from 'vitest'
import { CHECKS, evaluate } from './device-walk/checks.mjs'
import { createFakePage } from './device-walk/fake-agent-page.mjs'

const IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'

const item = () => ({
  id: 'M09b-fill-rate',
  n: 1,
  page: 'device.html',
  plan: CHECKS['M09b-fill-rate'].plan,
  opts: { timeoutMs: 8000, windowMs: 3000, warmupMs: 0, actTimeoutMs: 20000 },
})

/** The device page on a virtual clock; every act prompt is recorded and answered by turning the viewport. */
async function setup(userAgent, { landscape = false } = {}) {
  const page = createFakePage({ userAgent })
  await page.connect()
  const w = page.window
  const turn = (l) => {
    w.innerWidth = l ? 800 : 400
    w.innerHeight = l ? 400 : 800
  }
  turn(landscape)
  w.__check = {
    ready: true,
    readings: () => ({ orientation: w.innerWidth >= w.innerHeight ? 'landscape' : 'portrait' }),
    errors: () => [],
  }
  const prompts = []
  const show = page.A.bar.show
  page.A.bar.show = (s) => {
    show(s)
    if (s?.kind !== 'act') return
    prompts.push(s.text)
    turn(/landscape/.test(s.text))
  }
  const run = w.__walkKit.collectors['fill-rate'](item())
  await page.advance(30000)
  return { prompts, data: await run }
}

const windowsRow = (data, platform) =>
  evaluate(CHECKS['M09b-fill-rate'], data, { platform }).criteria.find(
    (c) => c.name === 'windows_measured',
  )

describe('device-walk portrait: M09b on iOS', () => {
  test('device-walk portrait: an iOS page in portrait gets no rotate prompt and passes on one window', async () => {
    const { prompts, data } = await setup(IOS)
    expect(prompts).toEqual([])
    expect(data.windows.map((w) => w.orientation)).toEqual(['portrait'])
    expect(data.portraitOnly).toBe(true)
    expect(windowsRow(data, 'ios')).toMatchObject({ limit: 1, ok: true })
  })

  test('device-walk portrait: an iOS page that starts in landscape gets exactly one portrait prompt', async () => {
    const { prompts, data } = await setup(IOS, { landscape: true })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/portrait/)
    expect(data.windows.map((w) => w.orientation)).toEqual(['portrait'])
  })

  test('device-walk portrait: an Android page still gets the landscape prompt and needs two windows', async () => {
    const { prompts, data } = await setup(ANDROID)
    expect(prompts).toEqual(['Rotate the phone to landscape.'])
    expect(data.windows.map((w) => w.orientation)).toEqual(['portrait', 'landscape'])
    expect(windowsRow(data, 'android')).toMatchObject({ limit: 2, ok: true })
    expect(windowsRow({ ...data, windows: data.windows.slice(0, 1) }, 'android')).toMatchObject({
      limit: 2,
      ok: false,
    })
  })

  test('device-walk portrait: a landscape window does not satisfy iOS', () => {
    const data = { windows: [{ orientation: 'landscape' }], steady: [] }
    expect(windowsRow(data, 'ios')).toMatchObject({ value: 0, ok: false })
  })
})
