// Spec sync R3d: "the game writes no delta types and no separate prediction or interpolation
// logic". Two source scans, one per side of the boundary:
//   - the engine's `Game` trait offers a game no delta, prediction or interpolation seam: its
//     associated types are exactly the nine game data types, and the only prediction hook is the
//     per-action opt-out `fn predict(&Action) -> bool` (0012);
//   - the reference game's sim code (`games/reference/sim/src`, comments stripped) defines no
//     type or function that names deltas, prediction state, interpolation or reconciliation.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

function* rustFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* rustFiles(path)
    else if (entry.name.endsWith('.rs')) yield path
  }
}

test('game-sync-surface: the game writes no delta types and no prediction or interpolation logic', () => {
  const gameRs = stripComments(
    readFileSync(join(root, 'packages/engine/crates/engine/src/game.rs'), 'utf8'),
  )
  const start = gameRs.indexOf('pub trait Game')
  expect(start).toBeGreaterThan(-1)
  // The trait body: from its opening brace to the matching close.
  let depth = 0
  let end = gameRs.indexOf('{', start)
  for (let i = end; i < gameRs.length; i++) {
    if (gameRs[i] === '{') depth++
    else if (gameRs[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = gameRs.slice(start, end)
  const types = [...body.matchAll(/^\s*type\s+(\w+)\s*:/gm)].map((m) => m[1]).sort()
  expect(types).toEqual(
    [
      'Action',
      'Client',
      'Entity',
      'Global',
      'Player',
      'Presence',
      'Reject',
      'Ui',
      'Worldgen',
    ].sort(),
  )
  const fns = [...body.matchAll(/^\s*fn\s+(\w+)/gm)].map((m) => m[1])
  expect(fns.filter((f) => /predict|interp|delta|reconcil|rollback/i.test(f))).toEqual(['predict'])
  expect(body).toMatch(/fn predict\(_a: &Self::Action\) -> bool/)

  const offenders = []
  const dir = join(root, 'games/reference/sim/src')
  for (const path of rustFiles(dir)) {
    const code = stripComments(readFileSync(path, 'utf8'))
    for (const m of code.matchAll(
      /\b(?:struct|enum|trait|type|fn|mod)\s+(\w*(?:Delta|delta|[Ii]nterpolat|[Ee]xtrapolat|[Rr]econcil|[Rr]ollback|Predicted?State|[Pp]redict_)\w*)/g,
    )) {
      // `fn predict` itself is the engine's opt-out hook (0012), implemented once by the game.
      offenders.push(`${path.slice(dir.length + 1)}: ${m[1]}`)
    }
  }
  expect(
    offenders,
    'the reference game must leave deltas, prediction and interpolation to the engine',
  ).toEqual([])
})
