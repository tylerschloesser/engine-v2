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

export function readGolden<T>(name: string, file: 'scenario.json' | 'golden.json'): T {
  return JSON.parse(readFileSync(join(root, name, 'golden', file), 'utf8')) as T
}
