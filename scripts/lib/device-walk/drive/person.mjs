// The device person (M39j step 1): the Mac doing what Tyler does with the phone in his hand. `fake-person.mjs`
// answers every prompt of an auto round with a headless page's tricks; this is its twin on real hardware,
// through a `DeviceBackend`. A prompt is `{ id, n, kind: 'act' | 'judge' | 'redo', text }` as the round log
// holds it (`live.mjs` `openPrompts`): the handler is found by the text (the same words the walk bar shows), run
// once, and the phone's own collector sees the result through its "detected" ticks.
//
// Judge prompts are not answered here: a screenshot is saved for the orchestrator (`--judge` records the
// verdict). A thing the phone cannot do is a `NotDrivable` with its reason; the loop records the item as
// `skip` with that reason, never as a pass.
import { finger, NotDrivable } from './backend.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const VIEW = `({ w: innerWidth, h: innerHeight })`
const CENTRE_OF = (find) => `(() => {
  const el = ${find}
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
})()`
const BY_ID = (sel) => CENTRE_OF(`document.querySelector(${JSON.stringify(sel)})`)
const BAR_BUTTON = (label) =>
  CENTRE_OF(
    `[...(document.getElementById('walk-bar')?.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent === ${JSON.stringify(label)})`,
  )

/**
 * A point of the page that is the canvas and not a button or the bar (a tile tap, a double-tap, a drag start):
 * the middle, else the first of a few others that `elementFromPoint` says is a canvas.
 */
const CANVAS_POINT = `(() => {
  const spots = [[.5,.5],[.5,.35],[.3,.5],[.7,.5],[.5,.65],[.3,.3],[.7,.7]]
  for (const [fx, fy] of spots) {
    const x = innerWidth * fx, y = innerHeight * fy
    const el = document.elementFromPoint(x, y)
    if (el && el.tagName === 'CANVAS') return { x, y }
  }
  return { x: innerWidth / 2, y: innerHeight / 2 }
})()`

/**
 * Wait `ms` of absence after Home: poll the page for `hidden` (up to 3 s; a backend that cannot read a hidden page
 * falls back to `ctx.hideLagMs`) and count the time from there, less `ctx.returnLagMs` for the way back.
 */
async function leaveFor(backend, ms, ctx) {
  const t0 = Date.now()
  let seen = null
  for (let i = 0; i < 40; i++) {
    try {
      if ((await backend.readPage('document.visibilityState')) === 'hidden') {
        seen = Date.now()
        break
      }
    } catch {}
    await ctx.sleep(80)
  }
  const from = seen ?? t0 + ctx.hideLagMs
  await ctx.sleep(Math.max(0, ms - ctx.returnLagMs - (Date.now() - from)))
}

/** Handlers, in order: first whose `match` hits the prompt text runs. `run({ backend, prompt, ctx, text, m })`. */
export const HANDLERS = [
  {
    name: 'rotate',
    match: /^Rotate the phone to (portrait|landscape)\./,
    run: ({ backend, m }) => backend.rotate(m[1]),
  },
  {
    name: 'pan',
    match: /^Pan with one finger for about (\d+) seconds/,
    // One long drag: the page counts the time the finger moves, so one slow drag of the stated time (plus a
    // second for the lag of the first and last event) is the pan.
    run: async ({ backend, m }) => {
      const { w, h } = await backend.readPage(VIEW)
      const ms = (Number(m[1]) + 1.5) * 1000
      await backend.swipe(w * 0.85, h * 0.7, w * 0.15, h * 0.3, ms)
    },
  },
  {
    name: 'flick',
    match: /^Flick the world and let it glide/,
    // Fast and short: the speed the page needs (0.8 px/ms) and the lift under 80 ms after the last move.
    run: async ({ backend }) => {
      const { w, h } = await backend.readPage(VIEW)
      await backend.swipe(w * 0.75, h * 0.5, w * 0.25, h * 0.5, 80)
    },
  },
  {
    name: 'pinch',
    match: /^Pinch out to the furthest zoom, then in to the closest/,
    // Fingers together widen the view (more tiles across), apart narrow it, as the spike measured; the page
    // starts at its closest zoom, so together first. Read the zoom after each gesture, stop at the limit.
    run: async ({ backend, ctx }) => {
      const { w, h } = await backend.readPage(VIEW)
      const m = Math.min(w, h)
      const cx = w / 2
      const cy = h / 2
      const tiles = () => backend.readPage('window.__check.readings().tiles_across')
      const pinch = (from, to) =>
        backend.touch([finger(cx - from, cy, cx - to, cy), finger(cx + from, cy, cx + to, cy)], 600)
      let t = await tiles()
      const start = t
      for (let i = 0; i < 14 && t < 250; i++) {
        await pinch(m * 0.4, m * 0.08)
        await ctx.sleep(250)
        t = await tiles()
      }
      for (let i = 0; i < 14 && t > Math.max(13, start * 1.05); i++) {
        await pinch(m * 0.08, m * 0.4)
        await ctx.sleep(250)
        t = await tiles()
      }
    },
  },
  {
    name: 'tap-tile',
    match: /^Tap a tile\b/,
    run: async ({ backend }) => {
      const p = await backend.readPage(CANVAS_POINT)
      await backend.tap(p.x, p.y)
    },
  },
  {
    name: 'pull-down',
    match: /^Pull down from the very top edge/,
    // The top edge of the page (just under the browser's toolbar), not of the screen: the page's own pull is
    // what is asked about (the status bar's shade is the OS's).
    run: async ({ backend }) => {
      const { w, h } = await backend.readPage(VIEW)
      await backend.swipe(w / 2, 6, w / 2, Math.min(h * 0.45, 300), 500)
    },
  },
  {
    name: 'double-tap',
    match: /^Double-tap anywhere/,
    run: async ({ backend }) => {
      const p = await backend.readPage(CANVAS_POINT)
      await backend.tap(p.x, p.y, { count: 2 })
    },
  },
  {
    name: 'drag',
    match: /^Now drag the map with one finger/,
    run: async ({ backend }) => {
      const { w, h } = await backend.readPage(VIEW)
      await backend.swipe(w * 0.7, h * 0.5, w * 0.3, h * 0.5, 600)
    },
  },
  {
    name: 'tap-ring',
    match: /^(Zoom \d+ of \d+: tap the highlighted ring|Tap the highlighted button)/,
    // The highlight is drawn where the tap must land. A ring sits under its own little button, and a finger's
    // touch area snaps to the button there (the page's `elementFromPoint` says canvas, the real tap says BUTTON:
    // found on the Pixel): for a ring the tap goes just under the button's box, which is still on the ring
    // (measured: 6 px below the anchor picks it, 14 px does not); for the button itself, its centre.
    run: async ({ backend, text }) => {
      const r = await backend.readPage(BY_ID('#walk-ring'))
      if (!r) throw new Error('no highlighted ring on the page')
      let { x, y } = r
      if (/ring/.test(text)) {
        const below = await backend.readPage(`(() => {
          let bottom = null
          for (const b of document.querySelectorAll('button')) {
            const q = b.getBoundingClientRect()
            if (${x} > q.left - 8 && ${x} < q.right + 8 && ${y} > q.top - 8 && ${y} < q.bottom + 8) bottom = Math.max(bottom ?? 0, q.bottom)
          }
          return bottom
        })()`)
        if (below !== null) y = below + 2
      }
      await backend.tap(x, y)
    },
  },
  {
    name: 'leave-app',
    match: /Switch to another app for ([\d.]+) seconds/,
    // Home, then the stated time counted from the moment the page reports `hidden` (it comes a moment after the
    // key press, and a visible one after the intent that brings the browser back): the absence the page measures
    // is the one asked for, not the one the Mac's own clock saw.
    run: async ({ backend, m, ctx }) => {
      await ctx.sleep(300)
      await backend.home()
      await leaveFor(backend, Number(m[1]) * 1000, ctx)
      await backend.returnToBrowser()
    },
  },
  {
    name: 'background',
    match: /^Run \d+ of \d+: put this tab in the background[\s\S]* for about ([\d.]+) seconds/,
    // M37b's memory pressure is the person's heavy apps; here the tab is only backgrounded (a finding to
    // note: no pressure was applied).
    run: async ({ backend, m, ctx }) => {
      await ctx.sleep(300)
      await backend.home()
      await leaveFor(backend, Number(m[1]) * 1000, ctx)
      await backend.returnToBrowser()
    },
  },
  {
    name: 'airplane',
    match: /Turn airplane mode on for ([\d.]+) seconds/,
    run: async ({ backend, m, ctx }) => {
      await ctx.sleep(300)
      await backend.setAirplane(true)
      try {
        await ctx.sleep(Number(m[1]) * 1000)
      } finally {
        await backend.setAirplane(false)
      }
    },
  },
  {
    name: 'low-power',
    match: /^Turn Low Power Mode on/,
    run: ({ backend }) => backend.setLowPower(true),
  },
  {
    name: 'low-power-off',
    match: /^Low Power Mode looks on\. Turn it off/,
    run: ({ backend }) => backend.setLowPower(false),
  },
  {
    name: 'relaunch',
    match: /^Swipe Safari away/,
    run: async ({ backend, ctx }) => {
      await backend.relaunchBrowser(ctx.joinUrl)
      await ctx.passRunner()
    },
  },
  {
    name: 'second-tab',
    match: /^Tap "Open second tab"/,
    run: async ({ backend, ctx }) => {
      if (backend.platform === 'ios')
        throw new NotDrivable(
          "coming back to the first tab needs Safari's tab switcher: not driven yet",
        )
      const b = await backend.readPage(BAR_BUTTON('Open second tab'))
      if (!b) throw new Error('no "Open second tab" button on the bar')
      await backend.tap(b.x, b.y)
      await ctx.sleep(3000) // look at it
      await backend.returnToBrowser()
    },
  },
  {
    name: 'redo',
    match: /^the check was interrupted: "Redo this check"/,
    run: async ({ backend }) => {
      const b = await backend.readPage(BAR_BUTTON('Redo this check'))
      if (!b) throw new Error('no "Redo this check" button on the bar')
      await backend.tap(b.x, b.y)
    },
  },
  // What a phone cannot be made to do. Each is a reason, not a failure.
  {
    name: 'lock',
    match: /Lock the screen for/,
    run: () => {
      throw new NotDrivable(
        'the screen is never turned off or locked on these phones (Tyler); a lock needs the passcode',
      )
    },
  },
  {
    name: 'wifi',
    match: /(Turn Wi-Fi off so the phone moves to cellular|Switch the phone off Wi-Fi now)/,
    run: ({ backend }) => {
      throw new NotDrivable(
        backend.platform === 'ios'
          ? 'the iPhone has no SIM, so there is no cellular to move to: Wi-Fi off is no network at all'
          : 'a driven round serves over adb reverse (USB), so the Wi-Fi state changes nothing the page can see; it needs a tunnel round with the phone on Wi-Fi and cellular',
      )
    },
  },
  {
    name: 'private-tab',
    match: /^Open this link in a Private tab/,
    run: ({ backend }) => {
      throw new NotDrivable(
        backend.platform === 'ios'
          ? "Safari's Private mode is the tab switcher's UI: not driven yet"
          : 'Chrome ignores the incognito flag of an intent sent from adb (only Chrome itself may open an Incognito tab by intent)',
      )
    },
  },
  {
    name: 'file-picker',
    match: /^(Tap Export on the page|Now choose the downloaded file)/,
    run: () => {
      throw new NotDrivable(
        'the export lands in Downloads and the import needs the system file picker; not driven yet',
      )
    },
  },
  {
    name: 'mac-prompt',
    match: /^In (Safari|Firefox|Chrome|Edge): /,
    run: () => {
      throw new NotDrivable('a Mac browser prompt: the phone is not the one asked')
    },
  },
]

const NOT_PHONE =
  'not a phone row: a Mac browser walks it (trackpad, Web Inspector, Profiler), never a phone round'
const HUMAN = "a human-class row: Tyler's own verdict, a round never walks it"
const rotate = { act: 'rotate the phone once between the two windows', handlers: ['rotate'] }

/**
 * Every `acts` string of `checks.mjs`, and what the device person does with it. Keyed by check id; the unit
 * test fails when a check gains an act string that is not an entry here with the same words. `handlers` names
 * entries of `HANDLERS`; `notDrivable` is a reason for the whole act, or `[{ match, reason }]` for the prompts
 * of it that are not drivable; `note` says what is only partly done.
 */
export const ACT_COVERAGE = {
  'M09b-fill-rate': [rotate],
  'M11-gestures': [
    {
      act: 'one-finger pan 10 s, flick, pinch in and out, tap a tile, pull down from the top edge, double-tap, rotate',
      handlers: ['pan', 'flick', 'pinch', 'tap-tile', 'pull-down', 'double-tap', 'rotate'],
      note: 'pinch is CDP-injected two-finger touch (OS multi-touch needs root); the rest is OS input',
    },
  ],
  'M11-pinch-desktop-safari': [
    { act: 'trackpad pinch in and out over a landmark tile', notDrivable: NOT_PHONE },
  ],
  'M16-background': [
    {
      act: 'leave the app for 30 s and return; lock the screen for 60 s and return',
      handlers: ['leave-app'],
      notDrivable: [{ match: /Lock the screen for/, reason: 'the screen is never locked' }],
    },
  ],
  'M16-low-power': [
    {
      act: 'turn Low Power Mode on',
      handlers: ['low-power', 'low-power-off'],
      note: 'iPhone: Settings, Battery (delegation 2); the Pixel throws NotDrivable (the saver does not engage while charging)',
    },
  ],
  'M17b-harness-desktop-safari': [
    {
      act: 'read the allocation growth and GC marker count off the Timelines panel',
      notDrivable: NOT_PHONE,
    },
  ],
  'M17b-harness-desktop-firefox': [
    { act: 'read the allocation growth off the Profiler', notDrivable: NOT_PHONE },
  ],
  'M18-anchors': [
    {
      act: 'rotate the phone once between the two stretches (the pan and zoom are scripted)',
      handlers: ['rotate'],
    },
  ],
  'M18-fill-rate-with-anchors': [{ act: 'rotate once', handlers: ['rotate'] }],
  'M18-pick': [
    {
      act: 'tap the highlighted rings at three zoom levels, then a button',
      handlers: ['tap-ring'],
    },
  ],
  'M18-touch-ghost': [
    { act: 'tap to move the cursor tile, then drag', handlers: ['tap-tile', 'drag'] },
  ],
  'M23-kill-resume': [
    {
      act: 'swipe-kill Safari and reopen it (the QR code again if the tab is gone)',
      handlers: ['relaunch'],
    },
  ],
  'M23-world-busy': [
    {
      act: 'tap "Open second tab", look at it, come back to this tab',
      handlers: ['second-tab'],
    },
  ],
  'M23-private': [
    {
      act: 'open the link in a Private tab (the bar offers it, with Copy link)',
      notDrivable:
        'Chrome ignores the incognito flag of an intent sent from adb; iPhone: not a Safari automation (delegation 2)',
    },
  ],
  'M23-hidden-pause': [{ act: 'leave the app for 30 s', handlers: ['leave-app'] }],
  'M23-export-import': [
    {
      act: 'tap Export, choose the file in Import (id walk-import), tap Import, open the imported world',
      notDrivable: 'the system file picker is not driven (the export lands in Downloads)',
    },
  ],
  'M29-socket-resume': [
    {
      act: 'do each drop for the stated time',
      handlers: ['leave-app', 'airplane'],
      notDrivable: [
        { match: /Lock the screen for/, reason: 'the screen is never locked' },
        {
          match: /^Turn Wi-Fi off so the phone moves to cellular/,
          reason: 'adb reverse: Wi-Fi is not the link',
        },
      ],
    },
  ],
  'M34-two-devices': [
    {
      act: 'collect on one device, place on the other (the bot does the Mac half)',
      handlers: [],
      note: 'the Mac bot does the other half; the phone shows no act prompt',
    },
  ],
  'M34-own-timer-bar': [
    {
      act: 'switch the phone off Wi-Fi when asked',
      notDrivable: 'adb reverse: Wi-Fi is not the link; needs a tunnel round',
    },
  ],
  'M37b-ios-background': [
    {
      act: 'background the tab under memory pressure for several minutes, three times',
      handlers: ['background'],
      note: 'the tab is backgrounded (Home), no memory pressure is applied',
    },
  ],
  'M38-hosted-boot': [{ act: 'open the URL on cellular', notDrivable: HUMAN }],
  'M38-socket-resume': [{ act: 'the M29 drops, copy the rows', notDrivable: HUMAN }],
  'M38-remote-motion': [{ act: 'as M34-remote-motion by hand', notDrivable: HUMAN }],
  'M39-full-game-touch': [
    { act: 'play the script of 34b by touch for 10 min', notDrivable: HUMAN },
  ],
  'M39-two-devices': [{ act: 'phone and Mac in one world', notDrivable: HUMAN }],
}

/**
 * The device person over a backend. `ctx`: `{ joinUrl, shotDir, log, returnLagMs, passRunner() }`.
 * `answer(prompt)` resolves `{ status: 'done' }`, `{ status: 'pending', shot }` (a judge sheet: left for the
 * orchestrator), `{ status: 'notDrivable', reason }`, `{ status: 'unmatched' }` or `{ status: 'error', error }`.
 */
export function devicePerson(backend, ctx = {}) {
  const c = { returnLagMs: 0, hideLagMs: 0, log: () => {}, sleep, ...ctx }
  return {
    handlers: HANDLERS,
    coverage: ACT_COVERAGE,
    ctx: c,
    async answer(prompt) {
      if (prompt.kind === 'judge') {
        const shot = c.shotPath?.(prompt)
        if (shot) await backend.screenshot(shot)
        return { status: 'pending', shot }
      }
      for (const h of HANDLERS) {
        const m = typeof h.match === 'function' ? h.match(prompt) : h.match.exec(prompt.text)
        if (!m) continue
        try {
          await h.run({ backend, prompt, ctx: c, text: prompt.text, m })
          return { status: 'done', handler: h.name }
        } catch (e) {
          if (e instanceof NotDrivable)
            return { status: 'notDrivable', reason: e.reason, handler: h.name }
          return { status: 'error', error: String(e.message ?? e), handler: h.name }
        }
      }
      return { status: 'unmatched' }
    },
  }
}
