// The device backend (M39j step 1): what the Mac can do to a USB-attached phone, the same eleven things on
// every platform. `devicePerson(backend)` (person.mjs) turns the walk's prompts into calls on it; the Android
// backend (android.mjs, adb + raw CDP) and the iOS one (M39j delegation 2, Appium/WDA) implement it; a fake
// that records calls (fake-backend.mjs) tests the mapping without hardware.
//
// All coordinates are CSS px of the page in front (what `innerWidth`/`getBoundingClientRect` say), never
// device pixels: a backend converts. Compute touch points from the page's own `innerWidth`/`innerHeight` and
// the canvas rect, never from constants (M39h: fixture pages lay out at device width).

/** A thing this phone cannot do (Low Power Mode on a charging Pixel, the lock screen). Its message is the reason. */
export class NotDrivable extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'NotDrivable'
    this.reason = reason
  }
}

/** One finger's path: from, to (CSS px). */
export const finger = (x1, y1, x2, y2) => ({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 } })

/**
 * @typedef {{ from: { x: number, y: number }, to: { x: number, y: number } }} Finger
 * @typedef {object} DeviceBackend
 * @property {(url: string) => Promise<void>} open  start the browser fresh on `url` (no QR) and attach to its page
 * @property {(js: string) => Promise<unknown>} readPage  evaluate a JS expression in the page in front, by value
 * @property {(fingers: Finger[], durationMs: number) => Promise<void>} touch  1 or 2 fingers, CSS px
 * @property {(x1: number, y1: number, x2: number, y2: number, durationMs: number) => Promise<void>} swipe  one finger
 * @property {(x: number, y: number) => Promise<void>} tap  one finger
 * @property {(orientation: 'portrait' | 'landscape') => Promise<void>} rotate
 * @property {() => Promise<void>} home  leave the browser for the home screen
 * @property {() => Promise<void>} returnToBrowser  come back to the tab that was in front
 * @property {(url: string) => Promise<void>} relaunchBrowser  kill the browser, start it on `url`
 * @property {(on: boolean) => Promise<void>} setAirplane
 * @property {(on: boolean) => Promise<void>} setLowPower  may throw NotDrivable
 * @property {(path: string) => Promise<void>} screenshot
 * @property {() => Promise<void>} cleanup  toggles off, rotation restored, forwards removed
 */
export const BACKEND_METHODS = [
  'open',
  'readPage',
  'touch',
  'swipe',
  'tap',
  'rotate',
  'home',
  'returnToBrowser',
  'relaunchBrowser',
  'setAirplane',
  'setLowPower',
  'screenshot',
  'cleanup',
]

/** Throws when `b` lacks a method of the interface (a backend is plain methods, no base class). */
export function assertBackend(b) {
  const missing = BACKEND_METHODS.filter((m) => typeof b?.[m] !== 'function')
  if (missing.length) throw new Error(`device backend lacks: ${missing.join(', ')}`)
  return b
}
