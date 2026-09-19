// Permanent check of the context files of docs/decisions/0021 (§1, §4, Consequences) and 0025 §2:
// the only test a milestone needs for the nested CLAUDE.md, rule, skill and agent files it creates.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const MAX_LINES = 60

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f && !f.startsWith('spikes/') && !f.startsWith('docs/'))

const read = (file) => {
  try {
    return readFileSync(`${root}/${file}`, 'utf8')
  } catch {
    return null // listed by git but deleted in the working tree
  }
}
const lineCount = (text) => text.trimEnd().split('\n').length

/** The `---` block at the top of a file, or null. */
function frontmatter(text) {
  return /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? null
}

/** `paths:` as a YAML list, an inline `[a, b]`, or a comma-separated string. */
function pathGlobs(fm) {
  const m = /^paths:[ \t]*(.*)\n?((?:[ \t]+-.*\n?)*)/m.exec(fm)
  if (!m) return null
  const items = m[1].trim()
    ? m[1].replace(/^\[|\]$/g, '').split(',')
    : m[2].split('\n').map((l) => l.replace(/^\s*-\s*/, ''))
  return items.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Glob to RegExp: `**`, `*`, `?`, `{a,b}` (alternatives are literal text). */
function globToRegExp(glob) {
  // One pass, so that the regex syntax a token expands to is never rescanned as glob syntax.
  const tokens = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' }
  const body = glob.replace(/\*\*\/|\*\*|\*|\?|\{[^}]*\}|[.+^$()|[\]\\]/g, (t) => {
    if (t in tokens) return tokens[t]
    if (t.startsWith('{')) return `(?:${t.slice(1, -1).split(',').map(escapeRegExp).join('|')})`
    return `\\${t}`
  })
  return new RegExp(`^${body}$`)
}

describe('context-artifacts', () => {
  test('glob matcher', () => {
    expect(globToRegExp('packages/**/*.rs').test('packages/engine/crates/engine/src/lib.rs')).toBe(
      true,
    )
    expect(globToRegExp('packages/*/src/**').test('packages/engine/src/a/b.ts')).toBe(true)
    expect(globToRegExp('scripts/*.{mjs,ts}').test('scripts/test.mjs')).toBe(true)
    expect(globToRegExp('scripts/*.mjs').test('scripts/lib/run.mjs')).toBe(false)
  })

  test('every CLAUDE.md is within the line cap', () => {
    const tooLong = files
      .filter((f) => f === 'CLAUDE.md' || f.endsWith('/CLAUDE.md'))
      .map((f) => [f, read(f)])
      .filter(([, text]) => text !== null && lineCount(text) > MAX_LINES)
      .map(([f, text]) => `${f}: ${lineCount(text)} lines, cap ${MAX_LINES}`)
    expect(tooLong, tooLong.join('\n')).toEqual([])
  })

  test('every rule file has paths: globs that match a file, and root CLAUDE.md names it', () => {
    const rootMap = read('CLAUDE.md') ?? ''
    const problems = []
    for (const rule of files.filter((f) => /^\.claude\/rules\/[^/]+\.md$/.test(f))) {
      const text = read(rule)
      if (text === null) continue
      const globs = pathGlobs(frontmatter(text) ?? '')
      if (!globs?.length) problems.push(`${rule}: no paths: frontmatter`)
      for (const glob of globs ?? []) {
        const re = globToRegExp(glob)
        if (!files.some((f) => re.test(f))) problems.push(`${rule}: glob ${glob} matches no file`)
      }
      if (!rootMap.includes(rule)) problems.push(`CLAUDE.md does not name ${rule}`)
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  test('every skill has name and description frontmatter', () => {
    const problems = []
    for (const skill of files.filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f))) {
      const text = read(skill)
      if (text === null) continue
      const fm = frontmatter(text) ?? ''
      for (const key of ['name', 'description']) {
        if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(fm)) problems.push(`${skill}: no ${key}`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  // docs/decisions/0025 §2: the model is the reason a custom agent exists, so it must be stated.
  test('every custom agent has name, description and model frontmatter', () => {
    const problems = []
    for (const agent of files.filter((f) => /^\.claude\/agents\/[^/]+\.md$/.test(f))) {
      const text = read(agent)
      if (text === null) continue
      const fm = frontmatter(text) ?? ''
      for (const key of ['name', 'description', 'model']) {
        if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(fm)) problems.push(`${agent}: no ${key}`)
      }
      const name = /^name:\s*(\S+)/m.exec(fm)?.[1]
      if (name && agent !== `.claude/agents/${name}.md`) {
        problems.push(`${agent}: name ${name} does not match the file name`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })
})
