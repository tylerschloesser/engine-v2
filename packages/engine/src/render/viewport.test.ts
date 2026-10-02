// `render/viewport.ts`'s pure render-scale computation (docs/plan/09b-terrain-art-and-lifecycle.md,
// Tests added: "`viewport.render_scale_caps_at_2`"). The `ResizeObserver`/`matchMedia`/canvas-context
// machinery needs a real DOM and a real `GPUDevice`, so it is proven only by the browser suite
// (`tests/browser/viewport.spec.ts`); this file covers what needs neither.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { computeRenderScale, configureCanvasContext } from './viewport.js'

test('viewport.render_scale_defaults_to_dpr_capped_at_2', () => {
  expect(computeRenderScale(1)).toBe(1)
  expect(computeRenderScale(1.5)).toBe(1.5)
  expect(computeRenderScale(2)).toBe(2)
  expect(computeRenderScale(3)).toBe(2) // 0018 §8: "min(DPR, 2) by default"
})

test('viewport.render_scale_cap_narrows_the_default', () => {
  expect(computeRenderScale(3, { scaleCap: 1.5 })).toBe(1.5)
  expect(computeRenderScale(3, { scaleCap: 1 })).toBe(1)
  expect(computeRenderScale(0.5, { scaleCap: 1 })).toBe(0.5) // a cap never widens past the real DPR
})

test('viewport.explicit_scale_overrides_dpr_entirely', () => {
  expect(computeRenderScale(3, { scale: 1 })).toBe(1)
  expect(computeRenderScale(1, { scale: 1 })).toBe(1)
  // A `scaleCap` alongside an explicit `scale` is not consulted at all.
  expect(computeRenderScale(3, { scale: 4, scaleCap: 1 })).toBe(4)
})

// 0018 §8 (canvas): configured with the preferred format, `alphaMode: 'opaque'`, no depth, no MSAA.
// A fake `navigator.gpu` and canvas stand in for the browser: what is asserted is the exact
// configuration the engine hands `GPUCanvasContext.configure`, and (source scan) that no render
// pipeline or texture of the engine asks for a depth or multisampled target.
test('viewport.canvas_configured_opaque_preferred_format_no_depth_no_msaa', () => {
  const configured: Record<string, unknown>[] = []
  const g = globalThis as unknown as { navigator?: unknown }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } },
  })
  try {
    const ctx = { configure: (c: Record<string, unknown>) => configured.push(c) }
    const canvas = { getContext: (kind: string) => (kind === 'webgpu' ? ctx : null) }
    const device = {} as GPUDevice
    configureCanvasContext(canvas as unknown as HTMLCanvasElement, device)
    expect(configured).toEqual([{ device, format: 'bgra8unorm', alphaMode: 'opaque' }])
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    else delete g.navigator
  }
  const src = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) walk(path)
      else if (/\.(ts|wgsl)$/.test(e.name) && !e.name.endsWith('.test.ts')) {
        if (/\b(depthStencil|multisample|sampleCount)\b/.test(readFileSync(path, 'utf8')))
          offenders.push(path.slice(src.length))
      }
    }
  }
  walk(join(src, 'render'))
  offenders.push(
    ...(/\b(depthStencil|multisample|sampleCount)\b/.test(
      readFileSync(join(src, 'frame-loop.ts'), 'utf8'),
    )
      ? ['frame-loop.ts']
      : []),
  )
  if (offenders.length > 0) throw new Error(`depth/MSAA state in: ${offenders.join(', ')}`)
})
