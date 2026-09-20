// docs/decisions/0002 §2: `usize`/`isize` may never enter hashed or serialized state (it is not
// portable: 32 bits under wasm32, 64 elsewhere). serde can't police this (a `usize` field arrives
// as a `u64` on the wire, indistinguishable from one that was always `u64`), so it stays a review
// rule, backed by this source scan: a regex scan, not a parser, over every `.rs` file under
// `packages/engine/crates/*/src`, `packages/engine/fixtures/*/src` and `games/*/sim/src`
// (docs/plan/05-codec-and-state-hash.md, Tests added).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Expands one `*` segment (at most one, and only a whole path segment) against real directories. */
function expandGlob(pattern) {
  const segments = pattern.split('/')
  let dirs = ['']
  for (const segment of segments) {
    if (segment === '*') {
      dirs = dirs.flatMap((d) => {
        const base = join(root, d)
        if (!isDir(base)) return []
        return readdirSync(base, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(d, e.name))
      })
    } else {
      dirs = dirs.map((d) => join(d, segment)).filter((d) => isDir(join(root, d)))
    }
  }
  return dirs.map((d) => join(root, d))
}

function rsFilesUnder(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...rsFilesUnder(p))
    else if (e.name.endsWith('.rs')) out.push(p)
  }
  return out
}

const ATTR_OR_DOC = /^\s*(#\[.*\]|\/\/\/.*|\/\/!.*|)\s*$/
const TYPE_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+(\w+)/
const DERIVE_SERIALIZE = /derive\s*\([^)]*\b(Serialize|Codec)\b[^)]*\)/

/** `{name, kind}` for every `struct`/`enum` in `text` whose immediately preceding attribute lines
 * derive `Serialize` or `Codec` and whose body (to the matching `}` or the `;` of a tuple/unit
 * type) names `usize` or `isize`. */
function usizeViolationsInFile(text) {
  const lines = text.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const decl = TYPE_DECL.exec(lines[i])
    if (!decl) continue
    let j = i - 1
    let derives = false
    while (j >= 0 && ATTR_OR_DOC.test(lines[j])) {
      if (DERIVE_SERIALIZE.test(lines[j])) derives = true
      j--
    }
    if (!derives) continue

    const declOffset = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0)
    const from = declOffset + decl[0].length
    const brace = text.indexOf('{', from)
    const semi = text.indexOf(';', from)
    let body
    if (brace !== -1 && (semi === -1 || brace < semi)) {
      let depth = 0
      let k = brace
      for (; k < text.length; k++) {
        if (text[k] === '{') depth++
        else if (text[k] === '}' && --depth === 0) {
          k++
          break
        }
      }
      body = text.slice(brace, k)
    } else {
      body = text.slice(from, semi === -1 ? text.length : semi)
    }

    if (/\b(usize|isize)\b/.test(body)) {
      violations.push({ kind: decl[1], name: decl[2] })
    }
  }
  return violations
}

describe('no_usize_in_serialized_types', () => {
  test('detects usize/isize in a derived Serialize or Codec type', () => {
    const bad = usizeViolationsInFile(
      '#[derive(serde::Serialize)]\nstruct Bad {\n    n: usize,\n}\n',
    )
    expect(bad).toEqual([{ kind: 'struct', name: 'Bad' }])

    const badCodec = usizeViolationsInFile('#[derive(Codec)]\nenum BadEnum {\n    A(isize),\n}\n')
    expect(badCodec).toEqual([{ kind: 'enum', name: 'BadEnum' }])
  })

  test('ignores usize outside a derived Serialize/Codec type, and non-usize fields', () => {
    expect(usizeViolationsInFile('struct Plain {\n    n: usize,\n}\n')).toEqual([])
    expect(
      usizeViolationsInFile('#[derive(Clone)]\nstruct NotSerialized {\n    n: usize,\n}\n'),
    ).toEqual([])
    expect(
      usizeViolationsInFile(
        '/// doc\n#[derive(serde::Serialize)]\nstruct Fine {\n    n: u32,\n}\n',
      ),
    ).toEqual([])
    // A tuple struct's body ends at `;`, not the next type's braces.
    expect(
      usizeViolationsInFile(
        '#[derive(serde::Serialize)]\nstruct Id(u32);\nstruct Other {\n    n: usize,\n}\n',
      ),
    ).toEqual([])
  })

  test('the repo has no usize/isize in a derived Serialize or Codec type', () => {
    const dirs = [
      ...expandGlob('packages/engine/crates/*/src'),
      ...expandGlob('packages/engine/fixtures/*/src'),
      ...expandGlob('games/*/sim/src'),
    ]
    const violations = dirs.flatMap((dir) =>
      rsFilesUnder(dir).flatMap((file) =>
        usizeViolationsInFile(readFileSync(file, 'utf8')).map(
          (v) => `${file.slice(root.length + 1)}: ${v.kind} ${v.name}`,
        ),
      ),
    )
    expect(violations).toEqual([])
  })
})
