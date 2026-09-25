// `engine/server/node`: the Node adapter (docs/decisions/0017 §2). M27 extends this file; M35b adds
// the Bun and Deno files.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameJson } from './build-game.js'

export { fsStorage } from './storage/fs.js'

/** Read one `buildGame()` output directory (0017 §4). */
export async function loadGame(
  dir: string,
): Promise<{ wasm: WebAssembly.Module; buildHash: string }> {
  const [bytes, json] = await Promise.all([
    readFile(join(dir, 'game.wasm')),
    readFile(join(dir, 'game.json'), 'utf8'),
  ])
  const { buildHash } = JSON.parse(json) as GameJson
  return { wasm: await WebAssembly.compile(bytes), buildHash }
}
