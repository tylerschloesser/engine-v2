// `mipLevelCountFor` is pure (docs/plan/09b-terrain-art-and-lifecycle.md Scope): the browser-only
// `generateMips` itself needs a real `GPUDevice` and is exercised by `terrain-readback.spec.ts`'s
// `terrain.minified_converges_to_mean` (Tests added).
import { expect, test } from 'vitest'
import { mipLevelCountFor } from './mips.js'

test('mips: levels run to 1x1', () => {
  expect(mipLevelCountFor(1)).toBe(1)
  expect(mipLevelCountFor(4)).toBe(3) // 4, 2, 1
  expect(mipLevelCountFor(16)).toBe(5) // 16, 8, 4, 2, 1
  expect(mipLevelCountFor(1024)).toBe(11)
})

test('mips: rejects a non-power-of-two size', () => {
  expect(() => mipLevelCountFor(0)).toThrow(/power of two/)
  expect(() => mipLevelCountFor(-4)).toThrow(/power of two/)
  expect(() => mipLevelCountFor(3)).toThrow(/power of two/)
  expect(() => mipLevelCountFor(1.5)).toThrow(/power of two/)
})
