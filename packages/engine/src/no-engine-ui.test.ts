// 0019 / spec overview FD7: "game UI is a game-owned DOM overlay; the engine renders no UI widgets".
// A source scan in the style of `sab.no_alloc_syntax`: no production file under `src/` builds DOM
// (`createElement`, `innerHTML`, `appendChild`, ...) except two infrastructure files, and each may
// create only the tags listed below. `*.test.ts` is exempt.
//   - `input/page-css.ts`: the page stylesheet and the `viewport` meta tag.
//   - `overlay/anchors.ts`: its stylesheet rule and one zero-size, pointer-transparent layer `div`
//     into which the *game's* elements are appended (`overlay.anchor(el, ...)`).
// Text and markup are never set by the engine: `innerHTML`, `outerHTML`, `createTextNode` and
// `insertAdjacentHTML` are banned everywhere.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield path
  }
}

const BUILDERS =
  /\.(createElement|createElementNS|createDocumentFragment|insertAdjacentElement|replaceChildren|appendChild|insertBefore)\(/
const MARKUP = /\.(createTextNode|insertAdjacentHTML)\(|\.(innerHTML|outerHTML|innerText)\s*=/

const ALLOWED: Record<string, string[]> = {
  'input/page-css.ts': ['meta', 'style'],
  'overlay/anchors.ts': ['div', 'style'],
}

test('no-engine-ui: the engine creates no DOM widgets', () => {
  const offenders: string[] = []
  const created: Record<string, string[]> = {}
  for (const path of walk(SRC)) {
    const rel = path.slice(SRC.length)
    const text = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    if (MARKUP.test(text)) offenders.push(`${rel}: sets text or markup`)
    if (!BUILDERS.test(text)) continue
    if (!(rel in ALLOWED)) {
      offenders.push(`${rel}: builds DOM`)
      continue
    }
    created[rel] = [...text.matchAll(/createElement\('([^']+)'\)/g)]
      .map((m) => m[1] as string)
      .sort()
  }
  expect(offenders, 'the engine must not render UI of its own').toEqual([])
  expect(created['input/page-css.ts']).toEqual(['meta', 'style'])
  expect(created['overlay/anchors.ts']).toEqual(['div', 'style'])
  expect(Object.keys(created).sort()).toEqual(Object.keys(ALLOWED).sort())
})
