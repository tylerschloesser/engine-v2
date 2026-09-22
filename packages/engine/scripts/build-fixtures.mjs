// Build step `fixtures` of `pnpm test` (scripts/suites.mjs), after `tsc`: `buildGame()` on the dev
// profile for every fixture crate. The caller's environment is cargo's (the runner passes
// `toolEnv()`). Prints one line per fixture to the build log.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildGame } from '../dist/vite.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

// docs/plan/16-action-round-trip.md step 4: only `fx-puts` has a `#[ts(export)]` type today
// (`Action`/`Reject`/`Pos`, plus `engine::sim::EngineReject` by its own hand-written test) --
// every other fixture would pay a second native `cargo test` compile for zero matching tests, so
// the bindings step is opt-in per fixture name rather than run unconditionally.
const BINDINGS_FIXTURES = new Set(['puts'])

for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const bindings = BINDINGS_FIXTURES.has(entry.name) ? { dir: 'bindings' } : undefined
  const built = await buildGame({
    crate: `${fixtures}${entry.name}`,
    profile: 'dev',
    ...(bindings ? { bindings } : {}),
  })
  const bindingsPart =
    built.bindingsMs !== undefined ? ` bindings ${Math.round(built.bindingsMs)}ms` : ''
  console.log(
    `${entry.name} ${built.buildHash.slice(0, 16)} cargo ${Math.round(built.cargoMs)}ms${bindingsPart}`,
  )
}
