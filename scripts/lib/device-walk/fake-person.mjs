// The person of a whole auto round, simulated (M39f step 15's demonstration): every prompt the phone's
// checks can show, answered the way `packages/engine/tests/browser/walk-*.spec.ts` answer each in isolation
// (those specs keep their own copies). A headless engine cannot do what the real person does, and this says
// so: the app switch and the lock screen are `visibilitychange` with `document.hidden` overridden, Low Power
// Mode is every second animation frame dropped, Private Browsing is the page's own `?noOpfs=1`, a swiped-away
// Safari is a closed page and a new one on the join URL, the net drops are the page's own `__mpLinkEvent`,
// fingers are mouse drags and the wheel, a lost GPU device is the page's newest device `destroy()`ed through a
// handle kept by an init script. Not a phone: what the real one does is the device check.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulateLowPower, simulateVisibility, tapBar } from './fake-phone.mjs'
import { anchorHandlers, gestureHandlers } from './fake-phone-touch.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secondsIn = (text, re) => Number(re.exec(text)?.[1])

/** Keeps every device the page creates on `window.__devs` (before the agent wraps `requestDevice` on top). */
export function keepDevices(context) {
  return context.addInitScript(() => {
    const proto = self.GPUAdapter?.prototype
    const orig = proto?.requestDevice
    if (!proto || !orig) return
    proto.requestDevice = async function (...a) {
      const d = await orig.apply(this, a)
      window.__devs = [...(window.__devs ?? []), d]
      return d
    }
  })
}

/**
 * The person closes a helper tab once it has done its part (the page itself says "you can close this one").
 * A tab left open goes on polling the round: it would walk the next check beside the first tab.
 */
const closeLater = (p, ms = 20_000, on = true) => {
  if (on) setTimeout(() => p.close().catch(() => {}), ms).unref?.()
  return p
}

const link = (p, state) => p.evaluate((s) => window.__mpLinkEvent?.(s, 'close'), state)

/**
 * Handlers for `walkAsPhone`. `joinUrl`: what a swiped-away Safari reopens. `opts.panMs`: the M11 pan time.
 */
export function personHandlers({ page, joinUrl, panMs = 1500, closeHelpers = true }) {
  const ctx = page.context()
  let exported = ''
  return [
    {
      // The app switch and the lock screen (M16-background, M23-hidden-pause, M29's drops): hidden for the
      // stated time; on `mp.html` the net worker's report that the socket closed and came back is injected.
      match: /(Switch to another app|Lock the screen) for/,
      run: async ({ page: p, bar }) => {
        const secs = secondsIn(bar.text, /for ([\d.]+) seconds/)
        await sleep(300)
        await simulateVisibility(p, true, { pagehide: true })
        await link(p, 'down')
        await sleep(secs * 1000)
        await simulateVisibility(p, false)
        await sleep(300)
        await link(p, 'up')
      },
    },
    { match: /^Turn Low Power Mode on/, run: ({ page: p }) => simulateLowPower(p) },
    {
      match: /Turn Wi-Fi off/,
      run: async ({ page: p }) => {
        await sleep(300)
        await link(p, 'down')
        await sleep(1500)
        await link(p, 'up')
      },
    },
    {
      match: /Turn airplane mode on for/,
      run: async ({ page: p, bar }) => {
        const secs = secondsIn(bar.text, /for ([\d.]+) seconds/)
        await sleep(300)
        await p.evaluate(() => window.dispatchEvent(new Event('offline')))
        await link(p, 'down')
        await sleep(secs * 1000)
        await p.evaluate(() => window.dispatchEvent(new Event('online')))
        await sleep(300)
        await link(p, 'up')
      },
    },
    {
      match: /^Open this link in a Private tab: /,
      run: async ({ bar }) => {
        const url = /Private tab: (\S+?)(?:[○✓]|$)/.exec(bar.text)?.[1]
        const second = closeLater(await ctx.newPage(), 20_000, closeHelpers)
        const u = new URL(url)
        u.searchParams.set('world', 'walk-private-sim')
        u.searchParams.set('noOpfs', '1')
        await second.goto(u.href)
      },
    },
    {
      match: (bar) => bar.buttons.includes('Open second tab'),
      run: async ({ page: p }) => {
        const [second] = await Promise.all([ctx.waitForEvent('page'), tapBar(p, 'Open second tab')])
        closeLater(second, 20_000, closeHelpers)
      },
    },
    {
      match: /^Swipe Safari away/,
      run: async ({ page: p }) => {
        await p.close()
        const again = await ctx.newPage()
        await again.goto(joinUrl)
        return { page: again }
      },
    },
    {
      match: /^Tap Export on the page/,
      run: async ({ page: p }) => {
        const [dl] = await Promise.all([
          p.waitForEvent('download'),
          p.locator('#export-btn').dispatchEvent('click'),
        ])
        exported = join(tmpdir(), `walk-person-${Date.now()}.world`)
        await dl.saveAs(exported)
      },
    },
    {
      match: /^Now choose the downloaded file/,
      run: async ({ page: p, bar }) => {
        const id = /type the id (\S+),/.exec(bar.text)?.[1]
        await p.locator('#import-file').setInputFiles(exported)
        await p.locator('#import-worldid').fill(id)
        await p.locator('#import-btn').dispatchEvent('click')
        await p.waitForFunction(() =>
          /^imported as/.test(document.getElementById('world-op-status')?.textContent ?? ''),
        )
        const [imported] = await Promise.all([
          ctx.waitForEvent('page'),
          tapBar(p, 'Open the imported world'),
        ])
        closeLater(imported, 20_000, closeHelpers)
      },
    },
    {
      // M37b: the tab goes to the background, the GPU process loses the device meanwhile.
      match: /^Run \d of 3/,
      run: async ({ page: p, bar }) => {
        const secs = secondsIn(bar.text, /about ([\d.]+) seconds/)
        await sleep(300)
        await simulateVisibility(p, true, { pagehide: true })
        await p.evaluate(() => window.__devs?.at(-1)?.destroy())
        await sleep(secs * 1000)
        await simulateVisibility(p, false)
      },
    },
    {
      match: /^Switch the phone off Wi-Fi now/,
      run: async ({ page: p }) => {
        await sleep(300)
        await tapBar(p, 'Wi-Fi is off')
      },
    },
    {
      // The pinch, slower than `fake-phone-touch.mjs`'s: a whole round on a loaded machine sometimes drew
      // the wheel notches faster than the collector's 250 ms poll could see the far end of the zoom.
      match: /^Pinch out to the furthest zoom/,
      run: async ({ page: p }) => {
        const { w, h } = await p.evaluate(() => ({ w: innerWidth, h: innerHeight }))
        await p.mouse.move(w / 2, h / 2)
        for (const dir of [1, -1]) {
          for (let i = 0; i < 14; i++) {
            await p.mouse.wheel(0, dir * 300)
            await sleep(70)
          }
          await sleep(1200)
        }
      },
    },
    ...gestureHandlers({ panMs }),
    ...anchorHandlers(),
  ]
}
