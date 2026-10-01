// `engine event surface` (docs/plan/37-robustness-events.md, Scope "Event-surface audit"): every
// engine-to-game event the ADRs promise (0005 Consequences, 0013, 0018 §8; the table in the brief)
// is on the TypeScript surface through one delivery style (`client.on<Name>(cb)`), and a behaviour
// test named here exists in the test tree. (a) Types: `expectTypeOf` is checked by `tsc` (`pnpm
// lint`), and the same members are found in the `Client` source so a missing one fails this test
// too; (b) every named behaviour test is a real, not skipped, title. A new engine-to-game event
// adds a row and a behaviour test here (`packages/engine/CLAUDE.md`).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, expectTypeOf, test } from 'vitest'
import type {
  Client,
  DesyncReport,
  EngineStartError,
  FatalEvent,
  LinkReason,
  LinkState,
  RendererLostReason,
} from './client.js'
import type { HostServices } from './server.js'
import type { StorageStatus } from './worker/protocol.js'

// --- (a) the surface, as types ---------------------------------------------------------------

expectTypeOf<Client['onStorage']>().toEqualTypeOf<(cb: (s: StorageStatus) => void) => () => void>()
expectTypeOf<Client['onResyncing']>().toEqualTypeOf<(cb: () => void) => () => void>()
expectTypeOf<Client['onFatal']>().toEqualTypeOf<(cb: (e: FatalEvent) => void) => () => void>()
expectTypeOf<Client['onDesync']>().toEqualTypeOf<(cb: (r: DesyncReport) => void) => () => void>()
expectTypeOf<Client['onRendererLost']>().toEqualTypeOf<
  (cb: (e: { reason: RendererLostReason }) => void) => () => void
>()
expectTypeOf<Client['onLink']>().toEqualTypeOf<
  (cb: (e: { state: LinkState; reason?: LinkReason }) => void) => () => void
>()
expectTypeOf<Client['onVersionMismatch']>().toEqualTypeOf<(cb: () => void) => () => void>()
expectTypeOf<Client['exportWorld']>().toEqualTypeOf<() => Promise<Blob>>()
expectTypeOf<Client['importWorld']>().toBeFunction()
expectTypeOf<Client['deleteWorld']>().toEqualTypeOf<(worldId: string) => Promise<void>>()
expectTypeOf<Client['ready']>().toEqualTypeOf<Promise<void>>()
// Start failures are rejections of `client.ready`, never events.
expectTypeOf<EngineStartError['code']>()
  .extract<'world-busy' | 'save-incompatible'>()
  .toEqualTypeOf<'world-busy' | 'save-incompatible'>()
expectTypeOf<NonNullable<EngineStartError['detail']>>().toHaveProperty('reason')
// The server's twin of `onFatal` (0024 §5).
expectTypeOf<NonNullable<HostServices['onFatal']>>().toEqualTypeOf<
  (f: { tick: number; message: string }) => void
>()
expectTypeOf<StorageStatus>().toEqualTypeOf<{
  durable: boolean
  persisted: boolean
  usage: number
  quota: number
}>()
expectTypeOf<DesyncReport>().toHaveProperty('hostHash')

// --- the audit table ---------------------------------------------------------------------------

type Row = {
  event: string
  adr: string
  milestone: string
  /** Members of the public `Client` (`client.ts`), found by name in its interface. */
  client: string[]
  /** Titles of the behaviour tests, exactly as they appear in the test tree. */
  tests: string[]
}

const ROWS: Row[] = [
  {
    event: 'SaveIncompatible',
    adr: '0005 Upgrades',
    milestone: 'M24b',
    client: ['ready', 'exportWorld', 'deleteWorld'],
    tests: [
      'no_migrate_hook_save_incompatible_files_untouched',
      'save_incompatible_rejects_ready_and_export_still_works',
      'reference_save_incompatible_leaves_files @slow',
    ],
  },
  {
    event: 'WorldBusy',
    adr: '0005 Storage',
    milestone: 'M23',
    client: ['ready'],
    tests: ['second_tab_gets_world_busy', 'reference_world_busy_second_tab'],
  },
  {
    event: 'durable: false; storage estimate { persisted, usage, quota }',
    adr: '0005 Storage',
    milestone: 'M23',
    client: ['onStorage'],
    tests: ['no_opfs_falls_back_durable_false', 'storage_status_reports_estimate'],
  },
  {
    event: 'Resyncing (client.onResyncing)',
    adr: '0005 Panic recovery',
    milestone: 'M28b (host hook: M24)',
    client: ['onResyncing'],
    tests: ['reconnect/panic-recovery-resync', 'trap: client instance recovers and resyncs'],
  },
  {
    event: 'onFatal',
    adr: '0005, 0015 §5',
    milestone: 'M24 (host), M37 (surface, servers, guards)',
    client: ['onFatal'],
    tests: [
      'panic_in_tick_is_fatal_and_files_untouched',
      'fatal: two client traps',
      'fatal: storage error',
      'fatal: server onFatal stops world and closes sockets',
    ],
  },
  {
    event: 'rendererLost',
    adr: '0018 §8',
    milestone: 'M37b',
    client: ['onRendererLost'],
    tests: ['two losses raise rendererLost', 'null adapter raises rendererLost'],
  },
  {
    event: 'version mismatch -> reload once -> updating',
    adr: '0013',
    milestone: 'M29',
    client: ['onVersionMismatch', 'onLink'],
    tests: ['version-mismatch', 'mp/version-mismatch-reloads-once'],
  },
  {
    event: 'exportWorld / importWorld',
    adr: '0005 Storage',
    milestone: 'M23',
    client: ['exportWorld', 'importWorld', 'deleteWorld'],
    tests: ['export_import_roundtrip_browser', 'reference_export_import_roundtrip'],
  },
  {
    event: 'EngineFault action result',
    adr: '0005',
    milestone: 'M24',
    client: ['onActionResult'],
    tests: ['panic_in_admit_recovers_and_rejects_engine_fault'],
  },
  {
    event: 'Lost action result',
    adr: '0005',
    milestone: 'M28b',
    client: ['onActionResult'],
    tests: ['reconnect/lost-ack-reports-lost'],
  },
  {
    event: 'superseded stops auto-reconnect',
    adr: '0013',
    milestone: 'M29',
    client: ['onLink'],
    tests: ['mp/superseded'],
  },
  {
    event: 'reconnect indicator delay',
    adr: '0013',
    milestone: 'M29 (test: M37)',
    client: ['onLink'],
    tests: ['mp/reconnect-indicator-delay'],
  },
  {
    event: 'desync report',
    adr: '0013',
    milestone: 'M31b, M37',
    client: ['onDesync'],
    tests: ['desync: onDesync fires once per report'],
  },
]

// --- reading the tree ----------------------------------------------------------------------------

const ENGINE = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(ENGINE, '..', '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bench', 'target', 'test-results'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (/\.(test|spec)\.(ts|mjs)$/.test(entry.name)) yield path
  }
}

const testFiles: Array<{ path: string; text: string }> = [
  ...walk(join(ENGINE, 'src')),
  ...walk(join(ENGINE, 'tests')),
  ...walk(join(REPO, 'games', 'reference', 'src')),
  ...walk(join(REPO, 'games', 'reference', 'tests')),
].map((path) => ({ path, text: readFileSync(path, 'utf8') }))

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where `title` is declared as a test (`test(` / `it(` with any modifier but a skipping one). */
function findTest(title: string): { found: string | null; skipped: boolean } {
  const decl = new RegExp(`\\b(?:test|it)((?:\\.\\w+)*)\\(\\s*(['"\`])${escapeRegex(title)}\\2`)
  for (const f of testFiles) {
    const m = decl.exec(f.text)
    if (!m) continue
    return {
      found: f.path.slice(REPO.length + 1),
      skipped: /\.(skip|fixme|todo)\b/.test(m[1] ?? ''),
    }
  }
  return { found: null, skipped: false }
}

function clientInterfaceBody(): string {
  const text = readFileSync(join(ENGINE, 'src', 'client.ts'), 'utf8')
  const start = text.indexOf('export interface Client {')
  const end = text.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error('engine event surface: `interface Client` not found')
  return text.slice(start, end)
}

// --- (b) the behaviour --------------------------------------------------------------------------

test('engine event surface', () => {
  const problems: string[] = []

  const body = clientInterfaceBody()
  for (const row of ROWS) {
    for (const member of row.client) {
      if (!new RegExp(`^  (?:readonly )?${member}\\b`, 'm').test(body)) {
        problems.push(`${row.event}: \`Client.${member}\` is not on the public Client`)
      }
    }
    if (row.tests.length === 0) problems.push(`${row.event}: no behaviour test is named`)
    for (const title of row.tests) {
      const { found, skipped } = findTest(title)
      if (!found) problems.push(`${row.event}: behaviour test "${title}" is not in the test tree`)
      else if (skipped)
        problems.push(`${row.event}: behaviour test "${title}" is skipped (${found})`)
    }
  }

  // One delivery style: per-event subscriptions. No `EngineEvent` union, no `onEngineEvent`.
  const sources = readdirSync(join(ENGINE, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts') && !/\.test\.ts$/.test(p) && !p.startsWith('test'))
    .map((p) => ({ p, text: readFileSync(join(ENGINE, 'src', p), 'utf8') }))
  for (const { p, text } of sources) {
    if (/\bonEngineEvent\b|\b(?:type|interface|class) EngineEvent\b/.test(text)) {
      problems.push(
        `src/${p}: an \`EngineEvent\` union or \`onEngineEvent\` exists (one delivery style: client.on<Name>)`,
      )
    }
  }

  expect(problems, problems.join('\n')).toEqual([])
  expect(ROWS.length).toBeGreaterThanOrEqual(13)
})
