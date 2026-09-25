// Build step `game-sims` of `pnpm test` (scripts/suites.mjs), after `tsc`: `buildGame()` on the dev
// profile for every in-repo game's `sim/` crate (`games/<name>/sim/`), mirroring `packages/engine/
// scripts/build-fixtures.mjs` for fixtures. Needed because the `reference` build step (below it in
// `buildSteps`) runs a plain `vite build`, which defaults to the *release* profile -- release
// strips the `target_features` custom section the `wasm` suite's "target features" test reads
// (docs/plan/20-reference-game-v0.md, orchestrator ruling: "the M02 import-allowlist test and
// clippy bans run against reference-sim"), so that test needs its own guaranteed-fresh dev build,
// not the browser suite's release one. No bindings step here: a game's own `vite.config.ts` already
// wires that (0017 §5), and running it a second time from this script would just race the same
// `cargo test export_bindings` invocation for no reason.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGame } from '../packages/engine/dist/vite.js'

const gamesRoot = fileURLToPath(new URL('../games/', import.meta.url))

if (existsSync(gamesRoot)) {
  for (const entry of readdirSync(gamesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const crate = join(gamesRoot, entry.name, 'sim')
    if (!existsSync(crate)) continue
    const built = await buildGame({ crate, profile: 'dev' })
    console.log(
      `${entry.name}/sim ${built.buildHash.slice(0, 16)} cargo ${Math.round(built.cargoMs)}ms`,
    )
  }
}
