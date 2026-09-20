// `pnpm golden:bytes [-- <nextest filter>]`: the only writer of the native byte-format goldens
// (`tests/golden/<name>.hex` / `.hash`, docs/plan/05-codec-and-state-hash.md Planning decisions
// 6). Runs the workspace's Rust tests with `GOLDEN_BLESS=1`, under which
// `assert_golden_bytes!`/`assert_golden_hash!` write instead of compare. Review the diff: a
// changed golden is changed wire bytes, same discipline as `pnpm golden` (docs/decisions/0020 §5).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { toolEnv } from './lib/env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const filter = process.argv.slice(2)

const { status } = spawnSync('cargo', ['nextest', 'run', '--workspace', ...filter], {
  cwd: root,
  env: { ...toolEnv(), GOLDEN_BLESS: '1' },
  stdio: 'inherit',
})

process.exit(status ?? 1)
