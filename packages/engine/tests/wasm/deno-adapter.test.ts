// `deno-adapter @slow` (docs/plan/35b-bun-and-deno-adapters.md, Tests added): the scenario behind
// `bun-adapter loopback` (`adapter-loopback.mjs`), run under a real `deno run` with
// `engine/server/deno` on `Deno.serve`. Deno is best-effort (0009 "Targets"): when `deno` is not on
// `PATH` this prints the named warning `deno-missing` and passes, unless `REQUIRE_DENO=1` (CI sets
// it, so the workflow's own Deno install can never silently stop being used).
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { fixtureBuildDir } from '../support/fixtures.js'

const script = fileURLToPath(new URL('./deno-adapter.mjs', import.meta.url))

function denoVersion(): string | null {
  const r = spawnSync('deno', ['--version'], { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout.split('\n')[0] ?? '') : null
}

test('deno-adapter @slow', async () => {
  const version = denoVersion()
  if (version === null) {
    expect(process.env.REQUIRE_DENO, 'REQUIRE_DENO is set but deno is not on PATH').not.toBe('1')
    console.warn('deno-missing: `deno` is not on PATH; the Deno adapter was not run')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'deno-adapter-'))
  try {
    const gameDir = fixtureBuildDir('puts')
    // The narrowest flags that work: the game's own directory and this test's scratch directory
    // (`fsStorage` writes there), loopback only.
    const r = spawnSync(
      'deno',
      [
        'run',
        `--allow-read=${gameDir},${dir}`,
        `--allow-write=${dir}`,
        '--allow-net=127.0.0.1',
        script,
        gameDir,
        join(dir, 'data'),
        join(dir, 'blocked'),
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    // The engine's own `engine_init ok` log can leave the line unterminated: match, don't split.
    const line = /\{"ok":.*\}/.exec(r.stdout)?.[0] ?? ''
    const result = line ? (JSON.parse(line) as { ok: boolean; message: string | null }) : null
    if (result === null)
      throw new Error(`no result line (exit ${r.status}): ${r.stdout} ${r.stderr}`)
    expect(result.message).toBeNull()
    expect(result.ok).toBe(true)
    console.log(`deno-adapter: ${version} passed`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 90_000)
