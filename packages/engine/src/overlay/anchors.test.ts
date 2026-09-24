// docs/plan/18-picking-and-overlay.md Tests added: `overlay.rebase_math`, `overlay.align_offsets`.
// Pure math only, no DOM (`vitest.config.ts`'s `unit` project runs `environment: 'node'`) -- exactly
// the functions `createOverlay`'s stateful per-frame code calls, exercised directly.
import { expect, test } from 'vitest'
import {
  ALIGN_OFFSET_PERCENT,
  anchorTransform,
  needsRebase,
  REBASE_THRESHOLD_PX,
  rebaseOffset,
} from './anchors.js'

test('overlay.rebase_math', () => {
  // An anchor's own `--wx/--wy` is just its world position minus the origin.
  expect(rebaseOffset(10, -3, 0, 0)).toEqual({ wx: 10, wy: -3 })
  expect(rebaseOffset(10, -3, 4, 4)).toEqual({ wx: 6, wy: -7 })

  // The invariant a re-base must preserve: `origin_screen + offset * z` is the same real screen
  // position no matter which origin was used to compute `offset`, for any `z` (the layer's own
  // `transform` carries `origin_screen`, so this is what makes a re-base invisible on screen).
  const z = 12.5
  const worldX = 1234.5
  const worldY = -876.25
  const oldOrigin = { x: 1000, y: -800 }
  const newOrigin = { x: 1200, y: -900 }
  const beforeOffset = rebaseOffset(worldX, worldY, oldOrigin.x, oldOrigin.y)
  const afterOffset = rebaseOffset(worldX, worldY, newOrigin.x, newOrigin.y)
  // "origin screen position" stands in for `worldToScreen(origin)` here: linear in the origin, so
  // the difference between the two origins' own screen positions is exactly `(newOrigin - oldOrigin)
  // * z` (`worldToScreen`'s own formula, `camera/transform.ts`) -- asserted directly rather than
  // pulling in a `CameraState`/`CameraViewport` fixture, since this file's own claim is about the
  // pure offset arithmetic alone.
  const originScreenDeltaX = (newOrigin.x - oldOrigin.x) * z
  const originScreenDeltaY = (newOrigin.y - oldOrigin.y) * z
  const beforeTotalX = beforeOffset.wx * z
  const beforeTotalY = beforeOffset.wy * z
  const afterTotalX = originScreenDeltaX + afterOffset.wx * z
  const afterTotalY = originScreenDeltaY + afterOffset.wy * z
  expect(afterTotalX).toBeCloseTo(beforeTotalX, 6)
  expect(afterTotalY).toBeCloseTo(beforeTotalY, 6)

  // `needsRebase`: exactly the 50,000 CSS px threshold (0019 §5).
  expect(needsRebase(REBASE_THRESHOLD_PX - 1, 0)).toBe(false)
  expect(needsRebase(REBASE_THRESHOLD_PX + 1, 0)).toBe(true)
  expect(needsRebase(0, -(REBASE_THRESHOLD_PX + 1))).toBe(true)
})

test('overlay.align_offsets', () => {
  expect(ALIGN_OFFSET_PERCENT.bottom).toEqual({ x: -50, y: -100 })
  expect(ALIGN_OFFSET_PERCENT.center).toEqual({ x: -50, y: -50 })
  expect(ALIGN_OFFSET_PERCENT.top).toEqual({ x: -50, y: 0 })

  // The static rule's own transform text embeds exactly those percentages, plus the shared
  // `--z`/`--wx`/`--wy` calc (0019 §5's own literal formula for `bottom`).
  expect(anchorTransform('bottom')).toBe(
    'translate(calc(var(--z, 1) * var(--wx, 0) * 1px), calc(var(--z, 1) * var(--wy, 0) * 1px)) ' +
      'translate(-50%, -100%)',
  )
  expect(anchorTransform('center')).toContain('translate(-50%, -50%)')
  expect(anchorTransform('top')).toContain('translate(-50%, 0%)')
})
