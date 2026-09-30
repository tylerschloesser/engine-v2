// Mode selection (docs/plan/34-reference-multiplayer.md Scope): an invite in the URL fragment
// (`#k=<joinKey>`, `readInvite`) means "play on the server this page was served with"; without one
// the page runs a world of its own in this browser. Kept apart from `main.ts` so a test entry and a
// DOM-free unit test can call it.
import type { ClientOptions } from 'engine'
import { readInvite, wsUrl } from 'engine'
import world from '../world.json' with { type: 'json' }

export type Host = ClientOptions['host']

/** The one declared default world (`world.json`), shared with `games/reference-server`. */
export const DEFAULT_WORLD = { seed: world.seed, worldgen: world.worldgen }

/**
 * `{ kind: 'remote' }` when the fragment carries a join key (`#k=`, empty for an open server), else
 * the local host. A remote page passes no world: the client takes it from `Welcome` (ADR 0042), so
 * nothing is drawn and no `Ui` arrives until then. `serverUrl` overrides `wsUrl(location)` for a
 * test whose server is on another port.
 */
export function selectHost(
  location: { hash: string; protocol: string; host: string },
  serverUrl?: string,
  local: { persist?: boolean; worldId?: string; params?: { maxEntities?: number } } = {},
): Host {
  const { joinKey } = readInvite(location)
  if (joinKey === undefined) {
    return {
      kind: 'local',
      world: {
        worldId: local.worldId ?? 'reference',
        params: { ...DEFAULT_WORLD, ...local.params },
      },
      connect: true,
      // The world survives a reload (M23, `host.persist`): the production page turns it on, a test
      // page only when it asks (`?persist`), so the specs that do not test storage start as before.
      ...(local.persist ? { persist: true } : {}),
    }
  }
  return { kind: 'remote', url: serverUrl ?? wsUrl(location), joinKey }
}
