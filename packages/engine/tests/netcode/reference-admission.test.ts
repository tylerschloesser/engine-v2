// M34c step 4 (M34c Scope, "Admission"): the reference
// game refuses a third player with `Full` and a wrong join key with `BadKey`, and neither shows up
// in the log. Lives here, not under `games/reference/tests/netcode/`, because it needs the raw
// handshake (`connectRaw`, `buildHelloBytes`) from engine `src`, which the reference package's own
// `tsc` cannot follow (WebGPU types).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { RegionId, Role } from '../../src/abi.js'
import { CloseCode } from '../../src/host/handshake.js'
import { hexDecode } from '../../src/host/sessions.js'
import { instantiate } from '../../src/loader.js'
import { MsgClass, seedToHexU64, worldServerTestHandle } from '../../src/server.js'
import { loadGame } from '../../src/server-node.js'
import { createNetHarness } from '../../src/test/net-harness.js'
import { gameCrateBuildDir } from '../support/fixtures.js'
import { fixedSecret } from './support.js'

const WORLD = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../games/reference/world.json', import.meta.url)),
    'utf8',
  ),
) as { seed: string; worldgen: unknown }

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** A `Hello` built by a throwaway client instance of the reference game (`support.ts`'s
 * `buildHelloBytes` hands the game `params: null`, which the reference game's `RefParams` refuses). */
function buildHelloBytes(
  wasm: WebAssembly.Module,
  opts: { secret: Uint8Array; joinKey: string; buildHash: Uint8Array },
): Uint8Array {
  const inst = instantiate(wasm, Role.Client, {
    arenaBytes: 48 * 1024 * 1024,
    game: {
      seed: seedToHexU64(WORLD.seed),
      params: WORLD.worldgen,
      secret: hex(opts.secret),
      joinKey: opts.joinKey,
      buildHash: hex(opts.buildHash),
    },
  })
  const len = inst.call0(inst.x.client_hello)
  if (len <= 0) throw new Error(`client_hello failed: status ${-len}`)
  return (inst.region(RegionId.Tx) as NonNullable<ReturnType<typeof inst.region>>).u8.slice(0, len)
}

/** The write-ahead log's record count per appended frame (0005 Formats). */
function frameRecordCount(frame: Uint8Array): number {
  let pos = 0
  for (let i = 0; i < 2; i++) while ((frame[pos++] as number) & 0x80) {}
  let value = 0
  let shift = 0
  for (;;) {
    const b = frame[pos++] as number
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return value >>> 0
    shift += 7
  }
}

test('reference_full_and_bad_key_rejected', async () => {
  const fixture = gameCrateBuildDir('reference')
  const { wasm, buildHash } = await loadGame(fixture)
  const make = (seed: number, clients: number, world: { maxPlayers?: number; joinKey?: string }) =>
    createNetHarness({
      fixture,
      seed,
      worldSeed: WORLD.seed,
      clients,
      world: { params: { worldgen: WORLD.worldgen }, ...world },
    })
  const reject = async (
    h: Awaited<ReturnType<typeof make>>,
    hello: Uint8Array,
  ): Promise<number | undefined> => {
    const conn = h.connectRaw()
    let code: number | undefined
    conn.onClose = (c) => {
      code = c
    }
    conn.send(MsgClass.ReliableOrdered, hello)
    await h.advanceTicks(5)
    return code
  }

  // `Full`: two players in a world of two, a third (never seen) is refused.
  const full = await make(3470, 2, { maxPlayers: 2 })
  try {
    await full.settle()
    let records = 0
    const host = worldServerTestHandle(full.server)
    const original = host.logSink
    host.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      original?.(bytes)
    }
    const hello = buildHelloBytes(wasm, {
      secret: fixedSecret(0x51),
      joinKey: '',
      buildHash: hexDecode(buildHash),
    })
    expect(await reject(full, hello), 'seed 3470').toBe(CloseCode.Full)
    // The refused one left nothing: no log record, and the two players play on.
    await full.advanceTicks(10)
    expect(records, 'seed 3470: Full is not logged').toBe(0)
    expect(full.clients.every((c) => c.status().live)).toBe(true)
    full.assertConverged()
  } finally {
    await full.dispose()
  }

  // `BadKey`: a world with a key refuses a wrong one.
  const keyed = await make(3471, 0, { joinKey: 'right-key' })
  try {
    let records = 0
    const host = worldServerTestHandle(keyed.server)
    const original = host.logSink
    host.logSink = (bytes) => {
      records += frameRecordCount(bytes)
      original?.(bytes)
    }
    const hello = buildHelloBytes(wasm, {
      secret: fixedSecret(0x52),
      joinKey: 'wrong-key',
      buildHash: hexDecode(buildHash),
    })
    expect(await reject(keyed, hello), 'seed 3471').toBe(CloseCode.BadKey)
    await keyed.advanceTicks(10)
    expect(records, 'seed 3471: BadKey is not logged').toBe(0)
    // The right key is let in (the same world, so the refusal was the key and nothing else).
    const ok = buildHelloBytes(wasm, {
      secret: fixedSecret(0x53),
      joinKey: 'right-key',
      buildHash: hexDecode(buildHash),
    })
    const conn = keyed.connectRaw()
    const first: number[] = []
    conn.onMessage = (bytes) => {
      first.push(bytes[0] as number)
    }
    conn.send(MsgClass.ReliableOrdered, ok)
    await keyed.advanceTicks(5)
    expect(first[0], 'the right key gets a Welcome (MsgType 0x03)').toBe(0x03)
  } finally {
    await keyed.dispose()
  }
}, 30_000)
