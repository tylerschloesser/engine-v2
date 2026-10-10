// Which `dist/*.js` files a set of exports-map subpaths reach (M35,
// size test): relative `import`/`export ... from` specifiers plus `new URL('./x.js', import.meta.url)`
// (how `client.js` reaches `worker-auto.js`). Comments are stripped first: a specifier in prose is not
// an edge.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))

const IMPORT_SPEC = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g
const URL_SPEC = /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** `packages/engine`-relative paths (`dist/client.js`) of every `.js` file reachable from `entries`. */
export function reachableDist(entries: string[]): string[] {
  const seen = new Set<string>()
  const stack = [...entries]
  while (stack.length > 0) {
    const rel = stack.pop()
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const text = stripComments(readFileSync(`${ENGINE_DIR}${rel}`, 'utf8'))
    for (const re of [IMPORT_SPEC, URL_SPEC]) {
      for (const m of text.matchAll(re)) {
        stack.push(new URL(m[1] as string, `file:///${rel}`).pathname.slice(1))
      }
    }
  }
  return [...seen].sort()
}

/** `default` of every subpath of `package.json` except `engine/test` (never shipped), as `dist/x.js`. */
export function productionEntries(): string[] {
  const pkg = JSON.parse(readFileSync(`${ENGINE_DIR}package.json`, 'utf8')) as {
    exports: Record<string, string | { default?: string }>
  }
  const entries: string[] = []
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (sub === './test' || typeof target === 'string' || !target.default) continue
    entries.push(target.default.replace(/^\.\//, ''))
  }
  return entries
}
