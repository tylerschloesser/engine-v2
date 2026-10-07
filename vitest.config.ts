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
          // M39x: the device-walk tool's tests run in the `tools` project below.
          exclude: ['**/node_modules/**', 'scripts/lib/device-walk*.test.mjs'],
        },
      },
      {
        // M39x (ADR 0054): Mac-side tooling tests kept out of the first, fast `unit` suite.
        test: {
          name: 'tools',
          environment: 'node',
          include: ['scripts/lib/device-walk*.test.mjs'],
        },
      },
      {
        test: {
          name: 'wasm',
          environment: 'node',
          include: ['packages/engine/tests/wasm/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'netcode',
          environment: 'node',
          include: [
            'packages/engine/tests/netcode/**/*.test.ts',
            // docs/plan/34c-reference-scripted-multiplayer.md: the reference game's scripted multiplayer.
            'games/reference/tests/netcode/**/*.test.ts',
          ],
        },
      },
    ],
  },
})
