// What `pnpm test` builds and runs. Every later milestone registers its work here and nowhere else.

// Edit → tests starting. Owner of the number: docs/decisions/0020 §3, docs/decisions/0033 §1
// (10,000, down from 30,000: M17d fixed two independent rebuild-ping-pong causes -- the
// fixtures/cargo-tests cargo package-selection scope mismatch, and plugin-dev.test.ts's own
// `utimes()` touch of a real fixture source file never being restored -- leaving a warm, no-change
// build at ~6.3-6.5 s repeatably, including immediately after the `browser` suite).
export const buildBudgetMs = 10_000

/**
 * Build steps run one after another, in order, before any suite (cargo steps would only queue on
 * the target-dir lock). A step is `{ name, cmd, args, cwd?, tiers? }`; `tiers` (default both) names the
 * tiers that run it (`buildStepsFor`).
 */
export const buildSteps = [
  { name: 'tsc', cmd: 'pnpm', args: ['--filter', 'engine', 'build'] },
  // `buildGame()` (from dist/, hence after tsc) on the dev profile for every fixture crate.
  { name: 'fixtures', cmd: 'node', args: ['packages/engine/scripts/build-fixtures.mjs'] },
  // Same, for every in-repo game's `sim/` crate (docs/plan/20-reference-game-v0.md, orchestrator
  // ruling): a dev-profile build the `wasm` suite's import-allowlist/target-features test can read,
  // independent of the `reference` step's own release-profile build below.
  { name: 'game-sims', cmd: 'node', args: ['scripts/build-game-sims-dev.mjs'] },
  { name: 'cargo-tests', cmd: 'cargo', args: ['nextest', 'run', '--workspace', '--no-run'] },
  // nextest runs no doc tests (docs/plan/12b-world-access-and-sim-driver.md Tests added): the
  // `compile_fail`/passing doc tests on `TickRate::hz` (0006) only run through this step.
  { name: 'doctests', cmd: 'cargo', args: ['test', '--doc', '-p', 'engine'] },
  // `vite build` of the fixture app on the dev profile (docs/plan/03-browser-harness.md, Planning
  // decisions "Served build, not dev server"); `browser`'s `webServer` only runs `vite preview`.
  {
    name: 'pages',
    cmd: 'pnpm',
    args: [
      'exec',
      'vite',
      'build',
      '--config',
      'packages/engine/tests/browser/pages/vite.config.ts',
    ],
  },
  // docs/plan/20-reference-game-v0.md: the `reference` Playwright project's own app (built, not
  // dev-served, same "Served build, not dev server" rule as `pages` above). `cwd` matters here (not
  // for `pages`, whose config sets `root` explicitly): `games/reference/vite.config.ts` has no
  // `root` override, so Vite defaults it to `process.cwd()` (Deviations).
  {
    name: 'reference',
    cmd: 'pnpm',
    // `--minify false`: software-mode zero-GC attribution needs real function names (M20b gate);
    // the game's own production build stays minified.
    args: ['exec', 'vite', 'build', '--minify', 'false'],
    cwd: 'games/reference',
  },
  // docs/plan/39f-device-auto-runner.md (orchestrator ruling after delegation 4): the reference game's
  // bench/check build (`dist-bench/` and the `release+bench` module), which only the slow tier's walk
  // browser specs serve. Without this step they built it on demand (`ensureBenchBuild`) beside running
  // tests, and the load made the first run flaky. Slow tier only: the fast tier never builds it.
  {
    name: 'reference-bench',
    cmd: 'pnpm',
    args: ['--filter', 'reference', 'build', '--mode', 'bench'],
    tiers: ['slow'],
  },
]

/** The build steps a tier runs, in order. */
export const buildStepsFor = (tier) => buildSteps.filter((s) => s.tiers?.includes(tier) ?? true)

/**
 * A suite is `{ name, kind, tiers, budgetMs, args?, cwd?, env?, legs?, solo? }`; `kind` names an
 * adapter in scripts/lib/adapters.mjs. `legs` are extra runs reported on the suite's line, each
 * `{ name, kind, ... }` with what its adapter needs, run concurrently with the suite's own main leg
 * (`runSuite`'s `Promise.all`), except a leg with `after: true`, which starts once all the others have finished. Ids follow the rows of the 0020 §3 table: `rust`, `unit`, `wasm`,
 * `netcode`, `browser`; `frame-bench` (docs/plan/
 * 17b-sprites-and-frame-budget.md, Fix round 2) is this repo's one addition outside that table, for
 * the reason its own entry below explains. `budgetMs` is the fast-tier budget; owner of the numbers:
 * docs/decisions/0020 §3. Slow-tier lines carry no budget. `solo: true` (`scripts/test.mjs`'s own
 * Phase 2): this suite runs alone, after every non-`solo` suite of the same tier has fully finished,
 * with no other suite's own Playwright/cargo/vitest process running concurrently -- for a suite
 * whose own numbers are only meaningful with the machine to itself (today: `frame-bench` alone).
 */
export const suites = [
  // `soloTiers: ['slow']` (M36): `slow_tick_large_save` and the other wall-clock benchmarks of the
  // `rust` slow tier gate on a median (0010 desktop proxy, 25 % rule); run beside `browser`'s Chromium
  // pool they measured 32 % over a baseline they hold alone. Same reason as `frame-bench`'s `solo`.
  { name: 'rust', kind: 'nextest', tiers: ['fast', 'slow'], budgetMs: 10_000, soloTiers: ['slow'] },
  { name: 'unit', kind: 'vitest', tiers: ['fast', 'slow'], budgetMs: 3_000, first: true },
  // M39x (docs/decisions/0054): the device-walk tool's tests (`scripts/lib/device-walk*.test.mjs`).
  { name: 'tools', kind: 'vitest', tiers: ['fast', 'slow'], budgetMs: 9_000 },
  {
    name: 'wasm',
    kind: 'vitest',
    tiers: ['fast', 'slow'],
    budgetMs: 7_000,
    legs: [
      {
        name: 'bun',
        kind: 'script',
        cmd: 'bun',
        args: ['packages/engine/tests/wasm/bun-leg.mjs'],
        tests: [
          'determinism: bun matches golden',
          'loader: views survive memory growth (bun)',
          'determinism: worldgen bun matches golden',
          'replay_world_checkpoints_bun',
          'reference_golden_replay (bun)',
          'reference_single_player_save_to_server (bun)',
          'reference_state_budget_full (bun)',
          'bun-adapter loopback',
        ],
      },
    ],
  },
  // docs/plan/27-server-entrypoint-and-netcode-harness.md: the real server entrypoint + real
  // `.wasm` + K `HeadlessClient`s over in-memory `Connection`s behind a seeded conditioner (0020
  // §7). `budgetMs` 10,000, this table's own row.
  //
  // `soloTiers: ['slow']` (M29b fix round 1: CI's slow tier, first run, found `ws/spike-c` failing
  // "engine: dispatch before ready" and `device-serve/proxy-and-apps` timing out at 60 s, alongside
  // *unrelated* `browser` slow-tier tests -- including a pre-existing page this milestone never
  // touched -- also newly timing out). The slow tier's own `ws/*` tests race a real loopback socket
  // handshake against a fixed real-wall-clock budget (`net-harness.ts`'s own `advanceTicks`, already
  // tuned upward once for exactly this reason: docs/plan/29-net-worker-and-reference-server.md
  // Deviations, "flaked under `pnpm test`'s own real concurrent-suite load"), and
  // `device-serve/proxy-and-apps` spawns two real `vite build`+`preview` cycles -- both are real
  // wall-clock-sensitive work that a concurrently-running `browser` suite's own Chromium/WebKit/
  // Firefox instances (plus M29's own new `burst` GC negative controls, deliberately CPU-heavy) can
  // starve of real CPU time, especially on CI's own weaker hardware (measured locally: this whole
  // suite's slow tier completes in 32 s alongside `browser`'s full slow tier on a 14-core machine,
  // comfortably under every timeout; a CI runner's own core count is far smaller). The fast tier
  // (4 s, no real spawns racing anything) stays concurrent -- only the slow tier needs the machine
  // to itself, the same reasoning `frame-bench` below already established for real-time measurement,
  // applied here to real-time *correctness* instead. This does not touch `browser`'s own internal
  // concurrency (5 workers, its own `engines` leg): removing `netcode`'s own contribution is what
  // this fix addresses; if CI's slow tier is still tight after this, that is `browser`'s own budget
  // to revisit, not `netcode`'s.
  //
  // `slowArgs: ['--no-file-parallelism']` (M29b fix round 2): `soloTiers` above removes contention
  // from *other* suites, but CI's slow tier still timed out `device-serve/proxy-and-apps` at 120 s
  // afterward -- `netcode`'s own slow tier still runs its five test files concurrently *within
  // itself* (Vitest's own default), so `reference-server/smoke`'s real server spawn, the `ws/*`
  // tests' real sockets and `device-serve/proxy-and-apps`'s own two real `vite build`+`preview`
  // cycles all still compete for CI's own real CPU at the same moment, one layer of contention
  // `soloTiers` never touched. Traced (not assumed): the actual per-test symptoms (a `strictPort`
  // Vite/`ws` bind conflict, or `device-serve.mjs`'s own teardown-ordering bug, both fixed
  // separately -- `device-serve.mjs`'s own Deviations, `device-serve-proxy-and-apps.test.ts`) would
  // fail *fast* with an explicit error, not hang for the full timeout; a genuine CPU-bound slowdown
  // under real contention is the shape that actually produces a silent timeout, which is what CI
  // reported. `--no-file-parallelism` (Vitest 5's own flag) makes this suite's own test files run
  // one at a time instead: more real wall time for the slow tier overall (no budget gates it,
  // `scripts/test.mjs`'s own `budgetMs = opts.tier === 'fast' ? ... : undefined`), far less peak
  // concurrent CPU demand from `netcode`'s own tests at any one moment. Fast tier (small, no real
  // spawns) is unaffected -- `suite.slowArgs` is tier-scoped the same way `soloTiers` is, appended
  // only when `tier === 'slow'` (`scripts/lib/adapters.mjs`'s own `vitest` adapter).
  {
    name: 'netcode',
    kind: 'vitest',
    tiers: ['fast', 'slow'],
    budgetMs: 10_000,
    soloTiers: ['slow'],
    slowArgs: ['--no-file-parallelism'],
  },
  {
    name: 'browser',
    kind: 'playwright',
    tiers: ['fast', 'slow'],
    // 60,000 (docs/decisions/0060 §1, Tyler's Q16 answer; 48,000 under 0036 §1, 35,000 before):
    // the demotion ladder (0020 §4) is exhausted, so the fast tier is about 70 s with the 10 s build.
    budgetMs: 60_000,
    // `chromium` + `gc` in every tier (0020 §4, first rung: gate round 3, docs/plan/
    // 09-renderer-terrain.md Deviations). WebKit and Firefox move to the `engines` leg below.
    // `reference` (docs/plan/20-reference-game-v0.md): `games/reference`'s own project, same leg
    // (its own `testDir` and `webServer` entry keep it from ever running the other projects' specs
    // or vice versa) -- a separate leg would need its own port for the *pages* server too, since a
    // leg's own `playwright test` process starts every configured `webServer` regardless of
    // `--project` (Deviations).
    args: [
      '--project',
      'chromium',
      '--project',
      'gc',
      '--project',
      'reference',
      // docs/plan/20b-reference-player-and-collect-ui.md: the reference game's own zero-allocation
      // page, same leg (same shared webServer as `reference`, `playwright.config.ts`'s own
      // Deviations comment for that project).
      '--project',
      'gc-reference',
    ],
    legs: [
      {
        name: 'engines',
        kind: 'playwright',
        onlyTier: 'slow',
        noSlowTag: true,
        args: ['--project', 'webkit', '--project', 'firefox'],
        // Its own `vite preview` (port), distinct from the main leg's, which runs concurrently
        // (`runSuite`'s `Promise.all`): both are separate `playwright test` processes against the
        // same config, and `ENGINE_TEST_PORT` is what tells the config's own `webServer` which port
        // to bind (playwright.config.ts, tests/browser/pages/vite.config.ts).
        port: 4518,
      },
      {
        // The heavy packaging specs (`tarball-install`, `dev-reload`: an install and a cargo build
        // each) run `after` the main leg and the `engines` leg, never beside the `gc` projects: run
        // concurrently they pushed `connected-terrain neg burst sim` over its 90 s timeout on CI (M37
        // Deviations). Same default port as the main leg: nothing else runs then.
        name: 'packaging',
        kind: 'playwright',
        onlyTier: 'slow',
        after: true,
        args: ['--project', 'packaging'],
      },
    ],
  },
  {
    // docs/plan/17b-sprites-and-frame-budget.md, steps 4-6 + Fix round 2: `bench.frame_worstcase`,
    // the one real-rAF frame-time benchmark, in its own top-level suite rather than a `browser` leg
    // -- `runSuite`'s own `Promise.all` runs every leg of one suite concurrently, and a frame-time
    // gate cannot share the machine with the rest of the slow tier's Playwright worker pool
    // (`browser`'s own `workers: 5`, zero-GC `burst` negative controls included: they exist to burn
    // CPU). `solo: true` (below) makes `scripts/test.mjs` run this suite by itself, after every
    // concurrent suite -- `browser` included -- has finished, so nothing else is asking Chromium or
    // the CPU for anything while it measures. Its own project (`playwright.config.ts`'s own
    // `--disable-frame-rate-limit --disable-gpu-vsync` launch flags) keeps the `chromium`/`gc`
    // projects' own tests unaffected by uncapped rAF pacing either way. `pnpm bench:frame` (root
    // package.json) runs the identical `--project frame-bench` command directly, for a human
    // reading its printed table without the rest of the slow tier.
    name: 'frame-bench',
    kind: 'playwright',
    tiers: ['slow'],
    solo: true,
    args: ['--project', 'frame-bench'],
    port: 4519,
  },
]
