// Fixture game crates: `packages/engine/fixtures/<name>/`. The `fixtures` build step of `pnpm test`
// has already run `buildGame()` on each (dev profile) by the time a test asks for one.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGame } from '../../src/server-node.js'

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url))

/** Every fixture, so a boundary test covers a new one as soon as its directory exists. */
export function fixtureNames(): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

export function fixtureDir(name: string): string {
  return join(root, name)
}

/** The `buildGame()` output directory of the dev profile. */
export function fixtureBuildDir(name: string): string {
  return join(root, name, 'target', 'engine', 'dev')
}

export function loadFixture(
  name: string,
): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  return loadGame(fixtureBuildDir(name))
}

export function fixtureBytes(name: string): Uint8Array<ArrayBuffer> {
  return readFileSync(join(fixtureBuildDir(name), 'game.wasm'))
}

/** `file` is normally `'scenario.json'`/`'golden.json'`, but a fixture may keep a second scenario
 * beside its canonical one (docs/plan/15b-ring-connection-and-replica-rendering.md, Orchestrator
 * ruling 1: "the connected scenario gets its own new golden ... beside `puts_idle_100`, not a
 * change to it") -- `scripts/golden.mjs`'s own naming convention is `scenario<suffix>.json` /
 * `golden<suffix>.json`, so this stays a plain `string` rather than a literal union that would
 * need editing for every such pair. */
export function readGolden<T>(name: string, file: string): T {
  return JSON.parse(readFileSync(join(root, name, 'golden', file), 'utf8')) as T
}
