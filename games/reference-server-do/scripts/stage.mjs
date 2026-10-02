// `node scripts/stage.mjs <payload> [--arena-mib N] [--scale N]` fills `.stage/` with what `wrangler`
// bundles: `game.wasm`, `game.json`, `payload.json` (`{ name, params, arenaBytes? }`).
// Payloads: `puts` (the `puts` fixture, dev profile: the smoke), `reference` (the reference game's
// release build and `world.json`), `bench` (the reference game's `bench` release build, genesis
// `{ bench: scale }`, scale 1 = the 0020 section 9 save). The `.wasm` is copied out of its `target/`
// directory (other tests delete those) and refused unless sha256 == buildHash.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = fileURLToPath(new URL('..', import.meta.url))
const repo = join(here, '..', '..')
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'arena-mib': { type: 'string' }, scale: { type: 'string', default: '1' } },
})
const name = positionals[0]
const scale = Number(values.scale)
const sources = {
  puts: {
    dir: join(repo, 'packages/engine/fixtures/puts/target/engine/dev'),
    params: { seed: '1', worldgen: null },
  },
  reference: {
    dir: join(repo, 'games/reference/sim/target/engine/release'),
    params: JSON.parse(readFileSync(join(repo, 'games/reference/world.json'), 'utf8')),
  },
  bench: {
    dir: join(repo, 'games/reference/sim/target/engine/release+bench'),
    params: {
      seed: '6840143426475589698',
      worldgen: { bench: scale },
      maxEntities: Math.floor(262_144 / scale),
      maxModifiedTiles: Math.floor(1_048_576 / scale),
    },
  },
}
const src = sources[name]
if (!src) {
  console.error(`usage: stage.mjs <${Object.keys(sources).join('|')}> [--arena-mib N] [--scale N]`)
  process.exit(2)
}
const bytes = readFileSync(join(src.dir, 'game.wasm'))
const { buildHash } = JSON.parse(readFileSync(join(src.dir, 'game.json'), 'utf8'))
const sha = createHash('sha256').update(bytes).digest('hex')
if (sha !== buildHash) throw new Error(`game.wasm sha256 ${sha} != buildHash ${buildHash}`)

const stage = join(here, '.stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
copyFileSync(join(src.dir, 'game.wasm'), join(stage, 'game.wasm'))
copyFileSync(join(src.dir, 'game.json'), join(stage, 'game.json'))
const payload = { name, params: src.params }
if (values['arena-mib']) payload.arenaBytes = Number(values['arena-mib']) * 1024 * 1024
writeFileSync(join(stage, 'payload.json'), JSON.stringify(payload))
console.log(`staged ${name} buildHash ${buildHash} arenaBytes ${payload.arenaBytes ?? 'default'}`)
