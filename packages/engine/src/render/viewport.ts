// Canvas size/DPR/render-scale lifecycle (docs/decisions/0018-renderer.md §8; docs/plan/
// 09b-terrain-art-and-lifecycle.md Scope, step 4): the `ResizeObserver` (`device-pixel-content-box`,
// Safari fallback, a re-armed one-shot `matchMedia`), render-scale computation
// (`ClientOptions.render`), clamping to `maxTextureDimension2D`, and applying a pending resize once
// per frame. `frame-loop.ts`'s own `tick()` calls `applyPending()` as its very first step, before
// the `camera` phase (Seams, Provides: "`renderer.onViewportChange(cb)` called at most once per
// frame, before the `camera` phase").
//
// Also owns configuring a canvas's WebGPU context once per device (0018 §8's first sentence: canvas
// lifecycle is one topic even though the prose splits "configured once" from "resize/DPR"):
// `getPreferredCanvasFormat()`, `alphaMode: 'opaque'`, no depth, no MSAA. Never re-configured on
// resize -- a configured canvas context's backbuffer follows `canvas.width`/`height` automatically on
// the next `getCurrentTexture()` call.
import type { TerrainRenderer } from './terrain.js'

/** The render-scale slice of `ClientOptions.render` (`client.ts` owns the full shape, which also
 * carries `neighbourCutoffPx` -- not this module's concern). */
export type RenderScaleOptions = { scale?: number; scaleCap?: number }

/** 0018 §8: "Render scale = min(DPR, 2) by default, per-game config." Not exposed as a
 * `RenderScaleOptions` default value (there is nothing to default `scaleCap` itself to besides this
 * constant): a caller's `scaleCap` narrows it (the fill-rate check's own fallback switch,
 * Consequences: `?scaleCap=1.5`, `?scaleCap=1`), never widens it. */
const DEFAULT_SCALE_CAP = 2

/** `opts.scale`, when given, overrides the DPR-derived value entirely (Tests added: "`render: {
 * scale: 1 }` gives the CSS size at any DPR") -- it is not clamped by `scaleCap` at all. Otherwise
 * `min(dpr, opts.scaleCap ?? 2)` (Tests added: "`dpr: 3` gives a render target of twice the CSS
 * size, `dpr: 1.5` gives 1.5 times"). */
export function computeRenderScale(dpr: number, opts?: RenderScaleOptions): number {
  if (opts?.scale !== undefined) return opts.scale
  const cap = opts?.scaleCap ?? DEFAULT_SCALE_CAP
  return Math.min(dpr, cap)
}

/** `getPreferredCanvasFormat()`, `alphaMode: 'opaque'` (0018 §8). Throws if `canvas.getContext
 * ('webgpu')` returns `null` (an already-`getContext`-ed canvas of a different type, or a browser
 * with no WebGPU canvas support at all -- `checkSupport()` is the place that reports the latter
 * before a page ever reaches this call). */
export function configureCanvasContext(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
): GPUCanvasContext {
  const gpu = (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu
  if (!gpu) throw new Error('configureCanvasContext: navigator.gpu is not present')
  const ctx = canvas.getContext('webgpu')
  if (!ctx) throw new Error('configureCanvasContext: canvas.getContext("webgpu") returned null')
  ctx.configure({ device, format: gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' })
  return ctx
}

type PendingSize = { cssWidth: number; cssHeight: number; dpr: number }

export interface ViewportController {
  /** Applies the latest observed (or test-forced) CSS size/DPR to `canvas.width`/`height` and the
   * renderer's `viewport` in place, clamped to `maxTextureDimension2D`; calls every
   * `onViewportChange` callback exactly once if anything changed. Called once per frame, before the
   * `camera` phase (`frame-loop.ts`'s own `tick()`). Returns whether anything changed. */
  applyPending(): boolean
  /** 0018 §8 backgrounding, "on visible ... re-check size": re-reads the canvas's current CSS size
   * and the live `devicePixelRatio` directly (rather than waiting for a `ResizeObserver` report that
   * may never fire again if nothing actually changed) and marks it pending for the next
   * `applyPending()`. */
  invalidate(): void
  /** Test-only (`engine/test.setViewport`): overrides the next observed size/DPR directly, bypassing
   * `ResizeObserver`/`matchMedia` entirely -- headless Chromium cannot really resize a window or
   * change display DPI. Takes effect on the next `applyPending()`, not immediately (the same "applied
   * at the start of the next frame" contract a real resize report follows). */
  forceSize(cssWidth: number, cssHeight: number, dpr: number): void
  dispose(): void
}

function readCssSizeAndDpr(canvas: HTMLCanvasElement): PendingSize {
  const rect = canvas.getBoundingClientRect()
  return { cssWidth: rect.width, cssHeight: rect.height, dpr: globalThis.devicePixelRatio || 1 }
}

/**
 * Owns the resize/DPR/render-scale lifecycle for one canvas + renderer pair. `maxTextureDimension2D`
 * is a plain number, not read from `device.limits` by this function itself, so a test can pass a
 * small one without ever allocating a huge real texture (production passes
 * `device.limits.maxTextureDimension2D`).
 */
export function createViewportController(
  canvas: HTMLCanvasElement,
  renderer: Pick<TerrainRenderer, 'viewport' | 'notifyViewportChange'>,
  opts: { render?: RenderScaleOptions; maxTextureDimension2D: number; doc?: Document },
): ViewportController {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined)
  let pending: PendingSize | undefined
  let dirty = false

  function setPending(size: PendingSize): void {
    pending = size
    dirty = true
  }

  // `device-pixel-content-box` gives the exact backing-store size the browser itself would use,
  // with no DPR-rounding error of our own to get wrong; a browser that throws on this `box` option
  // (Safari, 0018 §8) falls back to `content-box` (CSS pixels) times the live `devicePixelRatio`.
  let ro: ResizeObserver | undefined
  let usesDevicePixelBox = true
  function onResizeEntries(entries: readonly ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1]
    if (!entry) return
    const dpr = globalThis.devicePixelRatio || 1
    const deviceBox = usesDevicePixelBox ? entry.devicePixelContentBoxSize?.[0] : undefined
    if (deviceBox) {
      setPending({
        cssWidth: deviceBox.inlineSize / dpr,
        cssHeight: deviceBox.blockSize / dpr,
        dpr,
      })
      return
    }
    const contentBox = entry.contentBoxSize?.[0]
    if (contentBox) {
      setPending({ cssWidth: contentBox.inlineSize, cssHeight: contentBox.blockSize, dpr })
      return
    }
    setPending(readCssSizeAndDpr(canvas))
  }
  try {
    ro = new ResizeObserver(onResizeEntries)
    ro.observe(canvas, { box: 'device-pixel-content-box' })
  } catch {
    usesDevicePixelBox = false
    ro = new ResizeObserver(onResizeEntries)
    ro.observe(canvas, { box: 'content-box' })
  }

  // A re-armed one-shot `matchMedia` (0018 §8): a DPR change (browser zoom, monitor switch) with no
  // accompanying CSS-size change never fires `ResizeObserver` at all.
  let mq: MediaQueryList | undefined
  function onDprChange(): void {
    setPending(readCssSizeAndDpr(canvas))
    armDprWatch()
  }
  function armDprWatch(): void {
    mq?.removeEventListener('change', onDprChange)
    const dpr = globalThis.devicePixelRatio || 1
    mq = doc?.defaultView?.matchMedia(`(resolution: ${dpr}dppx)`)
    mq?.addEventListener('change', onDprChange, { once: true })
  }
  armDprWatch()

  return {
    applyPending() {
      if (!dirty || !pending) return false
      dirty = false
      const { cssWidth, cssHeight, dpr } = pending
      const renderScale = computeRenderScale(dpr, opts.render)
      const limit = opts.maxTextureDimension2D
      const widthPx = Math.max(1, Math.min(Math.round(cssWidth * renderScale), limit))
      const heightPx = Math.max(1, Math.min(Math.round(cssHeight * renderScale), limit))
      const v = renderer.viewport
      const changed =
        widthPx !== v.widthPx ||
        heightPx !== v.heightPx ||
        dpr !== v.dpr ||
        renderScale !== v.renderScale
      if (!changed) return false
      canvas.width = widthPx
      canvas.height = heightPx
      v.widthPx = widthPx
      v.heightPx = heightPx
      v.dpr = dpr
      v.renderScale = renderScale
      renderer.notifyViewportChange()
      return true
    },

    invalidate() {
      setPending(readCssSizeAndDpr(canvas))
    },

    forceSize(cssWidth, cssHeight, dpr) {
      setPending({ cssWidth, cssHeight, dpr })
    },

    dispose() {
      ro?.disconnect()
      mq?.removeEventListener('change', onDprChange)
    },
  }
}
