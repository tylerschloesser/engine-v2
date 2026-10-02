// `node scripts/probe-memory.mjs --base https://<worker> --world <id> --game <dir> [--step 8]`: the memory
// headroom probe of docs/plan/38-hosting-checks.md Scope A step 2. Holds one headless client on the
// world (so it is loaded and ticking), then asks the object (`/alloc`, only when the worker was deployed
// with `--var ALLOW_ALLOC:1`) to allocate and touch `--step` MiB of JS heap at a time until the request
// fails or the object restarts; prints the total reached. The world's own wasm memory is
// `memBytes` in `/stats`.
import { parseArgs } from 'node:util'
import { loadGame, makeClient, sleep, stepUntil } from './lib.mjs'

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    world: { type: 'string' },
    game: { type: 'string' },
    step: { type: 'string', default: '8' },
  },
})
const game = await loadGame(values.game)
const client = makeClient(`${values.base.replace('https', 'wss')}/ws/${values.world}`, game, 0x71)
client.setCamera({ x: 0, y: 0, tilesAcross: 24 })
const live = await stepUntil(client, () => client.status().live, 30_000)
console.log(`live=${live}`)
let held = 0
const startsAt = async () => {
  const r = await fetch(`${values.base}/stats/${values.world}`)
  const j = await r.json()
  return { starts: j.starts.length, fault: j.fault, mem: j.windows.at(-1)?.memBytes }
}
const s0 = await startsAt()
console.log(`before: starts=${s0.starts} wasm memBytes=${s0.mem}`)
for (;;) {
  let res
  try {
    const r = await fetch(`${values.base}/alloc/${values.world}?mb=${values.step}`, {
      signal: AbortSignal.timeout(30_000),
    })
    res = { status: r.status, text: await r.text() }
  } catch (e) {
    res = { status: 0, text: String(e) }
  }
  if (res.status !== 200) {
    console.log(`FAILED after holding ${held} MiB: status ${res.status} ${res.text.slice(0, 200)}`)
    break
  }
  held = JSON.parse(res.text).heldMiB
  console.log(`held ${held} MiB`)
  await stepUntil(client, () => false, 1500)
  if (held >= 512) break
}
await sleep(3000)
const s1 = await startsAt()
console.log(
  `after: starts=${s1.starts} (before ${s0.starts}) fault=${s1.fault} live=${client.status().live} linkUpCount=${client.status().linkUpCount}`,
)
process.exit(0)
