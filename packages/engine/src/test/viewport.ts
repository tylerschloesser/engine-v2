// `engine/test`: `setViewport`/`setVisibility` (docs/plan/09b-terrain-art-and-lifecycle.md Seams,
// Provides), driving the real `ViewportController`/`FrameLoop` a page's own production wiring
// created (`frame-loop.ts`'s `createRealFrameLoop`) -- the same "attach once, look up by client"
// shape `test/render.ts`'s `attachRenderer`/`clientRenderers` already uses. Never imported by
// production code.
import type { Client } from '../client.js'
import { clientTestHandle } from '../client.js'
import type { FrameLoop } from '../frame-loop.js'
import type { ViewportController } from '../render/viewport.js'
import { CB_FLAGS, FLAG_REBASE } from '../sab/control.js'

const controllers = new WeakMap<Client, ViewportController>()
const loops = new WeakMap<Client, FrameLoop>()

/** Pairs `client` with the `ViewportController`/`FrameLoop` a page's own `createRealFrameLoop` call
 * produced, so `setViewport`/`setVisibility` need no extra argument (Seams, Provides). Call once,
 * right after wiring. */
export function attachViewportTestHooks(
  client: Client,
  hooks: { viewport: ViewportController; loop: FrameLoop },
): void {
  controllers.set(client, hooks.viewport)
  loops.set(client, hooks.loop)
}

function controllerOf(client: Client): ViewportController {
  const c = controllers.get(client)
  if (!c) throw new Error('setViewport: call attachViewportTestHooks(client, ...) first')
  return c
}

function loopOf(client: Client): FrameLoop {
  const l = loops.get(client)
  if (!l) throw new Error('setVisibility: call attachViewportTestHooks(client, ...) first')
  return l
}

/** `engine/test.setViewport` (Seams, Provides): overrides the next observed CSS size/DPR directly
 * -- headless Chromium cannot really resize a window or change display DPI -- queued for the next
 * `FrameLoop.tick()`, exactly like a real `ResizeObserver`/`matchMedia` report would be (0018 §8:
 * "size applied at the start of the next frame"). Does not itself apply anything. */
export function setViewport(
  client: Client,
  opts: { cssWidth: number; cssHeight: number; dpr: number },
): void {
  controllerOf(client).forceSize(opts.cssWidth, opts.cssHeight, opts.dpr)
}

/** `engine/test.setVisibility` (Seams, Provides): drives `FrameLoop.pause()`/`resume()` directly,
 * bypassing the real `visibilitychange` event -- headless Chromium's `document.hidden` cannot be
 * forced `true` from outside the page in a way this harness can reach. */
export function setVisibility(client: Client, state: 'hidden' | 'visible'): void {
  const loop = loopOf(client)
  if (state === 'hidden') loop.pause()
  else loop.resume()
}

/** Reads `CB_FLAGS`'s `FLAG_REBASE` bit (0018 §8; `Client.setFlags`'s own doc comment): what
 * `lifecycle: hidden stops visible rebases` asserts after `setVisibility(client, 'visible')`. */
export function rebaseFlagSet(client: Client): boolean {
  const { control } = clientTestHandle(client)
  return (Atomics.load(control.words, CB_FLAGS) & FLAG_REBASE) !== 0
}

/** Clears `FLAG_REBASE` only (any other bit of `CB_FLAGS` is left alone): lets one test observe the
 * flag being set more than once across several `setVisibility` cycles. */
export function clearRebaseFlag(client: Client): void {
  const { control } = clientTestHandle(client)
  Atomics.and(control.words, CB_FLAGS, ~FLAG_REBASE)
}
