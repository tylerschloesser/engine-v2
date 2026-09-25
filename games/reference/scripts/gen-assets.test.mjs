// `gen_assets_reproducible` (docs/plan/20-reference-game-v0.md Tests added): runs `gen-assets.mjs`
// twice into a fresh temp dir, asserts the bytes equal the committed `assets/` files, and checks
// the generated `tiles.json` obeys 0018 §4's limits.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./gen-assets.mjs', import.meta.url))
const COMMITTED_DIR = fileURLToPath(new URL('../assets/', import.meta.url))
const FILES = ['tiles.png', 'tiles.json', 'sprites.png', 'sprites.json']

function runInto(dir) {
  execFileSync(process.execPath, [SCRIPT, '--out', dir], { stdio: 'pipe' })
}

describe('gen-assets.mjs', () => {
  test('gen_assets_reproducible', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'ref-assets-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'ref-assets-b-'))
    try {
      runInto(dirA)
      runInto(dirB)
      for (const name of FILES) {
        const a = readFileSync(join(dirA, name))
        const b = readFileSync(join(dirB, name))
        expect(a.equals(b), `${name}: two runs produced different bytes`).toBe(true)
        const committed = readFileSync(join(COMMITTED_DIR, name))
        expect(a.equals(committed), `${name}: committed bytes are stale`).toBe(true)
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  test('tiles.json obeys the 0018 §4 limits', () => {
    const manifest = JSON.parse(readFileSync(join(COMMITTED_DIR, 'tiles.json'), 'utf8'))
    const ids = Object.keys(manifest.visuals)
    expect(ids.length).toBeLessThanOrEqual(1024) // MAX_VISUALS
    let maxCell = 0
    for (const v of Object.values(manifest.visuals)) {
      maxCell = Math.max(maxCell, v.first + v.variants)
    }
    expect(maxCell).toBeLessThanOrEqual(256) // MAX_CELLS
  })
})
