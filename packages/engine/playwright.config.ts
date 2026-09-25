// `browser` suite (docs/decisions/0020 §1, §3, §6; docs/plan/03-browser-harness.md, Planning
// decisions "Browsers and projects"). `pnpm test`'s `pages` build step has already run `vite build`
// on `tests/browser/pages`; `webServer` only runs `vite preview` (Planning decisions, "Served build,
// not dev server").
import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.ENGINE_TEST_PORT ?? 4517)
const baseURL = `http://127.0.0.1:${port}`

// docs/plan/20-reference-game-v0.md, Deviations: `games/reference`'s own browser tests reach the
// `browser` suite through a second project (`reference`, below) and a second `webServer` entry
// here, rather than a new top-level suite or a separate `playwright.config.ts` -- the `playwright`
// adapter (`scripts/lib/adapters.mjs`) hardcodes this one config file for every playwright-kind
// suite/leg, so a project + `testDir` override is the only way in without touching that adapter.
//
// Gate round 1 fix: was a fixed `4520`, on the (wrong) assumption that a wholly separate Vite app
// would never run concurrently with another leg's own copy of this same config. `webServer` is
// config-level, not project-scoped, so *every* `playwright test` invocation of this file starts
// *every* entry regardless of `--project` (this file's own `reference` project comment already
// says as much for the *pages* server) -- `pnpm test:slow browser`'s `engines` leg (webkit+firefox,
// its own `ENGINE_TEST_PORT`, `scripts/suites.mjs`) runs concurrently with the main leg and tried
// to bind this same fixed port a second time, crashing with `EADDRINUSE` (found live: `engines.log`
// -- `Error: Port 4520 is already in use` / `Process from config.webServer was not able to start.
// Exit code: 1`). Derived from `port` the same way the *pages* server already is (`ENGINE_TEST_PORT`,
// default 4517, so this stays `4520` for that default -- no behaviour change for a single leg),
// giving every leg its own distinct pair of ports instead of a shared one no leg's process
// coordinates over.
const referencePort = port + 3
const referenceBaseURL = `http://127.0.0.1:${referencePort}`

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
  // One browser per Playwright worker. 5, not the original 3 (docs/decisions/
  // 0031-browser-suite-five-workers.md): measured faster both quiet and under `--load 10` on
  // Tyler's 14-logical-CPU Mac, with no new failure or `parkWorkers` timeout in 32 runs.
  workers: 5,
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
      // `frame-bench.spec.ts` runs only in the `frame-bench` project below (its own launch flags,
      // `--disable-frame-rate-limit --disable-gpu-vsync`): otherwise this project's own slow-tier
      // grep (`(?=.*@slow)`) would also pick up `bench.frame_worstcase @slow` and run it a second
      // time, without those flags, under real (capped) rAF pacing.
      testIgnore: ['**/gc-*.spec.ts', '**/frame-bench.spec.ts'],
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
      // docs/plan/17b-sprites-and-frame-budget.md, steps 4-6: `bench.frame_worstcase` alone, real
      // `requestAnimationFrame` pacing (0020 §3's "browser tests never use real rAF pacing" rule is
      // about lockstep determinism tests; this one exists specifically to measure real frame
      // pacing, `device.html`'s own precedent). `--disable-frame-rate-limit --disable-gpu-vsync`
      // (the spike's own flags, `spikes/zero-gc-webgpu/RESULT.md`: "600 frames in 93 ms" with them)
      // are scoped to this project alone, not `chromium`/`gc`, so no other real-rAF-driven test
      // (none exist yet) is affected by uncapped pacing.
      name: 'frame-bench',
      use: {
        ...devices['Desktop Chrome'],
        channel: chromiumChannel,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            ...swiftshaderArgs,
            '--disable-frame-rate-limit',
            '--disable-gpu-vsync',
          ],
        },
      },
      testMatch: '**/frame-bench.spec.ts',
      // 512 one-time setup dispatches (`frame-bench.ts`'s own batched `SpawnMany` population, well
      // over the `chromium` project's own default page's worth of setup work) plus 420 real rAF
      // frames comfortably exceed the config's own 30 s default.
      timeout: 120_000,
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
      // `gc-reference.spec.ts` runs only in the `gc-reference` project below, against the
      // `reference` app's own preview server, not this project's default one.
      testMatch: '**/gc-*.spec.ts',
      testIgnore: ['**/gc-reference.spec.ts'],
      timeout: gcTimeoutMs,
    },
    {
      // docs/plan/20-reference-game-v0.md: `games/reference`'s own browser tests (`terrain.spec.ts`
      // today), a wholly separate Vite app served by the second `webServer` entry below. `testDir`
      // override (relative to this file, `packages/engine/`) is what keeps this project from ever
      // seeing the other projects' specs and vice versa.
      name: 'reference',
      testDir: '../../games/reference/tests/browser',
      use: {
        ...devices['Desktop Chrome'],
        channel: chromiumChannel,
        launchOptions: { args: ['--enable-unsafe-webgpu', ...swiftshaderArgs] },
        baseURL: referenceBaseURL,
      },
    },
    {
      // docs/plan/20b-reference-player-and-collect-ui.md, zero-allocation exit criterion (step 0-2
      // Deviations: "a new project mirroring the existing `reference` project's own pattern ...
      // and the `gc` project's own launch args/`testMatch`/timeout"). Its own *spec file*
      // (`gc-reference.spec.ts`) lives under this package's own `tests/browser/`, not under
      // `games/reference/tests/`, unlike `reference`'s own project above: `games/reference/CLAUDE.md`
      // forbids that package's own tests from importing `packages/engine/tests/**` (even in its own
      // `tests/`), and `zeroGcSuite`/`gc/suite.ts` -- the one mechanism a zero-GC page registers
      // through -- is exactly such an import. `testDir` therefore stays this file's own default;
      // only `baseURL` points at the reference app's own preview server (`games/reference/
      // vite.config.ts`'s `gc.html` entry, served by the `reference` project's own `webServer`
      // entry below -- one Vite app, no new server). `gc`'s own launch flags/timeout (0016 §3) are
      // what any zero-GC page needs, regardless of which app it belongs to.
      name: 'gc-reference',
      use: {
        ...devices['Desktop Chrome'],
        channel: chromiumChannel,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            ...swiftshaderArgs,
            '--disable-features=SpareRendererForSitePerProcess',
            '--js-flags=--expose-gc --sampling-heap-profiler-suppress-randomness',
            `--remote-debugging-port=${cdpPort + 1}`,
          ],
        },
        baseURL: referenceBaseURL,
      },
      testMatch: '**/gc-reference*.spec.ts',
      timeout: gcTimeoutMs,
    },
  ],
  webServer: [
    {
      // `--host 127.0.0.1`: Vite's default preview host resolves to `localhost`, which binds ::1
      // only on this machine (measured: 127.0.0.1 then refuses the connection); `baseURL` above is
      // literal.
      command: `pnpm exec vite preview --config tests/browser/pages/vite.config.ts --host 127.0.0.1`,
      cwd: import.meta.dirname,
      url: `${baseURL}/index.html`,
      reuseExistingServer: true,
    },
    {
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${referencePort} --strictPort`,
      cwd: resolve(import.meta.dirname, '../../games/reference'),
      url: `${referenceBaseURL}/index.html`,
      reuseExistingServer: true,
    },
  ],
})
