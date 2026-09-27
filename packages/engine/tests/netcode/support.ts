// Shared by every `netcode` scenario: `createNetHarness({ fixture: await loadFixture('puts'), ... })`
// against the real `fx-puts` fixture (Consumes: "M16's action fixture and M15's puts fixture,
// unchanged" -- one and the same crate, `on_player(Joined)` puts the player slot every ledger-noted
// ack depends on).
import { RegionId, Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { seedToHexU64 } from '../../src/server.js'
import { loadFixture } from '../support/fixtures.js'

export async function putsFixture(): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  return loadFixture('puts')
}

/** Every scenario prints its own seed on failure (0020 §2); this is the one this file's own
 * callers pass by default when a test does not care about a specific value. */
export const DEFAULT_SEED = 1

export function square(i: number): { x: number; y: number; tilesAcross: number } {
  // Spread clients apart: two clients at the identical position/velocity would otherwise look
  // identical to every *other* client's presence view -- irrelevant noise worth avoiding.
  return { x: i * 40, y: 0, tilesAcross: 20 }
}

function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += b < 16 ? `0${b.toString(16)}` : b.toString(16)
  }
  return out
}

/** docs/plan/28-sessions-and-reconnect.md (`handshake`/`liveness` scenarios): real `client_hello()`
 * bytes off a throwaway `Role.Client` instance -- mirrors `src/test/headless-client.ts`'s own
 * `sendHello`, standalone (no ring/pump machinery) so a scenario testing the handshake parser
 * itself (`version-mismatch`/`bad-key`/`garbage-before-hello`/...) can build a deliberately wrong
 * one and hand it to `harness.connectRaw()` directly. `Hello`'s own wire layout carries no seed or
 * worldgen params (`session::Hello`: magic·version·build_hash · join_key · player_secret ·
 * CameraReport · resume) -- only `secret`/`joinKey`/`buildHash` ever reach the bytes this returns,
 * so the throwaway instance's own `game.seed`/`game.params` are fixed, arbitrary values. */
export function buildHelloBytes(
  wasm: WebAssembly.Module,
  opts: { secret: Uint8Array; joinKey: string; buildHash: Uint8Array },
): Uint8Array {
  const clientConfig = {
    arenaBytes: 48 * 1024 * 1024,
    game: {
      seed: seedToHexU64('1'),
      params: null,
      secret: hexEncode(opts.secret),
      joinKey: opts.joinKey,
      buildHash: hexEncode(opts.buildHash),
    },
  }
  const inst = instantiate(wasm, Role.Client, clientConfig)
  const len = inst.call0(inst.x.client_hello)
  if (len <= 0) throw new Error(`client_hello failed: status ${-len}`)
  const tx = inst.region(RegionId.Tx)
  if (!tx) throw new Error('client_hello: Tx region absent')
  return tx.u8.slice(0, len)
}

/** A fixed, arbitrary 16-byte secret for a scenario that only ever needs *a* valid one (the
 * handshake parser's own error paths, not identity). */
export function fixedSecret(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill)
}
