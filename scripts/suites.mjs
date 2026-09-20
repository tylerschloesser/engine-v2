// What `pnpm test` builds and runs. Every later milestone registers its work here and nowhere else.

// Edit → tests starting. Owner of the number: docs/decisions/0020 §3.
export const buildBudgetMs = 30_000

/**
 * Build steps run one after another, in order, before any suite (cargo steps would only queue on
 * the target-dir lock). A step is `{ name, cmd, args, cwd? }`.
 */
export const buildSteps = [
  { name: 'tsc', cmd: 'pnpm', args: ['--filter', 'engine', 'build'] },
  // `buildGame()` (from dist/, hence after tsc) on the dev profile for every fixture crate.
  { name: 'fixtures', cmd: 'node', args: ['packages/engine/scripts/build-fixtures.mjs'] },
  { name: 'cargo-tests', cmd: 'cargo', args: ['nextest', 'run', '--workspace', '--no-run'] },
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
]

/**
 * A suite is `{ name, kind, tiers, budgetMs, args?, cwd?, env?, legs? }`; `kind` names an adapter in
 * scripts/lib/adapters.mjs. `legs` are extra runs reported on the suite's line, each
 * `{ name, kind, ... }` with what its adapter needs. Ids follow the rows of the 0020 §3 table:
 * `rust`, `unit`, `wasm`, `browser`, and reserved for a later milestone `netcode`. `budgetMs` is the
 * fast-tier budget; owner of the numbers: docs/decisions/0020 §3. Slow-tier lines carry no budget.
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
  { name: 'browser', kind: 'playwright', tiers: ['fast', 'slow'], budgetMs: 25_000 },
]
