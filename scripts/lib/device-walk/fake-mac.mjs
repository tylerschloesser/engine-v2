// A fake Mac for the auto round (M39f step 14): the person's side of `agent/collect-mac.js`, with the pointer
// input a headless engine can produce (a ctrl+wheel is Chromium's trackpad pinch; Safari's own `gesture*`
// events cannot be made by a script), and a way to open a Mac browser tab for `DEVICE_WALK_OPEN`. Used by
// `packages/engine/tests/browser/walk-mac.spec.ts` and by the demonstration. Not a real Safari or Firefox:
// what the real ones do with a pinch and a recording is the device check.
import { walkAsPhone } from './fake-phone.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The sheets of the Mac rows: the pinch, and the harness's Run button (the recording is the person's). */
export function macHandlers() {
  return [
    {
      match: /trackpad, over a landmark tile/,
      run: async ({ page }) => {
        const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
        await page.mouse.move(w / 2, h / 2)
        // A few ctrl+wheel events are the pinch the page's listeners see; the plain wheel is what moves the
        // camera in a headless engine (the page's own wheel handler, as `fake-phone-touch.mjs` uses it).
        await page.keyboard.down('Control')
        for (let i = 0; i < 4; i++) {
          await page.mouse.wheel(0, 10)
          await sleep(40)
        }
        await page.keyboard.up('Control')
        for (const dir of [1, -1]) {
          for (let i = 0; i < 10; i++) {
            await page.mouse.wheel(0, dir * 300)
            await sleep(40)
          }
          await sleep(300)
        }
      },
    },
    {
      match: /press Run on the page/,
      run: async ({ page }) => {
        await page.locator('#harness-run').click({ timeout: 30_000 })
      },
    },
  ]
}

/**
 * Walk the Mac rows in one tab: no pre-flight, the runner starts the walk. `isDone` ends it. The page may
 * already be loading the runner URL (a tab opened by `openMacBrowser`): pass `runnerUrl` only to navigate.
 */
export function walkAsMac(page, o = {}) {
  return walkAsPhone(page, {
    preflight: false,
    rotate: false,
    ...o,
    handlers: [...macHandlers(), ...(o.handlers ?? [])],
  })
}
