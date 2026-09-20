// `pnpm golden [fixture]`: the only writer of `fixtures/<name>/golden/golden.json`. It writes what
// the `.wasm` produces under Node, which docs/decisions/0002 makes authoritative (0020 §5); the
// native, Bun and browser legs are then compared with it. Rebuilds first, so the golden is never
// taken from a stale module. Review the diff: a changed golden is a changed sim.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolEnv } from '../../../scripts/lib/env.mjs'
import { instantiate } from '../dist/loader.js'
import { loadGame } from '../dist/server-node.js'
import { buildGame } from '../dist/vite.js'
import { roleOf, runHashScenario } from '../tests/support/scenario.ts'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const wanted = process.argv[2]
const names = readdirSync(fixtures).filter((name) =>
  existsSync(join(fixtures, name, 'golden', 'scenario.json')),
)
if (wanted !== undefined && !names.includes(wanted)) {
  console.log(`no fixture "${wanted}" with a golden/scenario.json; have: ${names.join(', ')}`)
  process.exit(2)
}

const written = []
for (const name of wanted === undefined ? names : [wanted]) {
  const golden = join(fixtures, name, 'golden')
  const scenario = JSON.parse(readFileSync(join(golden, 'scenario.json'), 'utf8'))
  const built = await buildGame({ crate: join(fixtures, name), profile: 'dev', env: toolEnv() })
  const { wasm } = await loadGame(built.dir)
  const inst = instantiate(wasm, roleOf(scenario), scenario.config, { onLog() {} })
  const checkpoints = runHashScenario(inst, scenario)
  const path = join(golden, 'golden.json')
  writeFileSync(path, `${JSON.stringify({ checkpoints }, null, 2)}\n`)
  written.push(path)
  console.log(`${name}: ${checkpoints.length} checkpoints, last ${checkpoints.at(-1)}`)
}

// `JSON.stringify(..., null, 2)` above disagrees with Biome's line-width-based array wrapping for
// a short `checkpoints` array (Biome collapses it to one line under `biome.json`'s `lineWidth`):
// without this, `pnpm golden <fixture> && git diff --exit-code` would show a formatting-only diff
// on every run for a fixture with few checkpoints, indistinguishable from a real golden change.
// Reformat in place so the file this script writes already matches what `pnpm format` would do.
if (written.length > 0) {
  spawnSync('pnpm', ['exec', 'biome', 'check', '--write', ...written], {
    stdio: 'inherit',
    env: toolEnv(),
  })
}
