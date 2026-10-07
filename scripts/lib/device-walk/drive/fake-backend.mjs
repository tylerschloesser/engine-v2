// A `DeviceBackend` that records its calls (M39j step 1): the device person's mapping from prompt text to
// device actions is tested without hardware. `pages` answers `readPage` by a substring of the script.
import { NotDrivable, withQuiet } from './backend.mjs'

/**
 * @param {{ view?: { w: number, h: number }, tiles?: number[], lowPower?: 'ok' | 'notDrivable', pages?: Record<string, unknown> }} [o]
 * `tiles`: the zoom the page reports, one value per read (the last repeats).
 */
export function createFakeBackend(o = {}) {
  const view = o.view ?? { w: 400, h: 800 }
  const tiles = [...(o.tiles ?? [12, 40, 120, 260, 120, 40, 12])]
  const calls = []
  const times = [] // times[i] is when calls[i] was made (Date.now())
  const violations = [] // calls refused inside a quiet window
  const rec =
    (m, ret) =>
    async (...args) => {
      calls.push({ m, args })
      times.push(Date.now())
      return typeof ret === 'function' ? ret(...args) : ret
    }
  const pages = {
    'innerWidth, h: innerHeight': () => view,
    tiles_across: () => (tiles.length > 1 ? tiles.shift() : tiles[0]),
    "tagName === 'CANVAS'": () => ({ x: view.w / 2, y: view.h / 2 }),
    visibilityState: 'hidden',
    'act.zoomTo': () => 1,
    "shadowRoot?.querySelector('input')": () => o.judgeShown ?? true,
    "of document.querySelectorAll('button')": () => null,
    '#walk-ring': () => ({ x: 123, y: 234 }),
    'Open second tab': () => ({ x: 50, y: 700 }),
    'Redo this check': () => ({ x: 60, y: 710 }),
    ...(o.pages ?? {}),
  }
  const b = {
    calls,
    times,
    violations,
    names: () => calls.map((c) => c.m),
    open: rec('open'),
    readPage: async (js) => {
      calls.push({ m: 'readPage', args: [js] })
      times.push(Date.now())
      const key = Object.keys(pages).find((k) => js.includes(k))
      if (!key) throw new Error(`fake backend: no page answer for ${js.slice(0, 80)}`)
      const v = pages[key]
      return typeof v === 'function' ? v(js) : v
    },
    touch: rec('touch'),
    swipe: rec('swipe'),
    tap: rec('tap'),
    rotate: rec('rotate'),
    home: rec('home'),
    returnToBrowser: rec('returnToBrowser'),
    relaunchBrowser: rec('relaunchBrowser'),
    setAirplane: rec('setAirplane'),
    setLowPower: async (on) => {
      calls.push({ m: 'setLowPower', args: [on] })
      times.push(Date.now())
      if (o.lowPower === 'notDrivable')
        throw new NotDrivable('the fake phone has no Low Power Mode')
    },
    screenshot: rec('screenshot'),
    cleanup: rec('cleanup'),
    // The context switches of `--detach-inspector` (iOS only): recorded, not part of the Android-shaped interface.
    ...(o.inspector ? { native: rec('native'), web: rec('web') } : {}),
  }
  return withQuiet(b, { onViolation: (m) => violations.push({ m, at: Date.now() }) })
}
