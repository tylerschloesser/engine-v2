import { expect, test } from 'vitest'
import { type CameraPose, shouldMoveToSpawn } from './spawn.js'

const created: CameraPose = { centreX: 0, centreY: 0, tilesAcross: 12 }

test('spawn_move_applies_to_untouched_camera', () => {
  expect(shouldMoveToSpawn(false, created, { ...created })).toBe(true)
  expect(shouldMoveToSpawn(true, created, { ...created })).toBe(false) // restored: never
})

test('spawn_move_skipped_once_camera_moved', () => {
  expect(shouldMoveToSpawn(false, created, { ...created, centreX: 30 })).toBe(false)
  expect(shouldMoveToSpawn(false, created, { ...created, centreY: -1 })).toBe(false)
  expect(shouldMoveToSpawn(false, created, { ...created, tilesAcross: 20 })).toBe(false)
})
