// `node scripts/probe-recovery.mjs --name <worker> --scale <n> [--arena-mib <n>] --game <dir>`: does a world
// that has a snapshot come back after the object restarts? (docs/plan/38-hosting-checks.md Scope A,
// step 2.) Stages the `bench` payload, deploys it as `--name` (a probe Worker, never the measured
// one), runs one acting client for 80 s (a snapshot is written at tick 1,200), redeploys the same
// code (every deploy restarts the object), dials again and reports whether the world went live and how
// many times the object restarted while it tried. Prints one result line.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadGame, makeClient, sleep, stepUntil } from './lib.mjs'

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scale: { type: 'string', default: '1' },
    'arena-mib': { type: 'string' },
    game: { type: 'string' },
    world: { type: 'string', default: `rec-${Date.now()}` },
  },
})
const pkg = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args) => execFileSync(cmd, args, { cwd: pkg, encoding: 'utf8', stdio: 'pipe' })
const stage = [
  'scripts/stage.mjs',
  'bench',
  '--scale',
  values.scale,
  ...(values['arena-mib'] ? ['--arena-mib', values['arena-mib']] : []),
]
// A new `--var` makes every deploy a new version, so the object really restarts.
const deploy = () =>
  run('wrangler', ['deploy', '--name', values.name, '--var', `NONCE:${Date.now()}`])
run('node', stage)
const out = deploy()
const base = /https:\/\/\S+workers\.dev/.exec(out)?.[0]
const game = await loadGame(values.game)
await sleep(8000)
const dial = (secretByte) =>
  makeClient(`${base.replace('https', 'wss')}/ws/${values.world}`, game, secretByte)
const stats = async () => (await fetch(`${base}/stats/${values.world}`)).json()

const c1 = dial(0x91)
c1.setCamera({ x: 0, y: 0, tilesAcross: 24 })
const live1 = await stepUntil(c1, () => c1.status().live, 30_000)
const until = Date.now() + 80_000
let next = 0
while (Date.now() < until) {
  if (Date.now() >= next) {
    next = Date.now() + 15_000
    c1.dispatch('CancelCollect')
  }
  c1.stepFrame(16)
  await sleep(16)
}
const s1 = await stats()
c1.leave()
await sleep(500)
console.log(
  `first boot: live=${live1} starts=${s1.starts.length} fault=${s1.fault} storage=${JSON.stringify(s1.storageIndex)}`,
)

deploy()
await sleep(8000)
const c2 = dial(0x92)
c2.setCamera({ x: 0, y: 0, tilesAcross: 24 })
const live2 = await stepUntil(c2, () => c2.status().live, 40_000)
await sleep(2000)
const s2 = await stats()
console.log(
  `RESULT scale=${values.scale} arena=${values['arena-mib'] ?? 'default 96'} MiB: recovered=${live2} starts=${s2.starts.length} (first boot ${s1.starts.length}) fault=${s2.fault}`,
)
process.exit(0)
