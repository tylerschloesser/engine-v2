// Vectors: http://www.isthe.com/chongo/tech/comp/fnv/ (FNV-1a, 64-bit); the same three vectors
// `crates/engine/src/hash.rs`'s `fnv64_vectors` checks natively.
import { expect, test } from 'vitest'
import { fnv1a64Hex } from './fnv.js'

test('fnv1a64Hex vectors', () => {
  expect(fnv1a64Hex(new Uint8Array())).toBe('cbf29ce484222325')
  expect(fnv1a64Hex(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c')
  expect(fnv1a64Hex(new TextEncoder().encode('foobar'))).toBe('85944171f73967e8')
})
