// `browser` suite (docs/decisions/0020 §1, §3, §6; docs/plan/03-browser-harness.md, Planning
// decisions "Browsers and projects"). `pnpm test`'s `pages` build step has already run `vite build`
// on `tests/browser/pages`; `webServer` only runs `vite preview` (Planning decisions, "Served build,
// not dev server").
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.ENGINE_TEST_PORT ?? 4517)
const baseURL = `http://127.0.0.1:${port}`

// M04: base port for the `gc` project's `flat` CDP transport (docs/plan/04-zero-gc-harness.md,
// Planning decisions "CDP transport"); `TEST_PARALLEL_INDEX` is set per worker process by
// Playwright itself, so two workers of one run (and, with distinct `ENGINE_CDP_PORT`s, two
// worktrees) never collide.
const cdpPort =
  Number(process.env.ENGINE_CDP_PORT ?? 9333) + Number(process.env.TEST_PARALLEL_INDEX ?? 0)

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
      // M04's gc-*.spec.ts run only in the `gc` project below, under `pnpm gc`, never `pnpm test`.
      testIgnore: '**/gc-*.spec.ts',
    },
    {
      // Sim hash only (0020 §6: Firefox returns a null WebGPU adapter headless); multi-engine repeats
      // stay to the determinism spec (`@engines`; Planning decisions, "Browsers and projects").
      // `@webkit-gpu` (docs/plan/09-renderer-terrain.md, Tests added "`@slow`: `terrain.
      // probe_tile_colours` on Playwright WebKit"): WebKit, unlike Firefox, does give a real WebGPU
      // adapter headless (0018 §7's own support table), so this one extra tag lets a GPU test opt
      // into WebKit without also being picked up by Firefox's `@engines`-only grep below -- a plain
      // `@engines` tag on a GPU test would fail there on a null adapter.
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      grep: /@engines|@webkit-gpu/,
      testIgnore: '**/gc-*.spec.ts',
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /@engines/,
      testIgnore: '**/gc-*.spec.ts',
    },
    {
      // docs/plan/04-zero-gc-harness.md, Seams: the zero-GC assertion of 0016 §3. Launch args:
      // 0016 §3, plus a `--remote-debugging-port` (unused under the default `tunnel` transport) so
      // `pnpm gc flat`/the flat-transport parity test can reach this same browser.
      name: 'gc',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--disable-features=SpareRendererForSitePerProcess',
            '--js-flags=--expose-gc --sampling-heap-profiler-suppress-randomness',
            `--remote-debugging-port=${cdpPort}`,
          ],
        },
      },
      testMatch: '**/gc-*.spec.ts',
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
