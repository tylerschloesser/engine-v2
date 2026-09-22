// Build step `fixtures` of `pnpm test` (scripts/suites.mjs), after `tsc`: `buildGame()` on the dev
// profile for every fixture crate. The caller's environment is cargo's (the runner passes
// `toolEnv()`). Prints one line per fixture to the build log.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toolEnv } from '../../../scripts/lib/env.mjs'
import { buildGame } from '../dist/vite.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

// docs/plan/16-action-round-trip.md step 4: only `fx-puts` has a `#[ts(export)]` type today
// (`Action`/`Reject`/`Pos`, plus `engine::sim::EngineReject` by its own hand-written test) --
// every other fixture would pay a second native `cargo test` compile for zero matching tests, so
// the bindings step is opt-in per fixture name rather than run unconditionally.
const BINDINGS_FIXTURES = new Set(['puts'])

const bindingsDirs = []
for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const bindings = BINDINGS_FIXTURES.has(entry.name) ? { dir: 'bindings' } : undefined
  const built = await buildGame({
    crate: `${fixtures}${entry.name}`,
    profile: 'dev',
    ...(bindings ? { bindings } : {}),
  })
  if (bindings) bindingsDirs.push(`${fixtures}${entry.name}/${bindings.dir}`)
  const bindingsPart =
    built.bindingsMs !== undefined ? ` bindings ${Math.round(built.bindingsMs)}ms` : ''
  console.log(
    `${entry.name} ${built.buildHash.slice(0, 16)} cargo ${Math.round(built.cargoMs)}ms${bindingsPart}`,
  )
}

// ts-rs's own quote/semicolon/trailing-comma style disagrees with Biome's (`golden.mjs`'s own
// "reformat in place" comment has the same reasoning for its own written files): every `pnpm test`
// run's own `fixtures` build step regenerates `bindings/*.ts` fresh, so without this, `pnpm test &&
// git diff --exit-code` would show a formatting-only diff on every single run, indistinguishable
// from a real bindings change.
if (bindingsDirs.length > 0) {
  spawnSync('pnpm', ['exec', 'biome', 'check', '--write', ...bindingsDirs], {
    stdio: 'inherit',
    env: toolEnv(),
  })
}
