// Shared by every `netcode` scenario: `createNetHarness({ fixture: await loadFixture('puts'), ... })`
// against the real `fx-puts` fixture (Consumes: "M16's action fixture and M15's puts fixture,
// unchanged" -- one and the same crate, `on_player(Joined)` puts the player slot every ledger-noted
// ack depends on).
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
