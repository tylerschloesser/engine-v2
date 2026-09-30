// `server adapters export parity` (docs/plan/35b-bun-and-deno-adapters.md): the three `./server/*`
// adapters export parallel names -- `loadGame`, `fsStorage`, `<runtime>HostServices` and one
// attachment function -- so a game's server entry differs between runtimes by import path alone.
// `wsSocketConnection` is the one extra: Node's `ws` transport harness builds on it (M29).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import * as bun from './server-bun.js'
import * as deno from './server-deno.js'
import * as node from './server-node.js'

/** An adapter's exports with its runtime and attachment names replaced by placeholders. */
function shape(ns: object, runtime: string, attach: string): string[] {
  return Object.keys(ns)
    .map((k) =>
      k === `${runtime}HostServices` ? '<runtime>HostServices' : k === attach ? '<attach>' : k,
    )
    .filter((k) => k !== 'wsSocketConnection')
    .sort()
}

test('server adapters export parity', () => {
  const want = ['<attach>', '<runtime>HostServices', 'fsStorage', 'loadGame']
  expect(shape(node, 'node', 'attachWebSocketServer')).toEqual(want)
  expect(shape(bun, 'bun', 'bunHandlers')).toEqual(want)
  expect(shape(deno, 'deno', 'denoHandler')).toEqual(want)
  // The shared implementations really are shared.
  expect(bun.fsStorage).toBe(node.fsStorage)
  expect(deno.loadGame).toBe(node.loadGame)
  expect(bun.bunHostServices).toBe(deno.denoHostServices)
})

test('runtime globals are named only in their own adapter; zero dependencies', () => {
  const src = dirname(fileURLToPath(import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        const text = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '')
        if (/\b(Bun|Deno)\./.test(text) && !['server-bun.ts', 'server-deno.ts'].includes(e.name)) {
          offenders.push(relative(src, full))
        }
      }
    }
  }
  walk(src)
  expect(offenders).toEqual([])
  const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'))
  expect(pkg.dependencies).toEqual({})
})
