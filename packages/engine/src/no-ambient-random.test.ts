// `lint.no_ambient_random` (docs/decisions/0002 §2 "Ambient randomness", docs/plan/03-browser-harness.md
// Seams): `noRestrictedGlobals` cannot name `Math.random` (it is a member, not a global), and banning
// the whole `crypto` global would also ban WebCrypto hashing (M28). So this is a source scan instead.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

const PATTERNS = [/\bMath\.random\b/, /\bgetRandomValues\b/, /\brandomUUID\b/]

/** One documented entry: the device-secret module M28 adds. No other entry without an ADR. */
const ALLOWLIST = new Set(['client/secret.ts'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'test') continue // src/test/** is exempt (Seams)
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield path
  }
}

test('lint.no_ambient_random', () => {
  const offenders: string[] = []
  for (const path of walk(SRC)) {
    const rel = path.slice(SRC.length).replaceAll('\\', '/')
    if (ALLOWLIST.has(rel)) continue
    const text = readFileSync(path, 'utf8')
    for (const pattern of PATTERNS) {
      if (pattern.test(text)) {
        offenders.push(`${rel}: matches ${pattern}`)
        break
      }
    }
  }
  expect(offenders).toEqual([])
})
