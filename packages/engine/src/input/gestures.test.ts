// 0019 §3 browser-gesture plumbing and the no-`getCoalescedEvents` rule, asserted on the listener
// installers and the page-CSS helper with fake DOM objects (no browser): the canvas gets non-passive
// `wheel`/`gesture*` listeners that call `preventDefault()`, the canvas CSS is `touch-action: none`,
// and nothing in the engine source calls `getCoalescedEvents()` (it allocates an array per call).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { installPageStyles } from './page-css.js'
import { installPointerListeners, PointerSlots } from './pointers.js'
import { installWheelListeners, WheelState } from './wheel.js'

type Handler = (e: Event) => void
class FakeCanvas {
  readonly listeners = new Map<string, { handler: Handler; options: unknown }>()
  addEventListener(type: string, handler: Handler, options?: unknown): void {
    this.listeners.set(type, { handler, options })
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }
  setPointerCapture(): void {}
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 30, top: 70, width: 800, height: 600 }
  }
}
/** A cancelable event: `preventDefault()` flips `defaultPrevented` once, as the DOM does. */
function cancelable(extra: object): Event {
  const e = { defaultPrevented: false, cancelable: true, ...extra } as unknown as {
    defaultPrevented: boolean
    preventDefault(): void
  }
  e.preventDefault = () => {
    e.defaultPrevented = true
  }
  return e as unknown as Event
}

test('input gestures: wheel listener is non-passive on the canvas and calls preventDefault', () => {
  const canvas = new FakeCanvas()
  installWheelListeners(new WheelState(), canvas as unknown as HTMLElement)
  const wheel = canvas.listeners.get('wheel')
  expect(wheel?.options).toEqual({ passive: false })
  const e = cancelable({ deltaY: 10, deltaMode: 0, offsetX: 1, offsetY: 2, ctrlKey: false })
  wheel?.handler(e)
  expect(e.defaultPrevented).toBe(true)
})

test('input gestures: gesturestart, gesturechange and gestureend are non-passive and call preventDefault', () => {
  const canvas = new FakeCanvas()
  installPointerListeners(new PointerSlots(), canvas as unknown as HTMLElement)
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    const l = canvas.listeners.get(type)
    expect(l?.options, type).toEqual({ passive: false })
    const e = cancelable({ scale: 1, offsetX: 0, offsetY: 0 })
    l?.handler(e)
    expect(e.defaultPrevented, type).toBe(true)
  }
})

test('input gestures: the page CSS sets touch-action none on the canvas', () => {
  const made: { id?: string; textContent?: string; remove?: () => void }[] = []
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => {
      const el = { remove: () => {} } as { id?: string; textContent?: string; content?: string }
      made.push(el)
      return el
    },
    head: { appendChild: () => {} },
  }
  installPageStyles(doc as unknown as Document)
  const css = made[0]?.textContent ?? ''
  expect(css).toMatch(/canvas \{[^}]*touch-action: none;/)
  expect(css).toMatch(/html, body \{[^}]*overscroll-behavior: none;/)
})

test('input gestures: nothing in the engine source calls getCoalescedEvents', () => {
  const src = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        // A comment may name the rule; a call is `.getCoalescedEvents(`.
        if (/\.getCoalescedEvents\s*\(/.test(readFileSync(path, 'utf8')))
          offenders.push(path.slice(src.length))
      }
    }
  }
  walk(src)
  if (offenders.length > 0)
    throw new Error(`getCoalescedEvents() called in: ${offenders.join(', ')}`)
  expect(readFileSync(join(src, 'input/pointers.ts'), 'utf8')).toContain('onMove')
})

test('input gestures: gesture_event_without_offset_records_finite_point', () => {
  const canvas = new FakeCanvas()
  const state = new PointerSlots()
  installPointerListeners(state, canvas as unknown as HTMLElement)
  // WebKit's GestureEvent carries clientX/clientY and no offsetX/offsetY.
  canvas.listeners
    .get('gesturestart')
    ?.handler(cancelable({ scale: 1, clientX: 130, clientY: 270 }))
  expect(state.gesture.x).toBe(100)
  expect(state.gesture.y).toBe(200)
  canvas.listeners
    .get('gesturechange')
    ?.handler(cancelable({ scale: 1.5, clientX: 230, clientY: 370 }))
  expect(state.gesture.scale).toBe(1.5)
  expect(state.gesture.x).toBe(200)
  expect(state.gesture.y).toBe(300)
})
