// `pnpm device:walk --auto` and `--wait` as another session uses them (M39f
// step 13, "Tracker integration"): the real command line is started as a child process (loopback, no tunnel,
// the fixture build the `pages` step made), `--status --json` is polled for the join URL, a fake phone scans
// it, a `--wait` child blocks until the round is done, and the apply of the result is dry-run on a scratch
// copy of device-checks.md. What a headless engine cannot do is simulated as in the other walk specs (the
// phone is a Playwright page). All `@slow @webkit-gpu`.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { copyPristineChecks } from '../../../../scripts/lib/device-walk/test-checks.mjs'
import { fake } from './support/walk-rig.js'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
type Status = {
  state: string
  reason: string | null
  joinUrl: string | null
  monitorUrl: string | null
  phone: { connected: boolean; lastSeen: string | null }
  current: { id: string } | null
  humanPending: string[]
  remaining: string[]
  counts: Record<string, number>
  items: {
    id: string
    result: string | null
    by?: string
    criteria?: unknown[]
    evidence?: string
    attempts?: unknown[]
  }[]
}

function rig(ids: string[], round: string) {
  const dir = mkdtempSync(join(tmpdir(), 'walk-cli-'))
  const checks = join(dir, 'device-checks.md')
  // Pristine (M39ad): live --apply rounds tick rows (M03-determinism among them) this test applies afresh.
  copyPristineChecks(join(repo, 'docs/plan/device-checks.md'), checks)
  mkdirSync(join(dir, 'rounds'))
  // Bases 100 apart per test; a project's own 5000 up (chromium and webkit run at once).
  const base =
    (test.info().project.name === 'chromium' ? 17000 : 22000) + test.info().parallelIndex * 20
  const common = [
    '--checks',
    checks,
    '--rounds-dir',
    join(dir, 'rounds'),
    '--series-dir',
    join(dir, 'series'),
  ]
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(repo, 'scripts/device-walk.mjs'), ...common, ...args], {
      encoding: 'utf8',
    })
  const status = () => JSON.parse(cli('--status', round, '--json').stdout) as Status
  const children: ChildProcess[] = []
  const spawnCli = (args: string[]) => {
    const c = spawn(process.execPath, [join(repo, 'scripts/device-walk.mjs'), ...common, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    c.stdout?.on('data', (d) => (out += d))
    c.stderr?.on('data', (d) => (out += d))
    children.push(c)
    const exited = new Promise<number | null>((r) => c.once('exit', (code) => r(code)))
    return { c, exited, out: () => out }
  }
  const auto = spawnCli([
    '--auto',
    '--round',
    round,
    '--only',
    ids.join(','),
    '--no-tunnel',
    '--no-open',
    '--no-build',
    '--base-port',
    String(base),
    '--params',
    JSON.stringify({ probeMs: 600 }),
  ])
  const joinUrl = async () => {
    const t0 = Date.now()
    for (;;) {
      const s = existsSync(join(dir, 'rounds', `${round}.jsonl`)) ? status() : null
      if (s?.joinUrl) return s
      if (Date.now() - t0 > 120_000) throw new Error(`no join URL:\n${auto.out()}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return { dir, checks, cli, status, spawnCli, auto, joinUrl, children, round }
}

test('walk-cli: --auto prints the QR, --status --json says waiting-for-phone with the join URL, --wait returns when a fake phone has walked the round, apply dry-runs @slow @webkit-gpu', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const ids = ['M03-determinism', 'M11-boot', 'M35-capability']
  const r = rig(ids, 'cli')
  try {
    const before = await r.joinUrl()
    expect(before).toMatchObject({
      state: 'waiting-for-phone',
      phone: { connected: false, lastSeen: null },
    })
    expect(before.monitorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    // The retired check is recorded at the start: no open row waits for a phone that will never walk it.
    expect(before.remaining).toEqual(['M03-determinism', 'M11-boot'])
    expect(readFileSync(join(r.dir, 'series', 'qr.svg'), 'utf8')).toContain('<svg')
    await expect.poll(() => r.auto.out(), { timeout: 10_000 }).toContain(before.joinUrl as string)
    const monitor = await (await fetch(`${before.monitorUrl}api/status`)).json()
    expect(monitor.state).toBe('waiting-for-phone')

    const wait = r.spawnCli(['--wait', 'cli', '--timeout', '200', '--json'])
    const f = await fake()
    await f.walkAsPhone(page, {
      runnerUrl: before.joinUrl,
      isDone: () => wait.c.exitCode !== null,
      timeoutMs: 200_000,
    })
    expect(await wait.exited).toBe(0)
    const out = wait.out()
    const final = JSON.parse(out.slice(out.indexOf('\n{\n') + 1)) as Status
    expect(final.state).toBe('done')
    expect(final.remaining).toEqual([])
    const by = Object.fromEntries(final.items.map((i) => [i.id, [i.result, i.by]]))
    expect(by['M03-determinism']).toEqual(['pass', 'auto'])
    expect(by['M11-boot']).toEqual(['pass', 'auto'])
    expect(by['M35-capability']).toEqual(['skip', 'auto'])
    const m03 = final.items.find((i) => i.id === 'M03-determinism')
    expect(m03?.criteria?.length).toBeGreaterThan(0)
    expect(m03?.evidence).toMatch(/M03-determinism-1\.json$/)
    expect(m03?.attempts).toHaveLength(1)
    // The tool exits by itself, 0, and has stopped its servers.
    expect(await r.auto.exited).toBe(0)
    const after = r.status()
    expect(after.state).toBe('done')
    // Apply: dry run first; nothing is written, M03 and M11-boot would be ticked.
    const dry = r.cli('--apply', 'cli', '--dry-run')
    expect(dry.stdout).toContain('(dry run: nothing written)')
    expect(dry.stdout).toMatch(/M03-determinism/)
    expect(readFileSync(r.checks, 'utf8')).not.toMatch(/^- \[x\] \*\*M03-determinism/m)
  } finally {
    for (const c of r.children) c.kill('SIGKILL')
  }
})

test('walk-cli: Ctrl-C stops the tool and every server it started; the state says stopped, not running @slow @webkit-gpu', async () => {
  test.setTimeout(120_000)
  const r = rig(['M03-determinism'], 'ctrlc')
  try {
    const s = await r.joinUrl()
    const port = Number(new URL(s.joinUrl as string).port)
    expect((await fetch(`http://127.0.0.1:${port}/__walk/agent.js`)).status).toBe(200)
    r.auto.c.kill('SIGINT')
    expect(await r.auto.exited).toBe(130)
    await expect(fetch(`http://127.0.0.1:${port}/__walk/agent.js`)).rejects.toThrow()
    const after = r.status()
    expect(after.state).toBe('stalled')
    expect(after.remaining).toEqual(['M03-determinism'])
    expect(r.cli('--wait', 'ctrlc', '--timeout', '1').status).toBe(2)
  } finally {
    for (const c of r.children) c.kill('SIGKILL')
  }
})
