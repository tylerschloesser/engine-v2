// `pnpm --filter reference golden:record` (M34b: runs
// `fullGame()` (tests/helpers/script.ts) on the headless driver against `createWorldServer` with
// memory storage and a virtual clock, then writes `tests/golden/full-game.log` (segment 0's frames)
// and `full-game.json` (checkpoint hashes from the `.wasm` replay under Node, 0002 section 1). The only
// writer of both: a changed file is a changed sim or a changed script, reviewed like any golden
// (0020 section 5). Rebuilds the game first, so the golden is never taken from a stale module.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadGame } from 'engine/server/node'
import {
  createNetHarness,
  lastLoggedTick,
  replayLog,
  segmentZeroFrames,
  worldServerTestHandle,
} from 'engine/test'
import { buildGame } from 'engine/vite'
import { toolEnv } from '../../../scripts/lib/env.mjs'
import { fullGame, headlessDriver, runScript } from '../tests/helpers/script.ts'

const GOLDEN_DIR = fileURLToPath(new URL('../tests/golden/', import.meta.url))
/** A checkpoint every this many ticks, plus the last one. */
const CHECKPOINT_EVERY = 10
const checkpointTicks = (last) => {
  const out = []
  for (let t = CHECKPOINT_EVERY; t < last; t += CHECKPOINT_EVERY) out.push(t)
  out.push(last)
  return out
}

const crate = fileURLToPath(new URL('../sim', import.meta.url))
const built = await buildGame({ crate, profile: 'dev', env: toolEnv() })
const game = await loadGame(built.dir)
const world = JSON.parse(
  readFileSync(fileURLToPath(new URL('../world.json', import.meta.url)), 'utf8'),
)
const params = { seed: world.seed, worldgen: world.worldgen }

// The harness seed is a JS number and only seeds the link conditioner (zero latency here, so it
// decides nothing); the world's own u64 seed is `world.json`'s, which a number cannot hold.
const h = await createNetHarness({
  fixture: game,
  seed: 3405,
  worldSeed: world.seed,
  clients: 1,
  world: { params: { worldgen: world.worldgen } },
})
let ticks
let liveHash
let frames
try {
  await h.advanceTicks(20) // the join, the first `Ui`
  await runScript(
    fullGame(),
    headlessDriver(h.clients[0], (n) => h.advanceTicks(n)),
  )
  await h.settle() // in-flight frames land; the replica must equal the host's region
  h.assertConverged()
  const sim = worldServerTestHandle(h.server)
  ticks = sim.counters.ticksRun
  liveHash = sim.hash()
  await h.server.stop() // flushes the log tail
  const logKeys = (await h.storage.list('worlds/')).filter((k) => k.includes('/log/'))
  if (logKeys.length !== 1) throw new Error(`expected one log segment, found ${logKeys}`)
  const log = await h.storage.read(logKeys[0])
  frames = segmentZeroFrames(game.wasm, params, log)
} finally {
  await h.dispose()
}

// A log has no idle ticks past its last frame, so the golden ends there (the native replay cannot go
// further); the script ends quiescent, so that state is the live run's final state.
const end = lastLoggedTick(frames)
const checkpoints = await replayLog({
  wasm: game.wasm,
  params,
  frames,
  checkpoints: checkpointTicks(end),
})
const last = checkpoints.at(-1)
if (last.hash !== liveHash) {
  throw new Error(
    `the replay at its last logged tick ${end} (${last.hash}) is not the live run's final state ` +
      `at tick ${ticks} (${liveHash}): the script does not end quiescent`,
  )
}

writeFileSync(`${GOLDEN_DIR}full-game.log`, frames)
const meta = { seed: world.seed, worldgen: world.worldgen, players: 1, ticks: end, checkpoints }
writeFileSync(`${GOLDEN_DIR}full-game.json`, `${JSON.stringify(meta, null, 2)}\n`)
console.log(
  `full-game: ${end} logged ticks (run: ${ticks}), ${frames.length} log bytes, final hash ${liveHash}`,
)
