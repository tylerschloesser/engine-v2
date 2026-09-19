import { expect, test } from 'vitest'

// Permanent negative control for the Vitest adapter: `pnpm test --self-check-fail` sets
// RUNNER_SELF_CHECK=fail in every child, and the runner must then report this test as a failure.
test('runner_negative_control', () => {
  expect(process.env.RUNNER_SELF_CHECK, 'runner self-check: deliberate failure').not.toBe('fail')
})
