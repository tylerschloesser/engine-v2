// `bun-liveness @slow` (ADR 0044 Consequences 1): under the pinned Bun a process survives past 10 s
// after a `WebAssembly.compile`. Bun 1.3.8 on macOS was killed with SIGTRAP (exit 133) about 10 s
// after any compile, even of an empty module, which would have taken `start:bun` down while the
// fast tier stayed green (the Bun leg of `pnpm test wasm` lives a few seconds). This compiles the
// empty module, idles 15 s on a timer, and expects exit 0. Slow tier, so the 15 s never reaches the
// fast budget. When `bun` is not on `PATH` it prints the named warning `bun-missing` and passes,
// unless `REQUIRE_BUN=1`, as `deno-adapter @slow` does for Deno.
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

const IDLE_MS = 15_000
const script = `
  const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  await WebAssembly.compile(empty)
  setTimeout(() => {
    console.log('bun-liveness: alive')
    process.exit(0)
  }, ${IDLE_MS})
`

test('bun-liveness @slow', () => {
  const version = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (version.status !== 0) {
    expect(process.env.REQUIRE_BUN, 'REQUIRE_BUN is set but bun is not on PATH').not.toBe('1')
    console.warn('bun-missing: `bun` is not on PATH; the Bun liveness check was not run')
    return
  }
  const r = spawnSync('bun', ['-e', script], { encoding: 'utf8', timeout: 45_000 })
  expect(r.signal, `killed by ${r.signal}: ${r.stderr}`).toBeNull()
  expect(r.status, `exit ${r.status}: ${r.stdout} ${r.stderr}`).toBe(0)
  expect(r.stdout).toContain('bun-liveness: alive')
}, 60_000)
