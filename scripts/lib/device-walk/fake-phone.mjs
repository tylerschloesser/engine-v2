// A fake phone for the auto round (M39f): a Playwright page that plays what Tyler does on the real one,
// so the whole flow (runner page, pre-flight, hops, collectors, judge sheets, rotate prompts, the redo
// sheet) is proved end to end without a device. Used by `packages/engine/tests/browser/walk-auto.spec.ts`
// and by the demonstration runs; it drives the page through its DOM like a person's taps, nothing else.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The walk bar's text and buttons right now (it lives in a shadow root and is gone while measuring). */
async function barState(page) {
  return page
    .evaluate(() => {
      const root = document.getElementById('walk-bar')?.shadowRoot
      if (!root) return null
      return {
        text: root.querySelector('.s')?.textContent ?? '',
        judge: !!root.querySelector('input'),
        buttons: [...root.querySelectorAll('button')].map((b) => b.textContent),
      }
    })
    .catch(() => null) // the document is navigating
}

export async function tapBar(page, label) {
  await page
    .evaluate((l) => {
      const root = document.getElementById('walk-bar')?.shadowRoot
      for (const b of root?.querySelectorAll('button') ?? []) if (b.textContent === l) b.click()
    }, label)
    .catch(() => {})
}

/**
 * Make the page believe it was left (`hidden`) or came back (`visible`): headless engines cannot hide a
 * page, so this overrides `document.hidden`/`visibilityState` and fires `visibilitychange` (and, with
 * `pagehide`, the event Safari sends first when a tab is put away). What a lock screen or an app switch
 * does on the real phone is the device check; this proves the flow around it.
 */
export function simulateVisibility(page, hidden, { pagehide = false } = {}) {
  return page.evaluate(
    ([h, ph]) => {
      for (const [k, v] of [
        ['hidden', h],
        ['visibilityState', h ? 'hidden' : 'visible'],
      ])
        Object.defineProperty(document, k, { configurable: true, get: () => v })
      if (h && ph) window.dispatchEvent(new Event('pagehide'))
      document.dispatchEvent(new Event('visibilitychange'))
    },
    [hidden, pagehide],
  )
}

/**
 * Low Power Mode, simulated: animation-frame callbacks run on every second real frame (one shared queue, so
 * every chain of callbacks sees the same ~30 Hz), the cadence the agent detects. Not the real mode.
 */
export function simulateLowPower(page, on = true) {
  return page.evaluate((enable) => {
    const w = window
    if (!w.__rafReal) w.__rafReal = w.requestAnimationFrame.bind(w)
    w.__rafLow = enable
    if (!enable || w.__rafPump) return
    w.__rafPump = true
    const queue = []
    let frame = 0
    const pump = (t) => {
      frame++
      if (!w.__rafLow) w.__rafPump = false
      else if (frame % 2 === 0) for (const cb of queue.splice(0)) cb(t)
      if (w.__rafLow) w.__rafReal(pump)
      else for (const cb of queue.splice(0)) cb(t)
    }
    w.requestAnimationFrame = (cb) => (w.__rafLow ? queue.push(cb) : w.__rafReal(cb))
    w.__rafReal(pump)
  }, on)
}

/**
 * Walk a round as the phone: open the runner, pass the pre-flight, tap Start, then answer what the page
 * asks until `isDone()` or the timeout. `judge`: the answer to every judge sheet ('pass', 'fail', 'skip').
 * `rotate`: do the rotate prompt by swapping the viewport. `onBar(state)` sees every new sheet.
 * `handlers`: `[{ match: RegExp | (bar) => boolean, run: async ({ page, bar }) => void | { page } }]`, each
 * run once per new sheet whose text matches; a handler returns `{ page }` when the person's phone is
 * another page now (Safari killed and reopened). Handlers get the sheet's text and buttons.
 * @returns {Promise<{ judged: number, rotated: number, redone: number, sheets: string[] }>}
 */
export async function walkAsPhone(page, o) {
  const {
    runnerUrl,
    isDone,
    timeoutMs = 120_000,
    judge = 'pass',
    rotate = true,
    onBar,
    handlers = [],
  } = o
  const seen = { judged: 0, rotated: 0, redone: 0, sheets: [] }
  await page.goto(runnerUrl)
  await page.locator('#autolock').click()
  await page.locator('#probe').click()
  await page.locator('#start').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#start').click()
  const t0 = Date.now()
  let last = ''
  let handled = '' // the prompt a handler already answered (its ticks change the sheet's text, not the prompt)
  while (!isDone()) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`fake phone: the round did not finish in ${timeoutMs} ms`)
    const bar = await barState(page)
    if (!bar) handled = ''
    const prompt = bar ? bar.text.split(/[○✓]/)[0] : ''
    if (bar && bar.text !== last) {
      last = bar.text
      seen.sheets.push(bar.text)
      onBar?.(bar)
      if (bar.judge) {
        seen.judged++
        await tapBar(page, judge)
      } else if (bar.buttons.includes('Redo this check')) {
        seen.redone++
        await tapBar(page, 'Redo this check')
      } else if (/^Rotate the phone/.test(bar.text) && bar.text.includes('○') && rotate) {
        const v = page.viewportSize()
        if (v) await page.setViewportSize({ width: v.height, height: v.width })
        seen.rotated++
      }
      for (const h of prompt === handled ? [] : handlers) {
        const hit = typeof h.match === 'function' ? h.match(bar) : h.match.test(bar.text)
        if (!hit) continue
        handled = prompt
        const out = await h.run({ page, bar, seen })
        if (out?.page) {
          page = out.page
          last = ''
        }
      }
    }
    await sleep(150)
  }
  return seen
}
