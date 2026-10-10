// Release-only behaviours (M35: no earlier test builds a release
// module, so these do, on profile `release-names` (release with `strip = false`: names kept so a
// string or symbol can be looked for). `fx-hash` is the module: it logs one distinct line per level
// on `logAtTick`, and allocates 64 MiB past its arena on `exhaustAtTick`. @slow: a release build.
//   - `log` below `warn` is compiled out (0014 §3): the strings are not in the module and `onLog`
//     never fires below `warn`.
//   - past the reservation the arena grows in 16 MiB steps up to the ceiling and `memGrows()` counts
//     the steps (0015 §5); past the ceiling the instance traps.
import { readFile } from 'node:fs/promises'
import { beforeAll, expect, test } from 'vitest'
import { LogLevel, Role } from '../../src/abi.js'
import { buildGame } from '../../src/build-game.js'
import { EngineTrap, type InstanceConfig, instantiate } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { fixtureDir } from '../support/fixtures.js'

const MIB = 1 << 20
const STEP = 16 * MIB

let wasm: WebAssembly.Module
let bytes: Uint8Array<ArrayBuffer>

beforeAll(async () => {
  const built = await buildGame({ crate: fixtureDir('hash'), profile: 'release-names' })
  const game = await loadGame(built.dir)
  wasm = game.wasm
  bytes = await readFile(built.wasmPath)
}, 600_000)

const LINES = {
  error: 'fx-hash log line: error level',
  warn: 'fx-hash log line: warn level',
  info: 'fx-hash log line: info level',
  debug: 'fx-hash log line: debug level',
}

function config(extra: Partial<InstanceConfig>, game: Record<string, unknown>): InstanceConfig {
  return { arenaBytes: MIB, game: { seed: '0x2a', entities: 8, ...game }, ...extra }
}

test('release module drops info logs @slow', () => {
  const holds = (text: string): boolean => Buffer.from(bytes).includes(text)
  // The two levels a release module keeps are in the module; the two it drops are not.
  expect(holds(LINES.error), 'error line is in the module').toBe(true)
  expect(holds(LINES.warn), 'warn line is in the module').toBe(true)
  expect(holds(LINES.info), 'info line is compiled out').toBe(false)
  expect(holds(LINES.debug), 'debug line is compiled out').toBe(false)
  // A control: an export name is in the module under any profile; the absence above is real.
  expect(Buffer.from(bytes).includes('engine_mem_grows')).toBe(true)

  const seen: { level: number; text: string }[] = []
  const inst = instantiate(wasm, Role.Sim, config({}, { logAtTick: 1 }), {
    onLog: (level, text) => seen.push({ level, text }),
    onPanic() {},
  })
  inst.call0(inst.x.sim_tick)
  expect(seen).toEqual([
    { level: LogLevel.Error, text: LINES.error },
    { level: LogLevel.Warn, text: LINES.warn },
  ])
})

test('release growth steps 16 MiB and counts @slow', () => {
  const quiet = { onLog() {}, onPanic() {} }

  // Default ceiling (256 MiB): a 64 MiB allocation past a 1 MiB arena takes whole steps, and the
  // count is the number of steps.
  const grown = instantiate(wasm, Role.Sim, config({}, { exhaustAtTick: 2 }), quiet)
  grown.call0(grown.x.sim_tick)
  expect(grown.memGrows()).toBe(0)
  const before = grown.memoryBytes()
  grown.call0(grown.x.sim_tick)
  const delta = grown.memoryBytes() - before
  expect(delta % STEP, `memory grew by ${delta} B, not whole 16 MiB steps`).toBe(0)
  expect(delta).toBeGreaterThanOrEqual(64 * MIB)
  expect(grown.memGrows()).toBe(delta / STEP)

  // A ceiling of 48 MiB over a 16 MiB arena: two steps fit, the third is a failed grow (a trap).
  const capped = instantiate(
    wasm,
    Role.Sim,
    config({ arenaBytes: 16 * MIB, arenaCeilingBytes: 48 * MIB }, { exhaustAtTick: 2 }),
    quiet,
  )
  capped.call0(capped.x.sim_tick)
  const cappedBefore = capped.memoryBytes()
  expect(() => capped.call0(capped.x.sim_tick)).toThrowError(EngineTrap)
  expect(capped.panicMessage).toMatch(/^arena ceiling: requested \d+ bytes/)
  expect(capped.panicMessage).toContain('ceiling 50331648 bytes')
  // Read around the dead check, as `loader: arena exhaustion traps with message` does.
  expect(capped.x.engine_mem_grows()).toBe(2)
  expect(capped.x.memory.buffer.byteLength - cappedBefore).toBe(2 * STEP)
})
