// M56: the TypeScript half of the layout pins. `LAYOUT_HASHES` is `scenarios.rs`'s table
// (`layout_hashes_pinned`): each layout's placement count and FNV-1a 64 over its placements, so
// `layout.ts`'s parser and `common/layout.rs`'s agree on every layout; a change to a layout or to
// either parser moves both pins in one commit.

import { expect, test } from 'vitest'
import { LAYOUTS, type LayoutName, layoutHash, parseLayout } from '../helpers/layout.js'

const LAYOUT_HASHES: Record<LayoutName, [number, string]> = {
  balancer: [27, '129636a935505c45'],
  'balancer-blocked': [27, '028d55106c9ba967'],
  ring: [20, '0b03a1f04b1afa2f'],
  'ring-fed': [22, '9306dc06600ec9d0'],
  'ring-splitter': [23, '645be27010f550c8'],
  'sideload-chain': [33, 'eeab0d8d66c48a95'],
  // M57: the bench page's belt field (`bench_belts.rs`'s `bench_field_layout_pinned`).
  'bench-field': [12_264, '634de43a74348615'],
}

test('layout_hashes_match_rust', () => {
  const got = Object.fromEntries(
    Object.entries(LAYOUTS).map(([name, text]) => {
      const l = parseLayout(text)
      return [name, [l.placements.length, layoutHash(l)]]
    }),
  )
  expect(got, 'placements and hash per layout').toEqual(LAYOUT_HASHES)
})

test('layout_parse_rejects_a_stray_splitter_tile', () => {
  expect(() => parseLayout('b> --')).toThrow('not the splitters')
  expect(() => parseLayout('S^ ..')).toThrow('not the splitters')
  expect(() => parseLayout('b> b>\nb>')).toThrow('ragged')
})

// The parsers' shared edges (`layout_parse_edges` in `scenarios.rs`): empty text is refused, one
// trailing newline and `\r\n` endings parse as the plain text does.
test('layout_parse_edges', () => {
  expect(() => parseLayout('')).toThrow('an empty layout')
  const plain = layoutHash(parseLayout('b> bv\nb^ b<'))
  expect(layoutHash(parseLayout('b> bv\r\nb^ b<\n')), 'CRLF and a trailing newline').toBe(plain)
  expect(plain, 'the same hash as Rust').toBe('7ec6d53561604295')
})
