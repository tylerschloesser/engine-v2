// Stages exactly what the image needs under `.stage/` (the Docker build context is this directory;
// `.dockerignore` lets nothing else in), laid out as the server expects to find it: the engine
// package as `node_modules/engine`, this server, and the reference game's `world.json`, release
// `.wasm` and built client at the paths `index.mjs` resolves relative to itself.
// Run `pnpm --filter engine build && pnpm --filter reference build` first. The `.wasm` the server
// loads and the one the client was built with must be the same bytes (`buildHash` is the identity
// the handshake checks), so this refuses to stage a pair that differs.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const repo = join(here, '..', '..')
const stage = join(here, '.stage')
const release = join(repo, 'games/reference/sim/target/engine/release')
const dist = join(repo, 'games/reference/dist')

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const { buildHash } = JSON.parse(readFileSync(join(release, 'game.json'), 'utf8'))
const clientWasm = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.wasm'))
if (sha(join(release, 'game.wasm')) !== buildHash)
  throw new Error('game.wasm != game.json buildHash')
if (clientWasm.length !== 1 || sha(join(dist, 'assets', clientWasm[0])) !== buildHash) {
  throw new Error('the built client carries a different .wasm than the release build')
}

rmSync(stage, { recursive: true, force: true })
const put = (from, to, opts) => {
  mkdirSync(join(stage, to, '..'), { recursive: true })
  cpSync(from, join(stage, to), { recursive: true, ...opts })
}
put(join(repo, 'packages/engine/package.json'), 'node_modules/engine/package.json')
put(join(repo, 'packages/engine/dist'), 'node_modules/engine/dist')
for (const f of ['index.mjs', 'static.mjs', 'package.json']) {
  put(join(here, f), `games/reference-server/${f}`)
}
put(join(repo, 'games/reference/world.json'), 'games/reference/world.json')
put(release, 'games/reference/sim/target/engine/release')
put(dist, 'client')
console.log(`staged ${stage} (buildHash ${buildHash})`)
