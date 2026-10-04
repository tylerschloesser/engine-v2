// The fingers of the fake phone (M39f step 9 and M11-gestures): sheet handlers for `walkAsPhone` that do what
// Tyler does on `device.html` with pointer input a headless engine can produce (mouse drags and clicks, the
// wheel for a pinch). They are the person's side of `agent/collect-touch.js`: each answers the sheet whose
// text it matches and does nothing else. Not touch events: what a real finger does is the device check.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Press, move through `path` (client points) with `stepMs` between moves, release. */
export async function drag(page, path, stepMs = 16) {
  const [first, ...rest] = path
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  for (const p of rest) {
    await sleep(stepMs)
    await page.mouse.move(p.x, p.y)
  }
  await page.mouse.up()
}

const line = (a, b, n) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n,
    y: a.y + ((b.y - a.y) * i) / n,
  }))

/** The seven gestures of M11-gestures. `panMs`: how long the pan runs (the collector's `opts.panMs`). */
export function gestureHandlers({ panMs = 1500 } = {}) {
  const size = (page) => page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  return [
    {
      match: /^Pan with one finger/,
      run: async ({ page }) => {
        const { w, h } = await size(page)
        const steps = Math.ceil(panMs / 30) + 4
        await drag(page, line({ x: w * 0.2, y: h * 0.5 }, { x: w * 0.7, y: h * 0.5 }, steps), 30)
      },
    },
    {
      match: /^Flick the world/,
      run: async ({ page }) => {
        const { w, h } = await size(page)
        await drag(page, line({ x: w * 0.2, y: h * 0.4 }, { x: w * 0.8, y: h * 0.4 }, 5), 12)
      },
    },
    {
      match: /^Pinch out to the furthest zoom/,
      run: async ({ page }) => {
        const { w, h } = await size(page)
        await page.mouse.move(w / 2, h / 2)
        for (const dir of [1, -1]) {
          for (let i = 0; i < 14; i++) {
            await page.mouse.wheel(0, dir * 300)
            await sleep(40)
          }
          await sleep(300)
        }
      },
    },
    {
      match: /^Tap a tile\.$|^Tap a tile\./,
      run: async ({ page }) => {
        const { w, h } = await size(page)
        await page.mouse.click(w * 0.6, h * 0.55)
      },
    },
    {
      match: /^Pull down from the very top edge/,
      run: async ({ page }) => {
        const { w } = await size(page)
        await drag(page, line({ x: w * 0.5, y: 20 }, { x: w * 0.5, y: 190 }, 12), 16)
      },
    },
    {
      match: /^Double-tap/,
      run: async ({ page }) => {
        const { w, h } = await size(page)
        await page.mouse.click(w * 0.4, h * 0.45)
        await sleep(90)
        await page.mouse.click(w * 0.4, h * 0.45)
      },
    },
  ]
}

/** The ring and button sheets of M18-pick, the tap and drag of M18-touch-ghost. */
export function anchorHandlers() {
  const marked = (page) =>
    page.evaluate(() => {
      const r = document.getElementById('walk-ring')?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })
  return [
    {
      match: /[Tt]ap the highlighted (ring|button)/,
      run: async ({ page }) => {
        await sleep(250) // the highlight is placed with the sheet
        const at = await marked(page)
        if (at) await page.mouse.click(at.x, at.y)
      },
    },
    {
      match: /^Tap a tile \(away from the little buttons\)/,
      run: async ({ page }) => {
        const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
        await page.mouse.click(w * 0.78, h * 0.62)
      },
    },
    {
      match: /^Now drag the map/,
      run: async ({ page }) => {
        const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
        await drag(page, line({ x: w * 0.3, y: h * 0.7 }, { x: w * 0.6, y: h * 0.7 }, 10), 20)
      },
    },
  ]
}
