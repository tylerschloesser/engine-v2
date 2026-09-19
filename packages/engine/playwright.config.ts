// `browser` suite (docs/decisions/0020 §1, §3, §6; docs/plan/03-browser-harness.md, Planning
// decisions "Browsers and projects"). `pnpm test`'s `pages` build step has already run `vite build`
// on `tests/browser/pages`; `webServer` only runs `vite preview` (Planning decisions, "Served build,
// not dev server").
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.ENGINE_TEST_PORT ?? 4517)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests/browser',
  // Default matches `*.test.ts` too (M04's `gc/analyse.test.ts` is a Vitest unit test, run by the
  // `unit` suite instead: vitest.config.ts).
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // One browser per Playwright worker (Planning decisions).
  workers: 3,
  reporter: [['json', { outputFile: 'test-results/browser/report.json' }]],
  timeout: 30_000,
  use: { baseURL },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Real Metal adapter headless on macOS; the same flag serves Linux SwiftShader (0020 §6).
        channel: 'chromium',
        launchOptions: { args: ['--enable-unsafe-webgpu'] },
      },
    },
    {
      // Sim hash only (0020 §6: Firefox returns a null WebGPU adapter headless); multi-engine repeats
      // stay to the determinism spec (`@engines`; Planning decisions, "Browsers and projects").
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      grep: /@engines/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /@engines/,
    },
  ],
  webServer: {
    // `--host 127.0.0.1`: Vite's default preview host resolves to `localhost`, which binds ::1 only
    // on this machine (measured: 127.0.0.1 then refuses the connection); `baseURL` above is literal.
    command: `pnpm exec vite preview --config tests/browser/pages/vite.config.ts --host 127.0.0.1`,
    cwd: import.meta.dirname,
    url: `${baseURL}/index.html`,
    reuseExistingServer: true,
  },
})
