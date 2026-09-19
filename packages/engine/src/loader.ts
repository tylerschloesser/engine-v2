// The one fixed loader (docs/decisions/0014): takes a compiled module, works in a worker, Node, Bun
// and workerd. Internal module: no exports-map entry. Hot-path rule: `.claude/rules/hot-paths.md`.
import {
  type ABI_EXPORTS,
  ABI_VERSION,
  BOOT_BYTES,
  BOOT_TEXT_BYTES,
  LogLevel,
  RegionId,
  type Role,
  Status,
  statusName,
} from './abi.js'

/** JSON keys are camelCase; later milestones add keys. */
export type InstanceConfig = {
  /** Reserved once by `engine_init`; growth past it is counted by `memGrows()` (0015 §5). */
  arenaBytes: number
  /** Handed to the game as JSON. A u64 is a `"0x…"` string. */
  game: unknown
}

/** Text is decoded in the instance's own isolate. Defaults write to `console`. */
export type LoaderHooks = {
  onLog?(level: LogLevel, text: string): void
  onPanic?(text: string): void
}

type ExportFn<P extends number> = P extends 0
  ? () => number
  : P extends 1
    ? (a: number) => number
    : (a: number, b: number) => number

/** The module's exports, typed from `ABI_EXPORTS`. Call them through `call0/1/2` only. */
export type RawExports = {
  readonly [K in keyof typeof ABI_EXPORTS]: ExportFn<(typeof ABI_EXPORTS)[K]['params']>
} & { readonly memory: WebAssembly.Memory }

/** A stable holder: `ptr` and `len` never change, `u8` is rebuilt when memory grows. */
export type RegionView = { readonly ptr: number; readonly len: number; u8: Uint8Array }

export interface EngineInstance {
  readonly role: Role
  readonly x: RawExports
  /** Whole-memory views, replaced on growth: read them through `inst.mem` every time. */
  readonly mem: { u8: Uint8Array; u32: Uint32Array }
  /** True after a trap; no export is ever called on a dead instance again. */
  readonly dead: boolean
  /** The text of `engine.panic`, or the trap's own message when there was none. */
  readonly panicMessage: string | null
  /**
   * The only way to call an export: refuses a dead instance, turns a trap into `EngineTrap`, and
   * rebuilds the views when the call grew memory. Fixed arity, so no rest array is allocated.
   */
  call0(fn: () => number): number
  call1(fn: (a: number) => number, a: number): number
  call2(fn: (a: number, b: number) => number, a: number, b: number): number
  /** `null` when this role has no such region. */
  region(id: RegionId): RegionView | null
  onViewsRebuilt(cb: () => void): void
  memoryBytes(): number
  memGrows(): number
  /** A u64 written as two LE u32 (lo, hi), as 16 lowercase hex digits. */
  readU64Hex(id: RegionId, offset: number): string
}

export class AbiMismatchError extends Error {
  readonly expected: number
  /** `null` when the module has no `engine_abi_version` export at all. */
  readonly actual: number | null
  constructor(expected: number, actual: number | null) {
    super(
      `engine ABI mismatch: loader is version ${expected}, module is ${actual ?? 'not an engine module'}`,
    )
    this.name = 'AbiMismatchError'
    this.expected = expected
    this.actual = actual
  }
}

export class EngineInitError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`engine_init failed: ${statusName(status)}`)
    this.name = 'EngineInitError'
    this.status = status
  }
}

export class EngineTrap extends Error {
  readonly role: Role
  readonly panicMessage: string
  constructor(role: Role, panicMessage: string) {
    super(`engine instance (role ${role}) trapped: ${panicMessage}`)
    this.name = 'EngineTrap'
    this.role = role
    this.panicMessage = panicMessage
  }
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

function defaultLog(level: LogLevel, text: string): void {
  if (level === LogLevel.Error) console.error(text)
  else if (level === LogLevel.Warn) console.warn(text)
  else if (level === LogLevel.Info) console.info(text)
  else console.debug(text)
}

class Instance implements EngineInstance {
  readonly role: Role
  readonly x: RawExports
  readonly mem: { u8: Uint8Array; u32: Uint32Array }
  dead = false
  panicMessage: string | null = null
  readonly #regions: (RegionView | null)[] = []
  readonly #rebuilt: (() => void)[] = []

  constructor(module: WebAssembly.Module, role: Role, hooks: LoaderHooks) {
    const onLog = hooks.onLog ?? defaultLog
    const onPanic = hooks.onPanic ?? console.error
    // Text is rare and may arrive mid-call after a growth, so it gets a fresh view each time.
    const text = (ptr: number, len: number) =>
      decoder.decode(new Uint8Array(this.x.memory.buffer, ptr, len))
    const instance = new WebAssembly.Instance(module, {
      engine: {
        panic: (ptr: number, len: number) => {
          this.panicMessage = text(ptr, len)
          onPanic(this.panicMessage)
        },
        log: (level: number, ptr: number, len: number) => onLog(level as LogLevel, text(ptr, len)),
      },
    })
    this.role = role
    this.x = instance.exports as unknown as RawExports
    if (!(this.x.memory instanceof WebAssembly.Memory)) {
      throw new AbiMismatchError(ABI_VERSION, null)
    }
    const buffer = this.x.memory.buffer
    this.mem = { u8: new Uint8Array(buffer), u32: new Uint32Array(buffer) }
  }

  init(config: InstanceConfig): void {
    const { x } = this
    const actual = typeof x.engine_abi_version === 'function' ? x.engine_abi_version() : null
    if (actual !== ABI_VERSION) throw new AbiMismatchError(ABI_VERSION, actual)

    const json = encoder.encode(JSON.stringify(config))
    if (json.length > BOOT_BYTES - BOOT_TEXT_BYTES) throw new EngineInitError(Status.BadConfig)
    const boot = this.call0(x.engine_boot) >>> 0
    this.mem.u8.set(json, boot)
    const status = this.call2(x.engine_init, this.role, json.length)
    if (status !== Status.Ok) throw new EngineInitError(status)

    // Regions never move or resize after init (0014 §4): read each (ptr, len) once.
    for (const id of Object.values(RegionId)) {
      const ptr = this.call1(x.engine_region, id) >>> 0
      const len = this.call1(x.engine_region_len, id) >>> 0
      this.#regions[id] =
        ptr === 0 ? null : { ptr, len, u8: new Uint8Array(x.memory.buffer, ptr, len) }
    }
  }

  call0(fn: () => number): number {
    if (this.dead) throw this.#deadError()
    let result: number
    try {
      result = fn()
    } catch (e) {
      throw this.#trapped(e)
    }
    // `memory.grow` detaches every view; this comparison allocates nothing (0014 §4).
    if (this.mem.u8.byteLength === 0) this.#rebuild()
    return result
  }

  call1(fn: (a: number) => number, a: number): number {
    if (this.dead) throw this.#deadError()
    let result: number
    try {
      result = fn(a)
    } catch (e) {
      throw this.#trapped(e)
    }
    if (this.mem.u8.byteLength === 0) this.#rebuild()
    return result
  }

  call2(fn: (a: number, b: number) => number, a: number, b: number): number {
    if (this.dead) throw this.#deadError()
    let result: number
    try {
      result = fn(a, b)
    } catch (e) {
      throw this.#trapped(e)
    }
    if (this.mem.u8.byteLength === 0) this.#rebuild()
    return result
  }

  region(id: RegionId): RegionView | null {
    return this.#regions[id] ?? null
  }

  onViewsRebuilt(cb: () => void): void {
    this.#rebuilt.push(cb)
  }

  memoryBytes(): number {
    return this.x.memory.buffer.byteLength
  }

  memGrows(): number {
    return this.call0(this.x.engine_mem_grows) >>> 0
  }

  readU64Hex(id: RegionId, offset: number): string {
    const region = this.#regions[id]
    if (!region || offset < 0 || offset + 8 > region.len) {
      throw new RangeError(`readU64Hex: region ${id} has no 8 bytes at offset ${offset}`)
    }
    let hex = ''
    for (let i = 7; i >= 0; i--) {
      hex += (region.u8[offset + i] as number).toString(16).padStart(2, '0')
    }
    return hex
  }

  /** Addresses are stable under growth; only the JS views die. */
  #rebuild(): void {
    const buffer = this.x.memory.buffer
    this.mem.u8 = new Uint8Array(buffer)
    this.mem.u32 = new Uint32Array(buffer)
    for (const region of this.#regions) {
      if (region) region.u8 = new Uint8Array(buffer, region.ptr, region.len)
    }
    for (const cb of this.#rebuilt) cb()
  }

  #trapped(e: unknown): EngineTrap {
    this.dead = true
    // A trap with no preceding `engine.panic` (stack overflow, out of bounds) reports itself.
    this.panicMessage ??= e instanceof Error ? e.message : String(e)
    return new EngineTrap(this.role, this.panicMessage)
  }

  #deadError(): EngineTrap {
    return new EngineTrap(this.role, this.panicMessage ?? 'instance is dead')
  }
}

/**
 * Instantiate `module` in `role` and run `engine_init`. Synchronous: the caller already holds a
 * compiled module (0015). Throws `AbiMismatchError`, `EngineInitError` or `EngineTrap`.
 */
export function instantiate(
  module: WebAssembly.Module,
  role: Role,
  config: InstanceConfig,
  hooks: LoaderHooks = {},
): EngineInstance {
  const instance = new Instance(module, role, hooks)
  instance.init(config)
  return instance
}
