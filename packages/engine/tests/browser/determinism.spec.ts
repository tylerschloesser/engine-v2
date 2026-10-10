// The cross-engine golden hash (docs/decisions/0002 §3 "Cross-engine golden hashes"; 0020 §5, §6):
// the same scenario, same driver (`tests/support/scenario.ts`) as the native, Node and Bun legs,
// this time run from a worker in Chromium, WebKit and Firefox, for every fixture `determinism.html`
// lists (`hash`, `worldgen`, M08. `@engines` runs it in all
// three (Planning decisions, "Browsers and projects"); it needs no GPU, so headless Firefox and
// WebKit's JavaScriptCore both qualify (0020 §6).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { buildVariant, CRATE_KEYS, type VariantName } from '../support/feature-matrix.js'
import { readGolden } from '../support/fixtures.js'
import { readFullGame } from '../support/reference-golden.js'
import { PERSIST_PARAMS, persistCheckpoints, readPersistLog } from '../support/release-golden.js'
import { diffCheckpoints, type Golden, type HashScenario } from '../support/scenario.js'
import { openPage } from './support/page.js'

declare global {
  interface Window {
    __determinismVariant?: {
      run(wasmB64: string, scenario: HashScenario): Promise<string[]>
      replay(
        wasmB64: string,
        params: { seed: string; worldgen: unknown },
        framesB64: string,
        ticks: number[],
      ): Promise<string[]>
    }
    __determinism?: {
      fixtures: Record<string, { checkpoints: string[]; pass: boolean }>
      userAgent: string
      crossOriginIsolated: boolean
    }
  }
}

test('determinism: golden reproduced in the browser @engines', async ({ page }) => {
  // Read in Node, not trusted from the page (Tests added): the page's own bundled copies of
  // `golden.json` are for the human-facing PASS/FAIL banner only.
  const goldens = {
    hash: readGolden<Golden>('hash', 'golden.json'),
    worldgen: readGolden<Golden>('worldgen', 'golden.json'),
  }
  for (const golden of Object.values(goldens)) {
    expect(golden.checkpoints.length).toBeGreaterThanOrEqual(1)
  }

  await openPage(page, '/determinism.html')
  const result = await page.evaluate(() => window.__determinism)
  if (!result) throw new Error('window.__determinism missing')

  for (const [name, golden] of Object.entries(goldens)) {
    const fixture = result.fixtures[name]
    if (!fixture) throw new Error(`window.__determinism.fixtures has no entry for ${name}`)
    // The first divergent checkpoint, if any, is the whole point of the message on failure.
    expect(diffCheckpoints(fixture.checkpoints, golden.checkpoints), name).toBeNull()
  }
  // M34b: the reference game's full-game log replayed from genesis in the page's worker.
  const reference = result.fixtures.reference
  if (!reference) throw new Error('window.__determinism.fixtures has no entry for reference')
  const { meta } = readFullGame()
  const want = meta.checkpoints.map((c) => c.hash)
  const bad = want.findIndex((h, i) => reference.checkpoints[i] !== h)
  expect(
    reference.checkpoints.length === want.length && bad === -1
      ? null
      : `first divergent tick ${meta.checkpoints[Math.max(bad, 0)]?.tick}`,
    'reference full-game golden',
  ).toBeNull()
  expect(result.crossOriginIsolated).toBe(true)
  expect(result.userAgent.length).toBeGreaterThan(0)
})

// M36b `feature-matrix` (the browser half; the Node and Bun half is `tests/wasm/feature-matrix.test.ts`):
// every golden replayed in the page's worker on the release module built plain, with `wasm-opt` and
// with `+simd128`, in every engine `@engines` reaches. A mismatch is a finding: the variant stays off.
// The verdicts go to `test-results/feature-matrix/<engine>.json` whatever the outcome.
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

test('determinism: release variants (plain, wasm-opt, +simd128) reproduce the goldens @engines @slow', async ({
  page,
  browserName,
}) => {
  // Four fat-LTO builds per variant on a cold cache; the wasm suite's `feature-matrix` builds the same
  // ones, so cargo is usually a no-op here.
  test.setTimeout(600_000)
  const variants: VariantName[] = ['plain', 'wasm-opt', 'simd128']
  const built = new Map<string, Awaited<ReturnType<typeof buildVariant>>>()
  for (const v of variants)
    for (const k of CRATE_KEYS) built.set(`${v}/${k}`, await buildVariant(v, k))

  await openPage(page, '/determinism.html')
  const full = readFullGame()
  const persistWant = persistCheckpoints()
  const report: Record<string, Record<string, string | null>> = {}
  const findings: string[] = []
  for (const v of variants) {
    const row: Record<string, string | null> = {}
    report[v] = row
    if (v === 'wasm-opt' && !built.get('wasm-opt/reference')?.result.wasmOpt) {
      console.warn('wasm-opt-missing: no wasm-opt on PATH; the wasm-opt variant did not run')
      expect(process.env.REQUIRE_WASM_OPT, 'REQUIRE_WASM_OPT=1 but no wasm-opt on PATH').not.toBe(
        '1',
      )
      row.skipped = 'wasm-opt-missing'
      continue
    }
    const wasm = (k: string): string => b64(built.get(`${v}/${k}`)?.bytes ?? new Uint8Array())
    for (const name of ['hash', 'worldgen'] as const) {
      const scenario = readGolden<HashScenario>(name, 'scenario.json')
      const golden = readGolden<Golden>(name, 'golden.json')
      const got = await page.evaluate(
        ([w, sc]) => window.__determinismVariant?.run(w as string, sc as HashScenario),
        [wasm(name), scenario] as const,
      )
      row[`fx-${name}`] = diffCheckpoints(got ?? [], golden.checkpoints)
    }
    const persist = await page.evaluate(
      ([w, p, f, t]) =>
        window.__determinismVariant?.replay(
          w as string,
          p as { seed: string; worldgen: unknown },
          f as string,
          t as number[],
        ),
      [
        wasm('persist'),
        PERSIST_PARAMS,
        b64(readPersistLog()),
        persistWant.map((c) => c.tick),
      ] as const,
    )
    row['fx-persist'] =
      (persist ?? []).every((h, i) => h === persistWant[i]?.hash) &&
      persist?.length === persistWant.length
        ? null
        : 'diverged'
    const ref = await page.evaluate(
      ([w, p, f, t]) =>
        window.__determinismVariant?.replay(
          w as string,
          p as { seed: string; worldgen: unknown },
          f as string,
          t as number[],
        ),
      [
        wasm('reference'),
        { seed: full.meta.seed, worldgen: full.meta.worldgen },
        b64(full.frames),
        full.meta.checkpoints.map((c) => c.tick),
      ] as const,
    )
    const bad = full.meta.checkpoints.findIndex((c, i) => ref?.[i] !== c.hash)
    row.reference =
      ref?.length === full.meta.checkpoints.length && bad === -1
        ? null
        : `first divergent tick ${full.meta.checkpoints[Math.max(bad, 0)]?.tick}`
    for (const [name, verdict] of Object.entries(row)) {
      if (verdict !== null) findings.push(`${browserName} ${v} ${name}: ${verdict}`)
    }
  }
  mkdirSync(join(REPO, 'test-results/feature-matrix'), { recursive: true })
  writeFileSync(
    join(REPO, 'test-results/feature-matrix', `${browserName}.json`),
    `${JSON.stringify({ browserName, userAgent: await page.evaluate(() => navigator.userAgent), verdicts_null_is_equal: report }, null, 2)}\n`,
  )
  expect(findings).toEqual([])
})
