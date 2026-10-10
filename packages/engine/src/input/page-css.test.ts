// The page-CSS helper's viewport meta (M39h and the static tag on every
// fixture page served to a phone: without `width=device-width` a phone lays out at 980 CSS px.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { installPageStyles } from './page-css.js'

function run(existing: string | null): string {
  const metas: { name: string; content: string }[] = []
  if (existing !== null) metas.push({ name: 'viewport', content: existing })
  const doc = {
    getElementById: () => null,
    createElement: (tag: string) => (tag === 'meta' ? { name: '', content: '' } : { remove() {} }),
    querySelector: () => metas[0] ?? null,
    head: {
      appendChild: (el: { name?: string; content?: string }) => {
        if (el.name === 'viewport') metas.push(el as { name: string; content: string })
      },
    },
  }
  installPageStyles(doc as unknown as Document)
  return metas[0]?.content ?? ''
}

test('page css viewport: no meta inserts the full content', () => {
  expect(run(null)).toBe('width=device-width, initial-scale=1, viewport-fit=cover')
})

test('page css viewport: a meta with only viewport-fit gets width and scale', () => {
  const c = run('viewport-fit=cover')
  expect(c).toContain('width=device-width')
  expect(c).toContain('initial-scale=1')
  expect(c.match(/viewport-fit/g)).toHaveLength(1)
})

test('page css viewport: an existing width is kept and no zoom lock is added', () => {
  const c = run('width=500')
  expect(c).toContain('width=500')
  expect(c).not.toContain('device-width')
  expect(c).toContain('viewport-fit=cover')
  expect(c).not.toMatch(/user-scalable|maximum-scale/)
})

const PAGES = [
  'device',
  'slice',
  'world',
  'mp',
  'determinism',
  'worldgen-bench',
  'opfs-latency',
] as const

test.each(PAGES)('page viewport meta: %s.html declares width=device-width', (name) => {
  const url = new URL(`../../tests/browser/pages/${name}.html`, import.meta.url)
  const html = readFileSync(fileURLToPath(url), 'utf8')
  const tag = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(html)
  expect(tag?.[1] ?? '').toContain('width=device-width')
})
