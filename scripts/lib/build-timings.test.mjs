// Regression for docs/plan/17d-fast-tier-wall-time.md steps 2-3: the `fixtures` build step's own
// bindings call (`exportBindings`, `packages/engine/src/build-game.ts`) must stay in the same
// package-selection scope (`--workspace`) as the `cargo-tests` build step's `cargo nextest run
// --workspace --no-run` -- a mismatch there dirtied the other's fingerprint for a shared dependency
// (`UnitDependencyInfoChanged` on `serde`) on every `pnpm test`, recompiling `fx-puts` from
// scratch every single run (measured: 15-16 s, see the brief's Deviations).
//
// This reads `test-results/build/timings.json` (`buildStepsReport`, `./report.mjs`), written by
// *this same* `pnpm test` invocation's own build phase (`scripts/test.mjs` runs every build step,
// in order, before any suite starts) -- not a second, ad-hoc cargo invocation of its own. A first
// version of this test called `cargo nextest run --workspace --no-run` directly: it passed alone,
// but the `unit`/`wasm` suites run concurrently with the `rust` suite (`scripts/test.mjs` Phase 2),
// which hits the very same shared cargo target-dir lock -- pushing the whole suite well over its
// own budget waiting for it, and once even misattributing an unrelated concurrent `Compiling
// fx-hash` (lock contention, not this regression) as a failure. Reading the already-written
// timings avoids the shared lock entirely.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const timingsPath = fileURLToPath(new URL('../../test-results/build/timings.json', import.meta.url))

function stepMs(name) {
  const report = JSON.parse(readFileSync(timingsPath, 'utf8'))
  const step = report.steps.find((s) => s.name === name)
  if (!step) throw new Error(`no "${name}" step in ${timingsPath} -- run through \`pnpm test\``)
  return step.ms
}

// Warm, no source change, measures under 1 s each (fixtures ~0.9 s, cargo-tests ~0.2 s); under
// load right after a full `pnpm test` (a real, machine-dependent measurement, not the regression:
// no "Compiling" line, and only one of the two steps slows down), `fixtures` alone was seen at
// 8.3 s. The regression this guards recompiled `fx-puts` on *both* steps, every run, consistently
// at 15-16 s each. 12 s sits clear of both.
const REBUILD_THRESHOLD_MS = 12_000

describe('build steps: no rebuild ping-pong between fixtures and cargo-tests', () => {
  test('fixtures step stays well under a re-triggered fx-puts rebuild', () => {
    expect(stepMs('fixtures')).toBeLessThan(REBUILD_THRESHOLD_MS)
  })

  test('cargo-tests step stays well under a re-triggered fx-puts rebuild', () => {
    expect(stepMs('cargo-tests')).toBeLessThan(REBUILD_THRESHOLD_MS)
  })
})
