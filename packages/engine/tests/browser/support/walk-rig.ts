// The rig of the `walk-life` and `walk-touch` specs (M39f steps 7-9): a real auto round (phone API, step
// machine, `device-serve --walk` of the fixture app, no tunnel) with a fake phone (`fake-phone.mjs`) as the
// person. `walk-auto.spec.ts` carries its own copy of the first half (it predates this file and is left as
// it was).
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Page, test } from '@playwright/test'

const lib = new URL('../../../../../scripts/lib/device-walk/', import.meta.url).href
export type Ev = Record<string, unknown> & { type: string; id?: string; n?: number; src?: unknown }
export type Final = Ev & {
  result: string
  by: string
  attempt: number
  notes?: string
  criteria: { name: string; value: unknown; ok: boolean | null }[]
  metrics: Record<string, unknown>
  evidence?: string
}
type Started = {
  joinUrl: string
  stop(): Promise<void>
  machine: { done(): boolean }
  api: { cut(ms: number): void }
}
export type Handler = {
  match: RegExp | ((bar: { text: string; buttons: string[] }) => boolean)
  run: (ctx: {
    page: Page
    bar: { text: string; buttons: string[] }
  }) => Promise<void | { page: Page }>
}
export type Run = {
  joinUrl: string
  file: string
  events(): Ev[]
  results(): Ev[]
  stop(): Promise<void>
  phone(page: Page, o?: Record<string, unknown>): Promise<Record<string, unknown>>
  until(what: string, fn: () => boolean, ms?: number): Promise<void>
  api: Started['api']
}
export type FakePhone = {
  walkAsPhone(p: Page, o: Record<string, unknown>): Promise<Record<string, unknown>>
  simulateVisibility(p: Page, hidden: boolean, o?: { pagehide?: boolean }): Promise<void>
  simulateLowPower(p: Page, on?: boolean): Promise<void>
  tapBar(p: Page, label: string): Promise<void>
}

export async function fake(): Promise<FakePhone> {
  return (await import(`${lib}fake-phone.mjs`)) as FakePhone
}

export async function start(
  ids: string[],
  params: Record<string, unknown> = {},
  portBase = 15300,
  more: Record<string, unknown> = {},
): Promise<Run> {
  const auto = (await import(`${lib}auto-cli.mjs`)) as {
    startAutoRound(o: Record<string, unknown>): Promise<Started>
  }
  const serve = (await import(`${lib}spawn-serve.mjs`)) as {
    spawnServe(args: string[], io: unknown): unknown
  }
  const rounds = (await import(`${lib}rounds.mjs`)) as { readEvents(f: string): Ev[] }
  const parse = (await import(`${lib}parse.mjs`)) as {
    parseChecks(t: string): { items: { id: string }[] }
  }
  const f = await fake()
  const text = readFileSync(
    new URL('../../../../../docs/plan/device-checks.md', import.meta.url),
    'utf8',
  )
  const items = parse.parseChecks(text).items.filter((i) => ids.includes(i.id))
  const dir = mkdtempSync(join(tmpdir(), 'walk-rig-'))
  const file = join(dir, 'r.jsonl')
  // The chromium and the engines legs run at once, each with its own parallel indexes: ports per project.
  // A rig uses up to a dozen ports from its base (two servers, each with a socket port beside it): bases are
  // 100 apart, a worker 15 on, and the second engine 5000 up.
  const port =
    portBase + (test.info().project.name === 'chromium' ? 0 : 5000) + test.info().parallelIndex * 15
  // `--no-build`: `pnpm test`'s `pages` step built the fixture app; this serves that output.
  const round = await auto.startAutoRound({
    round: 'spec',
    file,
    seriesDir: join(dir, 'series'),
    items,
    only: ids,
    tunnel: false,
    params: { probeMs: 700, ...params },
    basePort: port,
    wsBasePort: port + 1,
    log: () => {},
    ...more,
    spawnServe: (args: string[], io: unknown) => serve.spawnServe([...args, '--no-build'], io),
  })
  const events = () => rounds.readEvents(file)
  return {
    joinUrl: round.joinUrl,
    file,
    events,
    results: () => events().filter((e) => e.type === 'result'),
    stop: () => round.stop(),
    api: round.api,
    phone: (page, o = {}) =>
      f.walkAsPhone(page, { runnerUrl: round.joinUrl, isDone: () => round.machine.done(), ...o }),
    until: async (what, fn, ms = 60_000) => {
      const t0 = Date.now()
      while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 100))
      }
    },
  }
}

export const finalOf = (r: Run, id: string) => r.results().find((e) => e.id === id) as Final
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
