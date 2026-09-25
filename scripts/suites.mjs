// What `pnpm test` builds and runs. Every later milestone registers its work here and nowhere else.

// Edit → tests starting. Owner of the number: docs/decisions/0020 §3, docs/decisions/0033 §1
// (10,000, down from 30,000: M17d fixed two independent rebuild-ping-pong causes -- the
// fixtures/cargo-tests cargo package-selection scope mismatch, and plugin-dev.test.ts's own
// `utimes()` touch of a real fixture source file never being restored -- leaving a warm, no-change
// build at ~6.3-6.5 s repeatably, including immediately after the `browser` suite).
export const buildBudgetMs = 10_000

/**
 * Build steps run one after another, in order, before any suite (cargo steps would only queue on
 * the target-dir lock). A step is `{ name, cmd, args, cwd? }`.
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
    args: ['exec', 'vite', 'build'],
    cwd: 'games/reference',
  },
]

/**
 * A suite is `{ name, kind, tiers, budgetMs, args?, cwd?, env?, legs?, solo? }`; `kind` names an
 * adapter in scripts/lib/adapters.mjs. `legs` are extra runs reported on the suite's line, each
 * `{ name, kind, ... }` with what its adapter needs, run concurrently with the suite's own main leg
 * (`runSuite`'s `Promise.all`). Ids follow the rows of the 0020 §3 table: `rust`, `unit`, `wasm`,
 * `browser`, and reserved for a later milestone `netcode`; `frame-bench` (docs/plan/
 * 17b-sprites-and-frame-budget.md, Fix round 2) is this repo's one addition outside that table, for
 * the reason its own entry below explains. `budgetMs` is the fast-tier budget; owner of the numbers:
 * docs/decisions/0020 §3. Slow-tier lines carry no budget. `solo: true` (`scripts/test.mjs`'s own
 * Phase 2): this suite runs alone, after every non-`solo` suite of the same tier has fully finished,
 * with no other suite's own Playwright/cargo/vitest process running concurrently -- for a suite
 * whose own numbers are only meaningful with the machine to itself (today: `frame-bench` alone).
 */
export const suites = [
  { name: 'rust', kind: 'nextest', tiers: ['fast', 'slow'], budgetMs: 10_000 },
  { name: 'unit', kind: 'vitest', tiers: ['fast', 'slow'], budgetMs: 3_000 },
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
        ],
      },
    ],
  },
  {
    name: 'browser',
    kind: 'playwright',
    tiers: ['fast', 'slow'],
    // 35,000, up from 25,000 (docs/decisions/0033 §2): the build fix freed room under Tyler's
    // one-minute wall time (docs/spec/testing.md) for M18+'s own fast browser tests, on the suite
    // that was always the fast tier's real bottleneck (measured 23-24 s quiet, 29 s under load).
    budgetMs: 35_000,
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
