import { defineConfig } from 'vitest/config'

// One project per Vitest-run suite of scripts/suites.mjs; the project name is the suite id.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
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
