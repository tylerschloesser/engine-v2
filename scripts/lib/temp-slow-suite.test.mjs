// TEMPORARY (docs/plan/10-ci-workflow.md, exit criterion "a deliberately slow suite does not fail
// the job, checked once with a sleep, then reverted"): pushes the `unit` suite's own unscaled 3 s
// budget (scripts/suites.mjs) well past it, but nowhere near its `--budget-scale 1000`-scaled
// 3,000 s, so a real CI run (`pnpm test --budget-scale 1000 ...`, exactly what `ci.yml`'s own
// `pnpm test` step runs) can prove end to end that CI's job does not fail on it. Committed, pushed,
// read, then reverted in the very next commit -- never meant to stay.
import { test } from 'vitest'

test('M10 temporary: deliberately over the unit suite budget', async () => {
  // 4.7 s: comfortably over unit's own unscaled 4.5 s fail threshold (1.5x of 3 s, 0020 §2), but
  // under Vitest's own default 5 s per-test timeout, so this sleep is what's measured, not a
  // spurious test-level timeout failure.
  await new Promise((resolve) => setTimeout(resolve, 4700))
})
