// The Bun half of `release-golden @slow` (`release-golden.test.ts`): the same goldens as
// `tests/support/release-golden.ts`, replayed against release builds the Node test has already made.
// Takes one argument, a JSON object of build directories (`GoldenDirs`), and prints one JSON line:
// `{ results: [{ name, ok, message }] }`. Never builds: the Node test owns the cargo calls.
import { instantiate } from '../../dist/loader.js'
import { loadGame } from '../../dist/server-node.js'
import { replayLog } from '../../dist/test.js'
import { runGoldens } from '../support/release-golden.ts'

let out
try {
  if (typeof Bun === 'undefined') throw new Error('not running under Bun')
  const dirs = JSON.parse(process.argv[2] ?? '{}')
  out = { results: await runGoldens({ instantiate, loadGame, replayLog }, dirs) }
} catch (e) {
  out = { results: [{ name: 'release-golden (bun)', ok: false, message: String(e?.stack ?? e) }] }
}
console.log(JSON.stringify(out))
