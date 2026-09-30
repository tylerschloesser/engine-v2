// `reference_single_player_save_to_server` and `reference_state_budget_full`
// (docs/plan/34b-reference-scripted-single-player.md Tests added), on the reference game's `.wasm`
// under Node: a real `createWorldServer` over memory storage, `HeadlessClient`s, a virtual clock.
//
// - A single-player world (its player joined with a secret, stone in the pocket) is exported, imported
//   into another server's storage, and the same secret reclaims the same player with the same
//   inventory (0005 "Single-player to hosted"; 0013).
// - A world whose `maxEntities` leaves no headroom refuses `PlaceFurnace` with
//   `Rejected(Engine(StateBudgetFull))` and keeps the item (0004 State-budget check).
import { test } from 'vitest'
import { loadGame } from '../../src/server-node.js'
import { deleteWorld, exportWorld, importWorld } from '../../src/storage/archive.js'
import { createNetHarness, worldServerTestHandle } from '../../src/test.js'
import { gameCrateBuildDir } from '../support/fixtures.js'
import { type Deps, saveToServer, stateBudgetFull } from '../support/reference-single-player.js'

// The bodies live in `support/reference-single-player.ts` so the Bun leg runs the same code.
const deps: Deps = {
  loadGame,
  createNetHarness,
  worldServerTestHandle,
  exportWorld,
  importWorld,
  deleteWorld,
  gameDir: gameCrateBuildDir('reference'),
}

test('reference_single_player_save_to_server', () => saveToServer(deps))

test('reference_state_budget_full', () => stateBudgetFull(deps))
