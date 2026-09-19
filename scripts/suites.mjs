// What `pnpm test` builds and runs. Every later milestone registers its work here and nowhere else.

// Edit → tests starting. Owner of the number: docs/decisions/0020 §3.
export const buildBudgetMs = 30_000

/**
 * Build steps run one after another, in order, before any suite (cargo steps would only queue on
 * the target-dir lock). A step is `{ name, cmd, args, cwd? }`.
 */
export const buildSteps = [
  { name: 'tsc', cmd: 'pnpm', args: ['--filter', 'engine', 'build'] },
  { name: 'cargo-tests', cmd: 'cargo', args: ['nextest', 'run', '--workspace', '--no-run'] },
]

/**
 * A suite is `{ name, kind, tiers, budgetMs, args?, cwd?, env? }`; `kind` names an adapter in
 * scripts/lib/adapters.mjs. Ids follow the rows of the 0020 §3 table: `rust`, `unit`, and reserved
 * for later milestones `wasm`, `netcode`, `browser`. `budgetMs` is the fast-tier budget; owner of
 * the numbers: docs/decisions/0020 §3. Slow-tier lines carry no budget.
 */
export const suites = [
  { name: 'rust', kind: 'nextest', tiers: ['fast', 'slow'], budgetMs: 10_000 },
  { name: 'unit', kind: 'vitest', tiers: ['fast', 'slow'], budgetMs: 3_000 },
]
