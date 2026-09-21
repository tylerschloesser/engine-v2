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

// M10 (docs/plan/10-ci-workflow.md; docs/decisions/0020-testing-strategy.md §6): unset locally,
// `channel: 'chromium'` gives a real Metal adapter headless and `--enable-unsafe-webgpu` alone is
// enough. CI (`ubuntu-latest`) sets `ENGINE_GPU=swiftshader`, which adds the flags a software
// WebGPU adapter needs; `libvulkan1`/`mesa-vulkan-drivers` are the matching apt packages (ci.yml).
const swiftshaderArgs =
  process.env.ENGINE_GPU === 'swiftshader'
    ? [
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--use-vulkan=swiftshader',
        '--use-webgpu-adapter=swiftshader',
        '--disable-vulkan-surface',
      ]
    : []

// Spike B fallback rung 1 (docs/plan/10-ci-workflow.md "Fallbacks if SwiftShader fails"; first CI
// run, M10 Deviations): `channel: 'chromium'` (new headless mode: playwright-core's own
// `LaunchOptions.channel` doc comment, `'"chromium"' to opt in to new headless mode`) returned a
// null adapter on ubuntu-latest even with the flags above. `channel: 'chromium-headless-shell'` is
// a *separate*, non-aliased executable (playwright-core@1.63.0 lib/coreBundle.js:
// `chromiumAliases = ['chrome-for-testing']` does not include it; `registry.getExecutableName`
// passes an explicit non-alias channel straight through as the binary name) -- the "old shell" the
// spike used locally (`spikes/zero-gc-webgpu/playwright.config.mjs`: `CHANNEL=shell -> old headless
// shell, which with --enable-unsafe-webgpu yields the SwiftShader adapter`, confirmed in
// `RESULT.md`: `vendor: google, architecture: swiftshader, isFallbackAdapter: true`, even on
// macOS, because the shell binary has no real-GPU path at all and always falls back to software
// rendering). Installed already: a bare `playwright install chromium` installs both `chromium` and
// `chromium-headless-shell` (`registry.resolveBrowsers`'s `chromium` branch installs both unless
// `--only-shell`/`--no-shell` is passed; `ci.yml` passes neither).
const chromiumChannel =
  process.env.ENGINE_GPU === 'swiftshader' ? 'chromium-headless-shell' : 'chromium'

// docs/plan/10-ci-workflow.md, Deviations: `[webkit] terrain: probe tile colours webkit
// @webkit-gpu @slow` failed on ubuntu-latest with `navigator.gpu is not present` -- WebKitGTK,
// what Playwright ships on Linux, has no WebGPU at all (a platform capability fact, not a
// software-adapter question any flag fixes). `@webkit-gpu` therefore runs only off Linux, where
// WebKit does have a real headless WebGPU adapter (0018 §7's own support table); `@engines` (sim
// hash, no GPU) still runs everywhere, which is what proved three-browser determinism on this
// same runner. The exclusion is asserted against the platform, not discovered by the test itself
// finding `navigator.gpu` missing -- that would make the test unable to fail and silently stop
// covering macOS the day WebGPU broke there.
const webkitGrep = process.platform === 'linux' ? /@engines/ : /@engines|@webkit-gpu/

// docs/plan/10-ci-workflow.md, Deviations: the `gc` project's own `burst` negative controls
// (40 KB/frame, real GC work over 0028's two 600-frame windows) needed up to 29.9 s just to PASS
// on the CI runner, and one timed out at 30.655 s against the local 30 s default -- measured from
// run 35619437805's own `report.json` per-test durations (`echo`/`terrain neg burst main` both
// 29,893 ms; `echo neg burst client` `timedOut` at 30,655 ms). ADR 0020 §10's "wall clock
// recorded, never gating in CI" already covers `--budget-scale`; a per-test timeout is the same
// kind of gate living in Playwright's own config instead of the runner, so it scales the same way
// -- CI only (`ENGINE_GPU=swiftshader`), never locally, where a genuine hang must still fail fast.
// 90 s: roughly 3x the worst *passing* CI duration (29.9 s), well above the timed-out test's own
// likely true duration (its siblings, same page, same conditions, topped out at 29.9 s; a page
// with no WebGPU at all has no reason to need dramatically more).
const gcTimeoutMs = process.env.ENGINE_GPU === 'swiftshader' ? 90_000 : 30_000

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
        // Real Metal adapter headless on macOS; CI swaps to the headless-shell channel (above).
        channel: chromiumChannel,
        launchOptions: { args: ['--enable-unsafe-webgpu', ...swiftshaderArgs] },
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
      grep: webkitGrep,
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
        channel: chromiumChannel,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            ...swiftshaderArgs,
            '--disable-features=SpareRendererForSitePerProcess',
            '--js-flags=--expose-gc --sampling-heap-profiler-suppress-randomness',
            `--remote-debugging-port=${cdpPort}`,
          ],
        },
      },
      testMatch: '**/gc-*.spec.ts',
      timeout: gcTimeoutMs,
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
