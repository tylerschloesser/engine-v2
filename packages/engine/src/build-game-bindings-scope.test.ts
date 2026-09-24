// Regression for docs/plan/17d-fast-tier-wall-time.md steps 2-3 (Fix round 1: the wall-clock
// version of this test, scripts/lib/build-timings.test.mjs, failed on legitimate work -- any real
// source change makes `fixtures` compile for real, which is not the regression). Deterministic
// instead: read the actual cargo argument lists `exportBindings` (`./build-game.ts`) and the
// `cargo-tests` build step (`scripts/suites.mjs`) use, and assert they share package-selection
// scope. No cargo call, no timing, no flakiness -- the dirty reason
// (`CARGO_LOG=cargo::core::compiler::fingerprint=info`'s own `UnitDependencyInfoChanged` on a
// shared dependency's fingerprint) is about scope alone (`-p`/no-flag vs `--workspace`), not
// content or wall time, so this is exactly what has to stay true.
import { describe, expect, test } from 'vitest'
import { buildSteps } from '../../../scripts/suites.mjs'
import { BINDINGS_CARGO_ARGS } from './build-game.js'

function packageSelectionFlags(args: string[]): string[] {
  return args.filter((a) => a === '-p' || a === '--package' || a === '--workspace')
}

describe('exportBindings cargo args: workspace-scope regression', () => {
  test('exportBindings and the cargo-tests build step share --workspace, neither narrows with -p', () => {
    const cargoTests = buildSteps.find((step) => step.name === 'cargo-tests')
    if (!cargoTests) throw new Error('no "cargo-tests" step in scripts/suites.mjs')

    expect(packageSelectionFlags(BINDINGS_CARGO_ARGS)).toEqual(['--workspace'])
    expect(packageSelectionFlags(cargoTests.args)).toEqual(['--workspace'])
  })
})
