// Loader behaviour against the real `fx-hash` module (docs/decisions/0014 §4–§6, 0015 §5).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ABI_VERSION, RegionId, Role, Status } from '../../src/abi.js'
import {
  AbiMismatchError,
  EngineInitError,
  EngineTrap,
  type InstanceConfig,
  instantiate,
  type LoaderHooks,
} from '../../src/loader.js'
import { fixtureBuildDir, fixtureBytes, loadFixture } from '../support/fixtures.js'

const { wasm, buildHash } = await loadFixture('hash')
const quiet: LoaderHooks = { onLog() {}, onPanic() {} }
const ARENA_BYTES = 1 << 20

function config(game: Record<string, unknown> = {}): InstanceConfig {
  return { arenaBytes: ARENA_BYTES, game: { seed: '0x2a', entities: 8, ...game } }
}

/** A module that is nothing but `memory` and an `engine_abi_version` returning `version` (< 64). */
function moduleWithAbiVersion(version: number): WebAssembly.Module {
  const name = (s: string) => [s.length, ...new TextEncoder().encode(s)]
  const section = (id: number, payload: number[]) => [id, payload.length, ...payload]
  return new WebAssembly.Module(
    new Uint8Array([
      ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
      ...section(1, [1, 0x60, 0, 1, 0x7f]), // type 0: () -> i32
      ...section(3, [1, 0]), // function 0 has type 0
      ...section(5, [1, 0, 1]), // one memory, one page, no maximum
      ...section(7, [2, ...name('memory'), 2, 0, ...name('engine_abi_version'), 0, 0]),
      ...section(10, [1, 4, 0, 0x41, version, 0x0b]), // i32.const version; end
    ]),
  )
}

describe('loader', () => {
  test('loader: abi mismatch', () => {
    const other = ABI_VERSION + 1
    const attempt = () => instantiate(moduleWithAbiVersion(other), Role.Sim, config(), quiet)
    expect(attempt).toThrowError(AbiMismatchError)
    expect(attempt).toThrowError(expect.objectContaining({ expected: ABI_VERSION, actual: other }))
    expect(attempt).toThrowError(new RegExp(`${ABI_VERSION}.*${other}`))
  })

  test('loader: init failure carries status', () => {
    const attempt = () => instantiate(wasm, Role.Sim, config({ entities: 0 }), quiet)
    expect(attempt).toThrowError(EngineInitError)
    expect(attempt).toThrowError(expect.objectContaining({ status: Status.BadConfig }))
    expect(attempt).toThrowError(/BadConfig/)
  })

  test('loader: panic marks instance dead with message', () => {
    const panics: string[] = []
    const hooks: LoaderHooks = { onLog() {}, onPanic: (text) => panics.push(text) }
    const inst = instantiate(wasm, Role.Sim, config({ panicAtTick: 3 }), hooks)
    expect(inst.call0(inst.x.sim_tick)).toBe(Status.Ok)
    expect(inst.call0(inst.x.sim_tick)).toBe(Status.Ok)
    expect(inst.dead).toBe(false)

    let trap: unknown
    try {
      inst.call0(inst.x.sim_tick)
    } catch (e) {
      trap = e
    }
    expect(trap).toBeInstanceOf(EngineTrap)
    expect(trap).toMatchObject({ role: Role.Sim })
    // Message and location, formatted by the hook without allocating.
    expect(inst.panicMessage).toContain('fx-hash: panicAtTick 3')
    expect(inst.panicMessage).toContain('src/lib.rs')
    expect(panics).toEqual([inst.panicMessage])
    expect(inst.dead).toBe(true)
    // No export is ever called on a dead instance again.
    expect(() => inst.call0(inst.x.sim_tick)).toThrowError(EngineTrap)
    expect(() => inst.memGrows()).toThrowError(EngineTrap)
  })

  test('loader: wrong-role export returns WrongRole', () => {
    const inst = instantiate(wasm, Role.Client, config(), quiet)
    expect(inst.call0(inst.x.sim_tick)).toBe(Status.WrongRole)
    expect(inst.call2(inst.x.sim_admit, 0, 0)).toBe(Status.WrongRole)
    expect(inst.call1(inst.x.sim_build_frame, 0)).toBe(-Status.WrongRole)
    // A status, not a trap, on every profile (0024 §16): the instance goes on working.
    expect(inst.dead).toBe(false)
    expect(inst.region(RegionId.Result)?.len).toBe(64)
    // The engine reserves `Camera` for every Client-role instance (docs/plan/06b-workers-and-
    // spawn.md, Scope: "RegionId::Camera sized here"), whatever the game; 80 bytes = the block
    // `packages/engine/src/camera/block.ts` defines.
    expect(inst.region(RegionId.Camera)?.len).toBe(80)
  })

  test('loader: views survive memory growth', () => {
    const inst = instantiate(wasm, Role.Sim, config({ growAtTick: 2 }), quiet)
    let rebuilds = 0
    inst.onViewsRebuilt(() => rebuilds++)
    const rx = inst.region(RegionId.Rx)
    const tx = inst.region(RegionId.Tx)
    if (!rx || !tx) throw new Error('fx-hash declares Rx and Tx')
    const before = { rx: rx.u8, mem: inst.mem.u8, bytes: inst.memoryBytes() }

    inst.call0(inst.x.sim_tick)
    expect(inst.memGrows()).toBe(0)
    expect(rebuilds).toBe(0)
    inst.call0(inst.x.sim_tick)

    expect(inst.memGrows()).toBeGreaterThan(0)
    expect(inst.memoryBytes()).toBeGreaterThan(before.bytes)
    expect(rebuilds).toBe(1)
    expect(before.rx.byteLength).toBe(0)
    expect(before.mem.byteLength).toBe(0)
    // Same holders, same addresses, live views.
    expect(inst.region(RegionId.Rx)).toBe(rx)
    expect(rx.u8.byteLength).toBe(rx.len)
    expect(inst.mem.u8.byteLength).toBe(inst.memoryBytes())
    expect(inst.mem.u32.byteLength).toBe(inst.memoryBytes())

    rx.u8.fill(1, 0, 16)
    expect(inst.call2(inst.x.sim_admit, 0, 16)).toBe(Status.Ok)
    expect(inst.call2(inst.x.sim_admit, 0, rx.len + 1)).toBe(Status.BadLength)
    expect(inst.call1(inst.x.sim_build_frame, 0)).toBe(64)
    expect(tx.u8[0]).toBe(2) // the tick, low byte
    expect(inst.mem.u8[tx.ptr]).toBe(2)
  })

  test('loader: arena exhaustion traps with message', () => {
    const inst = instantiate(wasm, Role.Sim, config({ exhaustAtTick: 2 }), quiet)
    inst.call0(inst.x.sim_tick)
    expect(() => inst.call0(inst.x.sim_tick)).toThrowError(EngineTrap)
    expect(inst.panicMessage).toMatch(/^arena exhausted: requested \d+ bytes/)
    expect(inst.panicMessage).toContain(`reserved ${ARENA_BYTES} bytes`)
    // The check runs before the allocator, so nothing grew. Read around the dead check: this is
    // the one place a test wants a number out of a dead instance.
    expect(inst.x.engine_mem_grows()).toBe(0)
  })

  test('build: game.json matches bytes', () => {
    const json = JSON.parse(readFileSync(join(fixtureBuildDir('hash'), 'game.json'), 'utf8'))
    const hash = createHash('sha256').update(fixtureBytes('hash')).digest('hex')
    expect(json).toEqual({ buildHash: hash, abiVersion: ABI_VERSION, profile: 'dev' })
    expect(buildHash).toBe(hash)
  })
})
