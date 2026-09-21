// `render/viewport.ts`'s pure render-scale computation (docs/plan/09b-terrain-art-and-lifecycle.md,
// Tests added: "`viewport.render_scale_caps_at_2`"). The `ResizeObserver`/`matchMedia`/canvas-context
// machinery needs a real DOM and a real `GPUDevice`, so it is proven only by the browser suite
// (`tests/browser/viewport.spec.ts`); this file covers what needs neither.
import { expect, test } from 'vitest'
import { computeRenderScale } from './viewport.js'

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
