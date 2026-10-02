import { expect, test } from 'vitest'
import { negControlTitle } from './titles.ts'

// 0026 §1 (amended by 0043 §1): the `@slow` tag of a generated negative control is a function of the
// page id, the kind and the isolate, and nothing a page can forget.
test('gc titles: burst negatives are @slow for every page but gc-loop', () => {
  expect(negControlTitle('gc-loop', 'burst', 'main')).toBe('gc-loop neg burst main')
  expect(negControlTitle('gc-loop', 'burst', 'sim')).toBe('gc-loop neg burst sim')
  expect(negControlTitle('terrain', 'burst', 'main')).toBe('terrain neg burst main @slow')
  expect(negControlTitle('echo', 'burst', 'net')).toBe('echo neg burst net @slow')
})

test('gc titles: object negatives stay fast, except worker isolates under slowWorkerObjectControls', () => {
  expect(negControlTitle('terrain', 'object', 'main')).toBe('terrain neg object main')
  expect(negControlTitle('gc-loop', 'object', 'sim')).toBe('gc-loop neg object sim')
  expect(negControlTitle('reference_single_player', 'object', 'main', true)).toBe(
    'reference_single_player neg object main',
  )
  expect(negControlTitle('reference_single_player', 'object', 'sim', true)).toBe(
    'reference_single_player neg object sim @slow',
  )
  expect(negControlTitle('reference_single_player', 'burst', 'main', true)).toBe(
    'reference_single_player neg burst main @slow',
  )
})
