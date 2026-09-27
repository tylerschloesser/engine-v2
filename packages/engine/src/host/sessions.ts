// The session table (docs/decisions/0013-sessions-and-integrity.md "Identity"; docs/plan/
// 28-sessions-and-reconnect.md steps 1-2): `SHA-256(secret) -> { playerId, lastPresence }`,
// persisted through `Storage.write` at key `sessions` (0005's key list, `storage/types.ts`'s own
// `WorldKeys.sessions`). Off the tick path (a join/reconnect is a human-rate event, not per-frame
// or per-tick), so JSON plus `crypto.subtle.digest` (WebCrypto, present in every target runtime,
// 0013) are both fine here -- `no-ambient-random.test.ts`'s own allowlist note: "banning the whole
// `crypto` global would also ban WebCrypto hashing (M28)".
import type { Storage, WorldKeys } from '../storage/types.js'

/** One session table row (0013: "the host-side session table"). `lastPresenceHex` is the last
 * `Codec`-encoded `G::Presence` sample this player's connection ever carried, hex text (`null`
 * before the first one) -- `Welcome`'s own `presence` field is built from this on every
 * (re)attach (`Host::attach`'s own `PresenceTable::restore` call, fed from `sim_attach`'s input). */
export interface SessionEntry {
  playerId: number
  lastPresenceHex: string | null
}

export interface SessionTable {
  /** `hashHex` is `hex(SHA-256(secret))` (`hashSecretHex` below). */
  lookup(hashHex: string): SessionEntry | undefined
  /** A never-seen secret: creates and returns a fresh entry with `playerId`, `lastPresenceHex:
   * null`. Does not persist -- `save()` afterward (Planning decisions: "the table entry is
   * written before the record is appended"). Throws if `hashHex` already has an entry (a caller
   * bug: check `lookup` first). */
  create(hashHex: string, playerId: number): SessionEntry
  setLastPresence(hashHex: string, presenceHex: string | null): void
  /** The highest `playerId` ever recorded in this table, `0` if empty -- the caller's own starting
   * point for "next id is `max(table, sim) + 1`" (Planning decisions). */
  highestPlayerId(): number
  /** Atomic replace of the whole table (`Storage.write`'s own contract) -- awaited by the caller
   * before the corresponding `sim_attach` call for a brand-new secret (crash safety: the table
   * entry must be durable before the log ever records the join). */
  save(): Promise<void>
}

function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += b < 16 ? `0${b.toString(16)}` : b.toString(16)
  }
  return out
}

export function hexDecode(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/** `hex(SHA-256(secret))` (0013 Identity: "the host keeps `SHA-256(secret) -> PlayerId`"). Async:
 * `crypto.subtle.digest` is a promise in every runtime -- the caller queues the result rather than
 * blocking the handshake on it (Planning decisions "Async digest, deterministic order"). */
export async function hashSecretHex(secret: Uint8Array): Promise<string> {
  // `.slice()`: a fresh, plain-`ArrayBuffer`-backed copy. `secret` may be a view over a shared or
  // otherwise generic `ArrayBufferLike` (e.g. sliced from a `Connection.onMessage` buffer), which
  // `SubtleCrypto.digest`'s own `BufferSource` parameter type does not accept directly.
  const digest = await crypto.subtle.digest('SHA-256', secret.slice())
  return hexEncode(new Uint8Array(digest))
}

/** Loads the table from `storage` (empty if the key has never been written -- a brand-new world),
 * or throws if the stored bytes fail to parse as the table's own JSON shape (corrupt storage is
 * fatal to the world, 0005, the same as any other write/read failure on the tick path's own data). */
export async function loadSessionTable(storage: Storage, keys: WorldKeys): Promise<SessionTable> {
  const raw = await storage.read(keys.sessions)
  const table: Record<string, SessionEntry> = raw
    ? (JSON.parse(new TextDecoder().decode(raw)) as Record<string, SessionEntry>)
    : {}

  return {
    lookup(hashHex) {
      return table[hashHex]
    },
    create(hashHex, playerId) {
      if (table[hashHex]) {
        throw new Error(`SessionTable.create: ${hashHex} already has an entry`)
      }
      const entry: SessionEntry = { playerId, lastPresenceHex: null }
      table[hashHex] = entry
      return entry
    },
    setLastPresence(hashHex, presenceHex) {
      const entry = table[hashHex]
      if (entry) entry.lastPresenceHex = presenceHex
    },
    highestPlayerId() {
      let max = 0
      for (const key in table) {
        const entry = table[key]
        if (entry && entry.playerId > max) max = entry.playerId
      }
      return max
    },
    async save() {
      const bytes = new TextEncoder().encode(JSON.stringify(table))
      await storage.write(keys.sessions, bytes)
    },
  }
}
