// The bot partner of M34 (M39f step 12, Tyler's answer 2 of 2026-10-03): a headless Chromium on the Mac is
// player 2 of the phone's world, scripted by the service. It joins the same real-time server on the check
// build's loopback origin (`#k=`: an open server), plays through the check build's `window.__check.act`
// (the page's own collect button, craft button, a raw `PlaceFurnace`, the camera) and says what it did
// and what it saw as `reading` events of the round log (`key: 'bot'`: the phase; `key: 'botView'`: what
// the bot sees of the phone). The phone says its own phase the same way (`key: 'phone'`) and the bot waits
// for it: the log is the whole channel, so a restarted service or a retried attempt loses nothing.
//
// Modes (`plan.bot`, one per M34 row that needs a partner; M34-own-timer-bar needs none):
//   two     join; see the phone; collect 5 stone, craft, stand by FURNACE_A and place a furnace  -> `placed`;
//           when the phone has seen it, close the page (a dropped player)                         -> `gone`;
//           when the phone has seen the hollow roster dot, come back (same identity)               -> `back`
//   motion  join; when the phone is ready, walk back and forth for a few seconds                  -> `moved`;
//           when the phone has seen it, close the page                                             -> `gone`
// What each phase waits for on the phone side is `agent/collect-ref.js`.
import { readingsOf } from './auto-round.mjs'
import { readEvents } from './rounds.mjs'

/** What a reading says of the other players: roster ids with their `me` flag, and the circles drawn. */
export const viewOf = (r) => ({
  roster: r.roster ?? [],
  remote_xy: r.remote_xy ?? [],
  own_xy: r.own_xy ?? null,
})

/**
 * Does the bot's page show the *phone*? All three: the phone said it joined (its own `reading {key: 'phone'}`),
 * the roster has an online player that is not the bot, and a circle is drawn that is not the bot's own.
 * (M39n, "ghost remote": the old test was `roster_n >= 2 && remote_circles >= 1`: any second roster entry, an
 * offline one included, and a circle count that includes the bot's own when the DrawList has no range ring to
 * tell it by. A bot alone on a fresh server sees neither, so what it counted in the rounds was a real second
 * client; this makes sure it is the phone.)
 * @param {Record<string, any>} r  the bot page's `__check.readings()`
 * @param {boolean} phoneJoined  the phone has posted phase `joined` for this attempt
 */
export const phoneSeen = (r, phoneJoined) => {
  const roster = r.roster ?? []
  const otherOnline = roster.some((d) => d.endsWith(':online:other'))
  // `own_xy` null: no range ring, the own circle is among the remote ones and one of them is the bot's.
  const others = (r.remote_circles ?? 0) - (r.own_xy ? 0 : 1)
  return !!phoneJoined && otherOnline && others >= 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {{ file: string, append: (e: object) => object, origin: string, tiles: { stone: {x,y}, furnace: {x,y} },
 *   launch?: () => Promise<{ newContext(o?: object): Promise<any>, close(): Promise<void> }>,
 *   timings?: { stepMs?: number, walkMs?: number, settleMs?: number, pollMs?: number }, log?: (s: string) => void,
 *   serverLog?: () => string[] }} o
 *   `serverLog`: the tail of the real-time server's output (what `device-serve` printed), for a failed join.
 *   `origin`: the loopback origin of the check build's server (the bot is on the Mac).
 */
export function createBots({
  file,
  append,
  origin,
  tiles,
  launch,
  timings = {},
  log = () => {},
  serverLog = () => [],
}) {
  const running = new Map() // id -> { n, stop }
  let seq = 0
  // A real WebGPU adapter headless: `channel: 'chromium'` (new headless mode, Metal on the Mac) and
  // `--enable-unsafe-webgpu`, as the browser suite's own project does (`playwright.config.ts`; CI's software
  // adapter flags are the same ones, under `ENGINE_GPU=swiftshader`).
  const open =
    launch ??
    (async () =>
      (await import('@playwright/test')).chromium.launch({
        channel: 'chromium',
        args: [
          '--enable-unsafe-webgpu',
          ...(process.env.ENGINE_GPU === 'swiftshader'
            ? [
                '--enable-features=Vulkan',
                '--use-angle=vulkan',
                '--use-vulkan=swiftshader',
                '--use-webgpu-adapter=swiftshader',
                '--disable-vulkan-surface',
              ]
            : []),
        ],
      }))

  const post = (id, n, key, data) =>
    append({ type: 'reading', id, n, key, data, src: { tab: 'bot', seq: ++seq } })
  const phone = (id, n) => readingsOf(readEvents(file), id, n).phone?.phase

  async function play({ id, n, mode, signal }) {
    const stopped = () => signal.aborted
    const until = async (fn, ms, every = timings.pollMs ?? 150) => {
      const t0 = Date.now()
      while (!stopped() && Date.now() - t0 < ms) {
        try {
          const v = await fn()
          if (v) return v
        } catch {
          // a page that is navigating or closing: look again
        }
        await sleep(every)
      }
      return false
    }
    const browser = await open()
    try {
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } })
      let page
      const rd = () => page.evaluate(() => window.__check.readings())
      const act = (name, arg) => page.evaluate(([k, a]) => window.__check.act[k](a), [name, arg])
      const consoleTail = []
      const join = async () => {
        page = await ctx.newPage()
        const note = (s) => {
          consoleTail.push(String(s).slice(0, 300))
          if (consoleTail.length > 20) consoleTail.shift()
        }
        page.on?.('console', (m) => note(`${m.type()}: ${m.text()}`))
        page.on?.('pageerror', (e) => note(`pageerror: ${e?.message ?? e}`))
        try {
          await page.goto(`${origin}/#k=`)
          await page.waitForFunction(() => window.__check?.ready === true, undefined, {
            timeout: 60_000,
          })
          const up = await until(async () => {
            const r = await rd()
            return r.link === 'online' && r.ui_seen
          }, 60_000)
          if (!up) throw new Error('the bot never came online')
        } catch (e) {
          // Which condition failed, and what the page and the server said meanwhile.
          let readings = null
          try {
            readings = await rd()
          } catch {
            // the page has no check hook (yet)
          }
          let url = null
          try {
            url = page.url()
          } catch {
            // closed
          }
          const err = new Error(String(e?.message ?? e).split('\n')[0])
          err.diag = { url, console: [...consoleTail], readings, server: serverLog().slice(-20) }
          throw err
        }
        const r = await rd()
        await act('moveTo', { x: r.spawn_x, y: r.spawn_y, tiles: 40 })
      }
      await join()
      post(id, n, 'bot', { phase: 'joined' })
      log(`bot ${id} #${n}: joined (${mode})`)

      if (mode === 'two') {
        // What the bot sees of the phone: its roster dot and its circle. `first` is the view at the moment
        // the bot decided (what it counted, M39n), `ms` how long after joining that was.
        const tJoined = Date.now()
        let first = null
        const sawPhone = await until(async () => {
          const r = await rd()
          if (!phoneSeen(r, phone(id, n) !== undefined)) return false
          first = { ms: Date.now() - tJoined, ...viewOf(r) }
          return true
        }, 120_000)
        const r0 = await rd()
        post(id, n, 'botView', {
          sawPhone: !!sawPhone,
          roster_n: r0.roster_n,
          remote_circles: r0.remote_circles,
          ...viewOf(r0),
          first,
        })
        // Collect five stone by the page's own button, craft the furnace, place it.
        const { stone, furnace } = tiles
        await act('moveTo', { x: stone.x, y: stone.y, tiles: 20 })
        for (let got = 0; got < 5 && !stopped(); ) {
          const r = await act('collectOnce', stone)
          if (r.ok) got++
          else await sleep(500)
        }
        await act('craft', 0)
        await until(async () => (await rd()).inv_furnace >= 1, 60_000)
        await act('moveTo', { x: furnace.x - 5, y: furnace.y, tiles: 20 })
        await sleep(1500)
        await act('dispatch', { PlaceFurnace: { origin: { x: furnace.x, y: furnace.y } } })
        await until(async () => (await rd()).inv_furnace === 0, 30_000)
        post(id, n, 'bot', { phase: 'placed' })
        if (await until(() => phone(id, n) === 'saw-furnace', 180_000)) {
          await page.close()
          post(id, n, 'bot', { phase: 'gone', at: Date.now() })
          if (await until(() => phone(id, n) === 'saw-hollow', 180_000)) {
            await join()
            post(id, n, 'bot', { phase: 'back', at: Date.now() })
          }
        }
      } else if (mode === 'motion') {
        if (await until(() => phone(id, n) === 'ready', 180_000)) {
          const step = timings.stepMs ?? 1200
          const walk = timings.walkMs ?? 8000
          const r = await rd()
          const t0 = Date.now()
          for (let k = 0; Date.now() - t0 < walk && !stopped(); k++) {
            // The camera is the player's target: it follows with its own spring, so the remote sees a
            // walk, not teleports.
            await act('moveTo', { x: r.spawn_x + (k % 2 ? 0 : 6), y: r.spawn_y })
            await sleep(step)
          }
          await sleep(timings.settleMs ?? 1500)
          post(id, n, 'bot', { phase: 'moved' })
          if (await until(() => phone(id, n) === 'moved-seen', 180_000)) {
            await page.close()
            post(id, n, 'bot', { phase: 'gone', at: Date.now() })
          }
        }
      }
      // The attempt is over when the service stops this bot (a result, or a newer attempt).
      await until(() => false, 600_000, 500)
    } finally {
      await browser.close().catch(() => {})
    }
  }

  const stopById = (id) => {
    const r = running.get(id)
    if (r) {
      r.stop()
      running.delete(id)
    }
  }

  return {
    /** An attempt of check `id` opened: start its partner if the check has one (`plan.bot`). */
    start({ id, n, plan }) {
      stopById(id)
      if (!plan.bot) return
      const ctl = new AbortController()
      const done = play({ id, n, mode: plan.bot, signal: ctl.signal }).catch((e) => {
        log(`bot ${id} #${n} failed: ${e?.message ?? e}`)
        post(id, n, 'bot', {
          phase: 'failed',
          error: String(e?.message ?? e),
          ...(e?.diag ? { diag: e.diag } : {}),
        })
      })
      running.set(id, { n, stop: () => ctl.abort(), done })
    },
    /** A check has its result (or the round ended): its bot goes home. */
    finish(id) {
      stopById(id)
    },
    async stop() {
      const all = [...running.values()]
      for (const id of [...running.keys()]) stopById(id)
      await Promise.all(all.map((r) => r.done))
    },
    active: () => [...running.keys()],
  }
}
