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

async function tapBar(page, label) {
  await page
    .evaluate((l) => {
      const root = document.getElementById('walk-bar')?.shadowRoot
      for (const b of root?.querySelectorAll('button') ?? []) if (b.textContent === l) b.click()
    }, label)
    .catch(() => {})
}

/**
 * Walk a round as the phone: open the runner, pass the pre-flight, tap Start, then answer what the page
 * asks until `isDone()` or the timeout. `judge`: the answer to every judge sheet ('pass', 'fail', 'skip').
 * `rotate`: do the rotate prompt by swapping the viewport. `onBar(state)` sees every new sheet.
 * @returns {Promise<{ judged: number, rotated: number, redone: number, sheets: string[] }>}
 */
export async function walkAsPhone(page, o) {
  const { runnerUrl, isDone, timeoutMs = 120_000, judge = 'pass', rotate = true, onBar } = o
  const seen = { judged: 0, rotated: 0, redone: 0, sheets: [] }
  await page.goto(runnerUrl)
  await page.locator('#autolock').click()
  await page.locator('#probe').click()
  await page.locator('#start').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('#start').click()
  const t0 = Date.now()
  let last = ''
  while (!isDone()) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`fake phone: the round did not finish in ${timeoutMs} ms`)
    const bar = await barState(page)
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
    }
    await sleep(150)
  }
  return seen
}
