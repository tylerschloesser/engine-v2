// The 0005 `Storage` contract (docs/decisions/0005-persistence-and-recovery.md "Storage"), declared
// exactly as there and, until docs/plan/22-persistence-log-and-snapshots.md steps 4-6, only a
// placeholder inline in `server.ts` (M13: "declared, unused"). This is its real home now;
// `server.ts` re-exports the type unchanged (Seams: no renamed Provides).
export interface Storage {
  // write side: called from the tick path, return value never awaited there
  append(key: string, bytes: Uint8Array): void | Promise<void>
  sync(key: string): void | Promise<void> // durability barrier; may be a no-op
  write(key: string, bytes: Uint8Array): void | Promise<void> // atomic replace (snapshots, manifest, sessions)
  delete(key: string): void | Promise<void>
  onError: ((err: unknown) => void) | null // set by the host; a failed or lost write is fatal to the world (0004)
  // off the tick path only: load, recovery, pause, shutdown, export
  flush(): Promise<void> // resolves when everything handed over so far is durable
  read(key: string): Promise<Uint8Array | null>
  list(prefix: string): Promise<string[]>
}

/** One world's storage keys (0005 Storage: "keys: `worlds/<id>/manifest`, `log/<segment>`,
 * `snap/<tick>`, `sessions`"), all namespaced under `worlds/<id>/`. `segment`/`tick` are
 * zero-padded decimal (6 and 10 digits respectively, Seams) so a lexicographic `Storage.list()`
 * sorts them numerically too. */
export interface WorldKeys {
  manifest: string
  log(segment: number): string
  snap(tick: number): string
  sessions: string
}

const SEGMENT_DIGITS = 6
const TICK_DIGITS = 10

export function worldKeys(worldId: string): WorldKeys {
  const base = `worlds/${worldId}`
  return {
    manifest: `${base}/manifest`,
    log: (segment) => `${base}/log/${String(segment).padStart(SEGMENT_DIGITS, '0')}`,
    snap: (tick) => `${base}/snap/${String(tick).padStart(TICK_DIGITS, '0')}`,
    sessions: `${base}/sessions`,
  }
}
