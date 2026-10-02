// `node scripts/smoke.mjs --url ws://localhost:8787/ws/smoke [--game <dir>]`: join, act, reconnect
// against a running Worker (docs/plan/38-hosting-checks.md Scope A, step 1). Needs the `puts`
// payload staged (`node scripts/stage.mjs puts`), whose `SetMotd` action it dispatches. Prints one
// line per step; exits 0 when all pass.
import { parseArgs } from 'node:util'
import { loadGame, makeClient, sleep, stepUntil } from './lib.mjs'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    game: {
      type: 'string',
      default: new URL('../../../packages/engine/fixtures/puts/target/engine/dev', import.meta.url)
        .pathname,
    },
  },
})
if (!values.url) {
  console.error('usage: smoke.mjs --url ws://host/ws/<worldId> [--game dir]')
  process.exit(2)
}
const game = await loadGame(values.game)
const conns = []
let ok = true
const report = (name, pass, detail) => {
  ok &&= pass
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

const t0 = Date.now()
const client = makeClient(values.url, game, 0x31, conns)
client.setCamera({ x: 0, y: 0, tilesAcross: 20 })
const joined = await stepUntil(client, () => client.status().live, 15_000)
report('join', joined, `live=${joined} tick=${client.status().tick} in ${Date.now() - t0} ms`)

const seq = client.dispatch({ SetMotd: { n: 7 } })
const acked = await stepUntil(
  client,
  () => client.status().ackSeq >= seq && client.ui()?.motd === 7,
  5_000,
)
await stepUntil(client, () => false, 100)
const hashBefore = client.replicaHash()
report(
  'act',
  acked,
  `ackSeq=${client.status().ackSeq} (seq ${seq}) motd=${client.ui()?.motd} replicaHash=${hashBefore}`,
)

conns.at(-1).close(4000)
const down = Date.now()
const back = await stepUntil(
  client,
  () => client.status().linkUpCount >= 2 && client.status().live,
  15_000,
)
await stepUntil(client, () => false, 200)
const hashAfter = client.replicaHash()
report(
  'reconnect',
  back && hashAfter === hashBefore,
  `linkUpCount=${client.status().linkUpCount} live=${client.status().live} back in ${Date.now() - down} ms replicaHash=${hashAfter} (same: ${hashAfter === hashBefore})`,
)
client.leave()
await sleep(300)
process.exit(ok ? 0 : 1)
