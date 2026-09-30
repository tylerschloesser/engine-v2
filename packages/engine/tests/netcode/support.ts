// Shared by every `netcode` scenario: `createNetHarness({ fixture: await loadFixture('puts'), ... })`
// against the real `fx-puts` fixture (Consumes: "M16's action fixture and M15's puts fixture,
// unchanged" -- one and the same crate, `on_player(Joined)` puts the player slot every ledger-noted
// ack depends on).
import { RegionId, Role } from '../../src/abi.js'
import { instantiate } from '../../src/loader.js'
import { seedToHexU64 } from '../../src/server.js'
import { createNetHarness, type NetHarness } from '../../src/test/net-harness.js'
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

/** A `fx-busy-field` world whose chunks `cx0..=cx1` x `cy0..=cy1` are dense (`Action::Fill`, 200
 * entities and 160 modified tiles each, ~4 KB on the wire, docs/plan/31-rates-and-integrity.md),
 * filled by client 0 while every client sits far away at `(FAR, FAR)`. */
export const DENSE_FAR = -3000
export async function denseWorld(
  seed: number,
  clients: number,
  region: { cx0: number; cx1: number; cy0: number; cy1: number } = {
    cx0: 40,
    cx1: 50,
    cy0: 40,
    cy1: 50,
  },
  maxChunks?: number,
): Promise<NetHarness> {
  const chunks = (region.cx1 - region.cx0 + 1) * (region.cy1 - region.cy0 + 1)
  const h = await createNetHarness({
    fixture: await loadFixture('busy-field'),
    seed,
    clients,
    // The filler dispatches a Fill per tick or more: past the default 20/s action limit (0004).
    world: {
      params: { maxEntities: chunks * 200 + 4_000, maxActionGrowth: 65_536 },
      actionRate: { perSecond: 20_000, burst: 2_000 },
      ...(maxChunks !== undefined ? { view: { maxChunks } } : {}),
    },
  })
  for (const c of h.clients) c.setView({ x: DENSE_FAR, y: DENSE_FAR, halfW: 1, halfH: 1 })
  await h.advanceTicks(5)
  const filler = h.clients[0]
  if (!filler) throw new Error('no filler')
  let n = 0
  for (let cy = region.cy0; cy <= region.cy1; cy++) {
    for (let cx = region.cx0; cx <= region.cx1; cx++) {
      filler.dispatch({ Fill: { cx, cy } })
      if (++n % 24 === 0) await h.advanceTicks(6)
    }
  }
  await h.advanceTicks(30)
  return h
}

/** The most downlink bytes any 20 consecutive ticks (1 s) carried to client `i`, counting only
 * windows that start after host tick `fromTick` (the initial burst is a separate 0010 row). */
export function worstSecondAfter(h: NetHarness, i: number, fromTick: number): number {
  const perTick = new Map(h.counters(i).perTick.map((r) => [r.tick, r.bytesDown]))
  let worst = 0
  for (let t = fromTick + 1; t + 20 <= h.hostTick(); t++) {
    let sum = 0
    for (let k = 0; k < 20; k++) sum += perTick.get(t + k) ?? 0
    worst = Math.max(worst, sum)
  }
  return worst
}
