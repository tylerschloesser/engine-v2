import { defineConfig } from 'vitest/config'

// One project per Vitest-run suite of scripts/suites.mjs; the project name is the suite id.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'scripts/**/*.test.mjs',
            // M04: pure CDP-analysis and budgets-file logic, unit-testable without a browser.
            'packages/engine/tests/browser/gc/*.test.ts',
            'packages/engine/tests/support/*.test.ts',
            // docs/plan/20-reference-game-v0.md: `games/reference`'s own unit tests (the asset
            // script's reproducibility, package/bindings hygiene), same two glob shapes as above.
            'games/*/src/**/*.test.ts',
            'games/*/scripts/**/*.test.mjs',
          ],
        },
      },
      {
        test: {
          name: 'wasm',
          environment: 'node',
          include: ['packages/engine/tests/wasm/**/*.test.ts'],
        },
      },
    ],
  },
})
