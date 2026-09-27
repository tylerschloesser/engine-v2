// The device identity secret (docs/decisions/0013-sessions-and-integrity.md "Identity"; docs/plan/
// 28-sessions-and-reconnect.md Seams): `loadOrMintSecret(): Uint8Array`, `localStorage` key
// `engine.playerSecret`, one per origin. On the ambient-randomness allowlist by name
// (`src/no-ambient-random.test.ts`): "the device-secret module M28 adds. No other entry without an
// ADR." Browser-only (`localStorage`); `src/client.ts`'s own main-thread path is this module's one
// production caller (M29/step 5 wires that call site).

const STORAGE_KEY = 'engine.playerSecret'
const SECRET_LEN = 16

/** Lowercase hex, `TerrainConfig.secret`'s own shape (`game_instance.rs`): `src/client.ts`'s
 * step-5 call site needs this to build the linked client worker's own `game` config, and this
 * module is the one place that already owns the encode/decode pair for `STORAGE_KEY`. */
export function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += b < 16 ? `0${b.toString(16)}` : b.toString(16)
  }
  return out
}

function hexDecode(hex: string): Uint8Array | null {
  if (hex.length !== SECRET_LEN * 2) return null
  const out = new Uint8Array(SECRET_LEN)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[i] = byte
  }
  return out
}

/** On first run, mints a 128-bit secret (`crypto.getRandomValues`, 0013 Decision) and keeps it in
 * `localStorage` under `engine.playerSecret`, one per origin; every later call returns the same
 * bytes. A stored value that fails to parse (evicted/corrupted storage, 0013 Consequences: "the
 * player returns as a new player") is treated the same as no stored value -- a fresh secret is
 * minted and saved over it. */
export function loadOrMintSecret(): Uint8Array {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    const decoded = hexDecode(stored)
    if (decoded) return decoded
  }
  const fresh = new Uint8Array(SECRET_LEN)
  crypto.getRandomValues(fresh)
  localStorage.setItem(STORAGE_KEY, hexEncode(fresh))
  return fresh
}
