// M39w: a driven round ends when every check is walked or parked for `--judge`; a QR round keeps waiting for Tyler.
// No phone, no real clocks beyond the drive loop's 10 ms poll: a fake backend, the real step machine and shutdown seam.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { walkFinished } from './device-walk/auto-cli.mjs'
import { endRound } from './device-walk/auto-main.mjs'
import { createAutoRound } from './device-walk/auto-round.mjs'
import { createFakeBackend } from './device-walk/drive/fake-backend.mjs'
import { startDrive } from './device-walk/drive/loop.mjs'
import { devicePerson } from './device-walk/drive/person.mjs'
import { roundState, waitRound } from './device-walk/live.mjs'
import { parseChecks } from './device-walk/parse.mjs'
import { appendEvent, readEvents } from './device-walk/rounds.mjs'

const { items } = parseChecks(
  readFileSync(new URL('../../docs/plan/device-checks.md', import.meta.url), 'utf8'),
)
const ID = 'M16-coexist'

/** A round log whose only item has a judge sheet open on the phone; a machine over it. */
function judgeRound() {
  const dir = mkdtempSync(join(tmpdir(), 'walk-exit-'))
  const file = join(dir, 'r.jsonl')
  mkdirSync(join(dir, 's'))
  for (const e of [
    { type: 'start', only: null, mode: 'auto' },
    { type: 'walk', phase: 'start' },
    { type: 'attempt', id: ID, n: 1, variant: 'fixture', page: 'p', rung: 0 },
    { type: 'attempt', id: ID, n: 1, status: 'done', outcome: 'judge', criteria: [] },
    { type: 'prompt', id: ID, n: 1, kind: 'judge', text: 'both windows look right' },
  ])
    appendEvent(file, e)
  const machine = createAutoRound({
    file,
    items: items.filter((i) => i.id === ID),
    origins: { fixture: 'http://127.0.0.1:1' },
  })
  machine.attach({ append: (e) => appendEvent(file, e) })
  return { dir, file, machine }
}

describe('device-walk exit: a driven round ends by itself (M39w)', () => {
  test('device-walk exit: a driven round whose last item is a deferred judge sheet finishes, runs shutdown and exits 0', async () => {
    const { dir, file, machine } = judgeRound()
    const backend = createFakeBackend({ pages: { autolock: { runner: false } } })
    const d = startDrive({
      backend,
      person: devicePerson(backend, { returnLagMs: 0, sleep: async () => {} }),
      file,
      ids: [ID],
      joinUrl: 'http://127.0.0.1:1/__walk/runner.html?walk=t',
      seriesDir: dir,
      append: (e) => appendEvent(file, e),
      settle: () => machine.settle(),
      isDone: () => machine.done(),
      pollMs: 10,
    })
    // The same wait `startAutoRound().finished()` makes, with the driver parking the sheet meanwhile.
    const over = await walkFinished({ machine, endOnParked: true, pollMs: 5, timeoutMs: 3000 })
    await d.stop()
    expect(over).toBe(true)
    expect(machine.done()).toBe(false)
    expect(readEvents(file).some((e) => e.type === 'defer')).toBe(true)

    const logs = []
    const sets = []
    const shutdown = vi.fn(async () => {})
    const status = () =>
      roundState({ events: readEvents(file), ids: [ID], live: null, now: 1, alive: false })
    const code = await endRound({
      round: 'r1',
      done: over,
      live: { set: (p) => sets.push(p) },
      status: () => ({
        ...status(),
        humanPending: status().humanPending,
        remaining: [ID],
        items: [],
        round: 'r1',
        recorded: 0,
        total: 1,
        counts: { pass: 0, fail: 0, skip: 0, 'not run: no device': 0, open: 1 },
        device: {},
      }),
      shutdown,
      log: (l) => logs.push(l),
    })
    expect(code).toBe(0)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(sets).toEqual([{ phase: 'done-pending-judge' }])
    expect(logs.join('\n')).toMatch(/judge sheets open: M16-coexist/)
    expect(logs.join('\n')).toMatch(/pnpm device:walk --judge r1 <id> pass\|fail\|skip/)
  })

  test('device-walk exit: the status of that round is done-pending-judge with the process gone, and --wait returns 0', () => {
    const { file } = judgeRound()
    appendEvent(file, { type: 'defer', id: ID, n: 1 })
    const read = () =>
      roundState({ events: readEvents(file), ids: [ID], live: null, now: 1, alive: false })
    expect(read()).toMatchObject({ state: 'done-pending-judge', humanPending: [ID] })
    return waitRound({ read, timeoutMs: 1000, sleep: async () => {} }).then((r) =>
      expect(r.code).toBe(0),
    )
  })

  test('device-walk exit: a QR round with the same open sheet still waits for Tyler', async () => {
    const { file, machine } = judgeRound()
    expect(machine.walkOver()).toBe(false)
    const live = { pid: 1, joinUrl: 'https://x.example/', phone: { lastSeen: 1 } }
    const s = roundState({ events: readEvents(file), ids: [ID], live, now: 2, alive: true })
    expect(s.state).toBe('waiting-for-human')
    // Not driven: the wait ends only on a result, so a spent timeout is false, not a finish.
    expect(await walkFinished({ machine, endOnParked: false, pollMs: 1, timeoutMs: 0 })).toBe(false)
  })
})
