// Build step `fixtures` of `pnpm test` (scripts/suites.mjs), after `tsc`: `buildGame()` on the dev
// profile for every fixture crate. The caller's environment is cargo's (the runner passes
// `toolEnv()`). Prints one line per fixture to the build log.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildGame } from '../dist/vite.js'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const built = await buildGame({ crate: `${fixtures}${entry.name}`, profile: 'dev' })
  console.log(`${entry.name} ${built.buildHash.slice(0, 16)} cargo ${Math.round(built.cargoMs)}ms`)
}
