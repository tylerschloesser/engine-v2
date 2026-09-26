// 0005 Panic recovery 2-4 (docs/plan/24-recovery-and-migration.md): the state machine `SimHost`
// (`../server.ts`) runs after any trap kills its current instance. `server.ts` owns the loop guard,
// `onRecovered`/`onFatal`, pacing and connection re-attach (`SimInstance.simReattach`); this module
// owns only the pure decision logic (Planning decisions 1: "'recurs' is decided from the progress
// cursor ... not from the message") and the storage-facing retry loop that writes a `Skip` record
// when a replay-time trap recurs inside `ApplyRecord`.
import { RegionId } from '../abi.js'
import { type EngineInstance, EngineTrap } from '../loader.js'
import type { Persistence } from './persistence.js'

/** Mirrors `persist::progress::Phase` (Rust), in this exact numeric order (docs/plan/
 * 24-recovery-and-migration.md Seams): read, never written, from TS. */
export const Phase = {
  Idle: 0,
  Admit: 1,
  ApplyRecord: 2,
  OnPlayer: 3,
  Tick: 4,
  BuildFrame: 5,
  Snapshot: 6,
  Replay: 7,
} as const
export type Phase = (typeof Phase)[keyof typeof Phase]

export interface ProgressCursor {
  phase: Phase
  tick: number
  record: number
}

/** Reads the 12-byte `ProgressCursor` straight out of `inst`'s `Progress` region -- **no export
 * call**, the same "read a dead instance" discipline 0014 §6 requires (Provides: "read from a dead
 * instance through `inst.region(11).u8`/`inst.mem.u32`, which call no export"). `null` when this
 * instance has no such region (a hand-rolled fixture with no sim role -- never a real sim-role
 * `panicky`/game instance, which always declares one). */
export function readProgressCursor(inst: EngineInstance): ProgressCursor | null {
  const region = inst.region(RegionId.Progress)
  if (!region) return null
  const view = new DataView(region.u8.buffer, region.u8.byteOffset, 12)
  return {
    phase: view.getUint32(0, true) as Phase,
    tick: view.getUint32(4, true),
    record: view.getUint32(8, true),
  }
}

/** `createSimHostFromInstance`'s own recovery wiring (`../server.ts`): the raw instance currently
 * backing its `SimInstance` (`server.ts`'s own `SimInstance` is deliberately narrow,
 * `wrapEngineInstance`'s doc comment, and has no way back to the raw `EngineInstance` it wraps) plus
 * the factory that builds a fresh one from the same kept `WebAssembly.Module` (0005 Panic recovery
 * 1: "the compiled Module is kept, so a new instance is cheap"). `instance` is mutated by
 * `runPanicRecovery`'s own caller (`SimHost.recover()`) after every successful recovery, so a second
 * trap reads the right (now dead) instance's `Progress` region, and so a caller holding its own
 * reference (`worker/sim.ts`'s `testCall` fallback) can read the current one back out too. */
export interface RecoveryDeps {
  instance: EngineInstance
  newInstance: () => EngineInstance
}

/** Planning decisions 3: "more than 3 recoveries without 1,200 successfully ticked ticks in
 * between is fatal. The number is a constant in `recovery.ts`, not config." -- `SimHost.recover()`
 * refuses a recovery attempt outright (immediate `onFatal`, no replay even tried) once this many
 * have already happened without `RECOVERY_GOOD_TICKS_RESET` good ticks resetting the count. */
export const RECOVERY_LOOP_LIMIT = 3
/** The good-tick count that resets the loop guard above (0005 Cadence's own snapshot cadence
 * shares this number, 1,200 ticks at 20 Hz = 60 s -- Planning decisions 3 names it directly, not by
 * reference, so it is repeated here rather than imported from `persistence.ts`). */
export const RECOVERY_GOOD_TICKS_RESET = 1200

/** Planning decisions 1: "`OnPlayer` and `Replay` (container code) traps on replay are treated
 * like `Tick`" -- wedged, `onFatal`. Only `ApplyRecord` recovers via a `Skip`. Anything else
 * observed here (there should be nothing else: only `ApplyRecord`/`OnPlayer`/`Replay` ever run
 * during a replay) is also treated as wedged, the safe default. */
function isWedgedPhase(phase: Phase): boolean {
  return phase !== Phase.ApplyRecord
}

export type RecoveryOutcome =
  | { kind: 'ok'; sim: EngineInstance; tick: number; skipped: number }
  | { kind: 'fatal'; tick: number; message: string }

/** A safety backstop only, never expected to bind in practice (docs/plan/
 * 24-recovery-and-migration.md): each successful `appendSkip` makes forward progress, since the
 * newly-appended `Skip` frame is itself part of the segment tail the *next* attempt's own scan pass
 * sees (the same byte offset can never be re-skipped) -- this exists only so a defect elsewhere
 * cannot spin this loop forever. */
const MAX_SKIP_ITERATIONS = 10_000

/**
 * The 0005 Panic recovery 2-3 retry loop for one live-trap event. `persistence.recover` reuses
 * `Persistence.loadLatest` exactly (0005 Panic recovery 2) -- a live-trap recovery is not
 * distinguished from an ordinary reload at the storage level, only in what happens when replay
 * itself traps *again*, below.
 *
 * Every iteration asks `persistence.recover` to build a brand-new instance (0005 Panic recovery 1)
 * and replay onto it. A repeat trap during that replay is read from the *dead* replaying instance's
 * own `Progress` region (Planning decisions 1: "decided from the progress cursor ... not from the
 * message"): `ApplyRecord` means the record at `(segment, offset)` is poisoned -- a throwaway
 * instance encodes a `Skip` frame for it (`Persistence.appendSkip`, since the dead instance that
 * just trapped can never be called again) and this loop restarts; anything else means the world is
 * wedged under this build (`kind: 'fatal'`, Planning decisions 1).
 */
export async function runPanicRecovery(
  persistence: Persistence,
  newInstance: () => EngineInstance,
): Promise<RecoveryOutcome> {
  let skipped = 0
  for (let i = 0; i < MAX_SKIP_ITERATIONS; i++) {
    let lastBuilt: EngineInstance | undefined
    let lastSegment = -1
    const tracked = (): EngineInstance => {
      const inst = newInstance()
      lastBuilt = inst
      return inst
    }
    try {
      const loaded = await persistence.recover(tracked, (segment) => {
        lastSegment = segment
      })
      return { kind: 'ok', sim: loaded.sim, tick: loaded.tick, skipped }
    } catch (e) {
      if (!(e instanceof EngineTrap) || !lastBuilt) throw e
      const cursor = readProgressCursor(lastBuilt)
      const message = lastBuilt.panicMessage ?? e.panicMessage
      if (!cursor || isWedgedPhase(cursor.phase) || lastSegment < 0) {
        return { kind: 'fatal', tick: cursor?.tick ?? 0, message }
      }
      // Planning decisions 1: "always the record's own segment" -- `lastSegment` is exactly the
      // segment `persistence.recover`'s own replay pass was replaying when it trapped again, and
      // `cursor.record` is that record's own absolute byte offset within it (Seams: "ApplyRecord's
      // record field ... during replay ... the record's absolute byte offset").
      const skipInst = newInstance()
      await persistence.appendSkip(lastSegment, cursor.record, skipInst)
      skipped++
    }
  }
  return { kind: 'fatal', tick: 0, message: 'recovery: exceeded the maximum Skip retry count' }
}
