// docs/plan/09-renderer-terrain.md, Tests added: "wgsl.generated_is_fresh" -- `generate()` is the
// exact function `node scripts/embed-wgsl.mjs` runs to write this directory's own
// `wgsl.generated.ts`; this compares its output against the checked-in file without shelling out.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
// @ts-expect-error -- plain repo-only script, no .d.ts (packages/engine/CLAUDE.md: "scripts/... are
// repo-only, plain Node").
import { generate, outFile } from '../../scripts/embed-wgsl.mjs'

test('wgsl: generated is fresh', () => {
  const checkedIn = readFileSync(outFile, 'utf8')
  expect(generate()).toBe(checkedIn)
})
