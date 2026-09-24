// Regression for docs/plan/17d-fast-tier-wall-time.md steps 2-3 (Fix round 1: the wall-clock
// version of this test, scripts/lib/build-timings.test.mjs, failed on legitimate work -- any real
// source change makes `fixtures` compile for real, which is not the regression). Deterministic
// instead: read the actual cargo argument lists `exportBindings` (`packages/engine/src/
// build-game.ts`) and the `cargo-tests` build step (`./suites.mjs`) use, and assert they share
// package-selection scope. No cargo call, no timing, no flakiness -- the dirty reason
// (`CARGO_LOG=cargo::core::compiler::fingerprint=info`'s own `UnitDependencyInfoChanged` on a
// shared dependency's fingerprint) is about scope alone (`-p`/no-flag vs `--workspace`), not
// content or wall time, so this is exactly what has to stay true.
//
// Lives here (not beside build-game.ts, `../../../scripts/**` from `packages/engine/src/`) because
// this repo's `pnpm lint` tsc check is per-workspace-package (`pnpm -r run typecheck`); a plain
// `.mjs` importing another plain `.mjs` needs no ambient module declaration to satisfy it, and
// `scripts/` (root-level, no `package.json` of its own) is outside that check's scope entirely --
// the same reason every other `scripts/lib/*.test.mjs` file lives here. Imports `dist/build-game.js`
// (the built output), matching `packages/engine/scripts/build-fixtures.mjs`'s own convention of
// importing `dist/` rather than `src/`.
import { describe, expect, test } from 'vitest'
import { BINDINGS_CARGO_ARGS } from '../../packages/engine/dist/build-game.js'
import { buildSteps } from '../suites.mjs'

/** @param {string[]} args */
function packageSelectionFlags(args) {
  return args.filter((a) => a === '-p' || a === '--package' || a === '--workspace')
}

describe('exportBindings cargo args: workspace-scope regression', () => {
  test('exportBindings and the cargo-tests build step share --workspace, neither narrows with -p', () => {
    const cargoTests = buildSteps.find(
      (/** @type {{ name: string }} */ step) => step.name === 'cargo-tests',
    )
    if (!cargoTests) throw new Error('no "cargo-tests" step in scripts/suites.mjs')

    expect(packageSelectionFlags(BINDINGS_CARGO_ARGS)).toEqual(['--workspace'])
    expect(packageSelectionFlags(cargoTests.args)).toEqual(['--workspace'])
  })
})
