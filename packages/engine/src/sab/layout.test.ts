import { expect, test } from 'vitest'
import {
  createSabSet,
  DRAWLIST_HEADER_BYTES,
  MAX_GEN_WORKERS,
  RING_DEFAULTS,
  WORKER_GEN1,
} from './layout.js'

// `layout.sab_total_under_budget` (M06, Tests added) lives
// in tests/support/layout-budget.test.ts: `tests/support/budgets.ts` cannot be imported from a
// file under src/ (tsc's rootDir for packages/engine/tsconfig.json is src/ itself).
test('layout.createSabSet shape', () => {
  const set = createSabSet('sim', MAX_GEN_WORKERS)
  expect(set.control.byteLength).toBeGreaterThan(0)
  expect(set.cameraBlock.byteLength).toBe(80)
  expect(set.genRequest).toHaveLength(MAX_GEN_WORKERS)
  expect(set.genResult).toHaveLength(MAX_GEN_WORKERS)
  expect(WORKER_GEN1).toBe(3)

  // One gen worker: exactly one SAB per gen ring, not two.
  const single = createSabSet('net', 1)
  expect(single.genRequest).toHaveLength(1)
  expect(single.genResult).toHaveLength(1)

  // Ring SABs are sized control block (32 B) + slotBytes * slots.
  const downlinkBytes = single.downlink.byteLength
  expect(downlinkBytes).toBe(32 + RING_DEFAULTS.downlink.slotBytes * RING_DEFAULTS.downlink.slots)
})

// 0024 §11a: the DrawList slot header is 1,024 B (the Rust `HEADER_BYTES`, pinned by
// `drawlist_header_is_1024_with_anchors_at_128`), and the triple's header field carries it.
test('layout.drawlist header is 1024 bytes', () => {
  expect(DRAWLIST_HEADER_BYTES).toBe(1024)
})
