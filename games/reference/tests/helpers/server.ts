// `startReferenceServer` (M34 Provides): `startTestServer` (M29,
// a real `createWorldServer` and a real `ws` server on a loopback port) running the reference game
// with the reference world (`world.json`). The one place this package's tests reach into
// `packages/engine/tests/`: a second copy of the server would be a second thing to keep honest.
//
// The game is the `reference` build step's own release build: the page bundles that `.wasm`, and the
// handshake needs both sides to carry the same build hash.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  startTestServer,
  type TestServer,
} from '../../../../packages/engine/tests/browser/support/test-server.js'

const GAME_DIR = fileURLToPath(new URL('../../sim/target/engine/release', import.meta.url))
const WORLD = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../world.json', import.meta.url)), 'utf8'),
) as { seed: string; worldgen: unknown }

export type ReferenceServer = TestServer

export type StartReferenceServerOptions = {
  /** Overrides `world.json`'s seed. */
  seed?: string
  joinKey?: string
  maxPlayers?: number
  /** Always `true` today: the test drives every tick (`stepTick`). */
  manualTimer: true
}

export function startReferenceServer(opts: StartReferenceServerOptions): Promise<ReferenceServer> {
  return startTestServer({
    fixture: GAME_DIR,
    manualTimer: opts.manualTimer,
    worldId: 'reference-test',
    params: { seed: opts.seed ?? WORLD.seed, worldgen: WORLD.worldgen },
    ...(opts.joinKey !== undefined ? { joinKey: opts.joinKey } : {}),
    ...(opts.maxPlayers !== undefined ? { maxPlayers: opts.maxPlayers } : {}),
  })
}

/**
 * Ticks `server` until every page's client is configured from its `Welcome` (the handshake completes
 * across host ticks, so a page cannot get there on its own). `untilConfigured` is also what makes
 * the gen workers exist: call it before anything that parks workers or expects terrain.
 */
export async function untilConfigured(
  server: ReferenceServer,
  pages: Array<{ evaluate: <R>(fn: () => Promise<R>) => Promise<R> }>,
): Promise<void> {
  const timer = setInterval(() => server.stepTick(), 5)
  try {
    await Promise.all(
      pages.map((p) => p.evaluate(() => window.__untilConfigured?.() as Promise<void>)),
    )
  } finally {
    clearInterval(timer)
  }
}
