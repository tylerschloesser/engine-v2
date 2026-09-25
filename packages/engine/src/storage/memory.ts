// The memory `Storage` adapter (docs/decisions/0005-persistence-and-recovery.md Storage table:
// "Memory | copies | never (`durable: false`) | replaces the value"): never durable, used as the
// Safari-private-mode/no-OPFS fallback (0005 "Browser") and as the conformance/test double every
// other adapter is measured against (`runStorageConformance`, `./conformance.ts`).
import type { Storage } from './types.js'

/** `crashClone`'s own option: for each key, how many trailing bytes to drop (simulating a crash
 * mid-`append`/`write` -- docs/plan/22-persistence-log-and-snapshots.md Seams). Keys not named
 * keep their full value. */
export interface CrashCloneOptions {
  dropTailBytes?: Record<string, number>
}

export interface MemoryStorage extends Storage {
  /** A copy of this storage's current contents, as a crashed process would leave them (Seams:
   * "consumed by M22b, M24"). The clone is independent afterward: writes to either do not affect
   * the other. */
  crashClone(opts?: CrashCloneOptions): MemoryStorage
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export function memoryStorage(): MemoryStorage {
  const data = new Map<string, Uint8Array>()

  const storage: MemoryStorage = {
    onError: null,
    append(key, bytes) {
      // `bytes` is an engine-owned view valid only during the call (0005 Storage): copy now.
      const copy = bytes.slice()
      const existing = data.get(key)
      data.set(key, existing ? concat(existing, copy) : copy)
    },
    sync(_key) {
      // Memory storage is never durable (0005's own table): a no-op barrier.
    },
    write(key, bytes) {
      data.set(key, bytes.slice())
    },
    delete(key) {
      data.delete(key)
    },
    async flush() {
      // Nothing in-flight to wait for: every write above already landed synchronously.
    },
    async read(key) {
      const bytes = data.get(key)
      return bytes ? bytes.slice() : null
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort()
    },
    crashClone(opts) {
      const clone = memoryStorage()
      for (const [key, bytes] of data) {
        const drop = opts?.dropTailBytes?.[key] ?? 0
        const kept = drop > 0 ? bytes.subarray(0, Math.max(0, bytes.length - drop)) : bytes
        clone.write(key, kept)
      }
      return clone
    },
  }
  return storage
}
