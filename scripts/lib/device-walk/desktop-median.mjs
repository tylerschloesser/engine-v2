// The Mac-side half of M08-warn-threshold (M39f step 4): the desktop median ms per chunk, F's denominator.
// `baselines/worldgen.json` is native, not WASM-in-browser, so it cannot stand in: the same
// `worldgen-bench.html` the phone runs is run here in headless Chromium, a few times, and the median of
// the medians is kept (one run on a busy Mac is noise). Returns null when it cannot run: the round then
// judges M08-warn-threshold from the phone median alone (a phone under 0.5 ms needs no F).

/** The lower median of finite numbers, or null. */
export function medianOf(xs) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null
}

/** One run of the page in headless Chromium: `window.__worldgenBench.medianMs`. */
export async function measureInChromium(url, { timeoutMs = 90_000 } = {}) {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`${url.replace(/\/$/, '')}/worldgen-bench.html`)
    await page.waitForFunction(() => window.__pageReady === true, undefined, { timeout: timeoutMs })
    return await page.evaluate(() => window.__worldgenBench.medianMs)
  } finally {
    await browser.close()
  }
}

/**
 * @param {{ url: string, runs?: number, measure?: (url: string) => Promise<number> }} o
 * @returns {Promise<number|null>}
 */
export async function desktopMedian({ url, runs = 3, measure = measureInChromium }) {
  const medians = []
  for (let i = 0; i < runs; i++) {
    try {
      medians.push(await measure(url))
    } catch {
      // a failed run is left out; none at all is null
    }
  }
  return medianOf(medians)
}
