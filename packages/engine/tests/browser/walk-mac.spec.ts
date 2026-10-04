// `pnpm device:walk --auto`'s Mac rows (docs/plan/39f-device-auto-runner.md step 14) end to end: a round of
// only Mac rows (`client: 'both'`, no phone), the service opens each Mac browser tab itself through the
// `openMac` hook (the CLI's is `open -a Safari|Firefox`), and a fake Mac (`fake-mac.mjs`) plays the person in a
// Playwright browser: "safari" is WebKit in the webkit project and Chromium in the chromium project, Firefox is
// Playwright's Firefox, which has no WebGPU: the real "Firefox without navigator.gpu" case. Simulated: the
// trackpad pinch is a ctrl+wheel, the allocation recording is not made (the judge sheet is tapped). All
// `@slow @webkit-gpu`.
import { type Browser, chromium, expect, firefox, test, webkit } from '@playwright/test'
import { ensureBenchBuild } from './support/reference-build.js'
import { type Final, finalOf, start } from './support/walk-rig.js'

const lib = new URL('../../../../scripts/lib/device-walk/', import.meta.url).href

test('walk-mac: five Mac rows walked in tabs the service opens: pinch, M17b in two browsers, two-browser play with Firefox unsupported, M35 on the Mac @slow @webkit-gpu', async () => {
  test.setTimeout(420_000)
  await ensureBenchBuild()
  const mac = (await import(`${lib}fake-mac.mjs`)) as {
    walkAsMac(p: unknown, o: Record<string, unknown>): Promise<unknown>
  }
  const ids = [
    'M11-pinch-desktop-safari',
    'M17b-harness-desktop-safari',
    'M17b-harness-desktop-firefox',
    'M39-desktop-browsers',
    'M35-safari-build-mac',
  ]
  const opened: { browser: string; url: string }[] = []
  const browsers: Browser[] = []
  const walks: Promise<unknown>[] = []
  const isWebkit = test.info().project.name === 'webkit'
  let finished = false
  const openMac = (browser: string, url: string) => {
    opened.push({ browser, url })
    walks.push(
      (async () => {
        const b =
          browser === 'firefox'
            ? await firefox.launch({ channel: undefined })
            : isWebkit
              ? await webkit.launch()
              : await chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu'] })
        browsers.push(b)
        const page = await (
          await b.newContext({ viewport: { width: 1280, height: 800 } })
        ).newPage()
        await page.goto(url)
        await mac.walkAsMac(page, { isDone: () => finished, timeoutMs: 400_000 })
      })().catch((e) => console.log(`fake mac ${browser}: ${e}`)),
    )
  }
  const r = await start(
    ids,
    {
      client: 'both',
      windowMs: 3000,
      warmupMs: 0,
      actTimeoutMs: 40_000,
      timeoutMs: 40_000,
      observeMs: 2500,
    },
    17400,
    { openMac },
  )
  try {
    await r.until(
      'every Mac row has a result',
      () => ids.every((id) => r.results().some((x) => x.id === id)),
      400_000,
    )
    finished = true
    const res = (id: string) => finalOf(r, id) as Final

    // The pinch: the page never zoomed, the camera did; the person's only question is "about the cursor".
    const pinch = res('M11-pinch-desktop-safari')
    expect(pinch, JSON.stringify(pinch.criteria)).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(pinch.criteria.find((c) => c.name === 'zoom_changed')).toMatchObject({ ok: true })

    // M17b in "Safari": probe lines and errors collected, allocation numbers are the judge sheet.
    const h = res('M17b-harness-desktop-safari')
    expect(h, JSON.stringify(h.criteria)).toMatchObject({ result: 'pass', by: 'mixed' })
    expect(h.criteria.find((c) => c.name === 'gpu_errors')).toMatchObject({ value: 0, ok: true })
    // M17b in Firefox: no WebGPU, recorded and skipped with that evidence.
    const hf = res('M17b-harness-desktop-firefox')
    expect(hf).toMatchObject({ result: 'skip', by: 'auto' })
    expect(hf.notes).toMatch(/firefox: (no navigator\.gpu|navigator\.gpu gave no adapter)/)

    // M39: Safari leg plays, Firefox leg is unsupported: skip, with the Safari numbers kept.
    const d = res('M39-desktop-browsers')
    expect(d, JSON.stringify(d.criteria)).toMatchObject({ result: 'skip' })
    // A software adapter may show gaps over 25 ms: then the person's tap is part of it (`mixed`).
    expect(['auto', 'mixed']).toContain(d.by)
    expect(d.notes).toMatch(/firefox: (no navigator\.gpu|navigator\.gpu gave no adapter)/)
    expect(d.criteria.find((c) => c.name === 'validation_errors')).toMatchObject({
      value: 0,
      ok: true,
    })
    expect(d.criteria.find((c) => c.name === 'ran_in_every_browser')).toMatchObject({ ok: true })

    const m35 = res('M35-safari-build-mac')
    expect(m35, JSON.stringify(m35.criteria)).toMatchObject({ result: 'pass', by: 'mixed' })

    // The service opened the tabs: one per browser, each on the loopback runner URL with a mac tab id.
    const kinds = new Set(opened.map((o) => o.browser))
    expect(kinds).toEqual(new Set(['safari', 'firefox']))
    for (const o of opened) {
      expect(o.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__walk\/runner\.html\?/)
      expect(o.url).toMatch(/tab=mac(safari|firefox)-\d+/)
    }
    // The Mac's facts are the Mac's: no phone env was ever recorded in a round with no phone.
    const envs = r.events().filter((e) => e.type === 'env')
    expect(envs.length).toBeGreaterThan(0)
    for (const e of envs) expect(String((e.src as { tab: string }).tab)).toMatch(/^mac/)
  } finally {
    finished = true
    await Promise.all(walks)
    await Promise.all(browsers.map((b) => b.close().catch(() => {})))
    await r.stop()
  }
})
