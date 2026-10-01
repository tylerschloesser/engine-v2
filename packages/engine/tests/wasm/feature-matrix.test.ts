// `feature-matrix @slow` (docs/plan/36b-suite-audit-and-measurements.md; M02's hand-over, 0002
// Consequences): every golden (the `fx-hash` and `fx-worldgen` scenarios, the `fx-persist` log, the
// reference game's full-game log) replayed on the reference game's and each fixture's `release`
// module built (a) plain, (b) with `wasm-opt`, (c) with `+simd128`, under Node and under Bun. The
// browser engines are `determinism.spec.ts`'s "release variants" test (`@engines @slow`).
//
// A mismatch is a finding, not a golden to change: the variant stays off, and the assertion fails so
// that the finding is read. Everything measured (raw and brotli size per module, target features,
// per-runtime verdicts, the machine) goes to `test-results/wasm/feature-matrix.json` whatever the
// verdict; CI uploads `test-results/` as the `test-results` artifact. `wasm-opt` missing from
// `PATH`: prints `wasm-opt-missing` and records the variant as skipped, unless `REQUIRE_WASM_OPT=1`
// (CI), which fails it.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { instantiate } from '../../src/loader.js'
import { loadGame } from '../../src/server-node.js'
import { replayLog } from '../../src/test/replay.js'
import {
  type Built,
  buildVariant,
  CRATE_KEYS,
  type CrateKey,
  VARIANTS,
  type VariantName,
} from '../support/feature-matrix.js'
import { type GoldenDirs, type GoldenResult, runGoldens } from '../support/release-golden.js'
import { allowedTargetFeatures, targetFeatures } from '../support/wasm-sections.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const OUT = join(REPO, 'test-results/wasm/feature-matrix.json')
const BUN_LEG = fileURLToPath(new URL('./release-golden-bun.mjs', import.meta.url))

type Row = {
  skipped?: string
  sizes: Record<string, { raw: number; brotli: number }>
  buildHashes: Record<string, string>
  runtimes: Record<string, { name: string; ok: boolean; message: string | null }[]>
}
const report: Record<string, Row> = {}
const built: Partial<Record<VariantName, Record<CrateKey, Built>>> = {}

const brotli = (bytes: Uint8Array): number =>
  brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length

// Four fat-LTO release builds per variant, each hook bounded explicitly (cargo, not the default 10 s).
async function buildAll(variant: VariantName): Promise<void> {
  const row: Partial<Record<CrateKey, Built>> = {}
  for (const key of CRATE_KEYS) row[key] = await buildVariant(variant, key)
  built[variant] = row as Record<CrateKey, Built>
}
beforeAll(() => buildAll('plain'), 240_000)
beforeAll(() => buildAll('wasm-opt'), 240_000)
beforeAll(() => buildAll('simd128'), 240_000)

afterAll(() => {
  const wasmOpt = spawnSync('wasm-opt', ['--version'], { encoding: 'utf8' })
  mkdirSync(join(REPO, 'test-results/wasm'), { recursive: true })
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        arch: process.arch,
        platform: process.platform,
        node: process.version,
        wasmOpt: wasmOpt.error ? null : wasmOpt.stdout.trim(),
        variants: report,
      },
      null,
      2,
    )}\n`,
  )
})

function failures(results: GoldenResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.message}`)
}

describe.each(VARIANTS)('feature-matrix %s @slow', (variant) => {
  test('goldens equal under Node and Bun, sizes and features recorded', async () => {
    const mods = built[variant]
    if (!mods) throw new Error(`${variant} did not build`)
    const row: Row = { sizes: {}, buildHashes: {}, runtimes: {} }
    report[variant] = row

    if (variant === 'wasm-opt' && !mods.reference.result.wasmOpt) {
      console.warn('wasm-opt-missing: no wasm-opt on PATH; the wasm-opt variant did not run')
      expect(process.env.REQUIRE_WASM_OPT, 'REQUIRE_WASM_OPT=1 but no wasm-opt on PATH').not.toBe(
        '1',
      )
      row.skipped = 'wasm-opt-missing'
      return
    }

    for (const key of CRATE_KEYS) {
      const b = mods[key]
      row.sizes[key] = { raw: b.bytes.length, brotli: brotli(b.bytes) }
      row.buildHashes[key] = b.result.buildHash
      const json = JSON.parse(readFileSync(join(b.dir, 'game.json'), 'utf8')) as {
        profile: string
        wasmOpt: boolean
      }
      expect(json, `${variant}/${key} game.json`).toMatchObject({
        profile: 'release',
        wasmOpt: variant === 'wasm-opt',
      })
      // The feature section survives only when the build does not strip it (`strip = true` removes
      // it): `release` modules have none, so the simd variant is read from the instructions instead.
      const features = targetFeatures(new WebAssembly.Module(b.bytes))
      expect(
        features.filter(
          (f) => !allowedTargetFeatures(variant === 'simd128' ? 'simd128' : 'default').includes(f),
        ),
        `${variant}/${key}`,
      ).toEqual([])
    }
    // Three different builds, three different identities.
    if (variant !== 'plain') {
      const plain = built.plain
      if (plain) {
        for (const key of CRATE_KEYS) {
          expect(mods[key].result.buildHash, `${variant}/${key} differs from plain`).not.toBe(
            plain[key].result.buildHash,
          )
        }
      }
    }

    const dirs: GoldenDirs = {
      hash: mods.hash.dir,
      worldgen: mods.worldgen.dir,
      persist: mods.persist.dir,
      reference: mods.reference.dir,
    }
    const node = await runGoldens({ instantiate, loadGame, replayLog }, dirs)
    row.runtimes.node = node
    const bun = spawnSync('bun', [BUN_LEG, JSON.stringify(dirs)], {
      encoding: 'utf8',
      timeout: 300_000,
    })
    expect(bun.error, 'spawning bun (pnpm setup:tools installs it)').toBeUndefined()
    const line = bun.stdout.trim().split('\n').at(-1) ?? ''
    row.runtimes.bun = (JSON.parse(line) as { results: GoldenResult[] }).results

    expect(node.length).toBe(4)
    expect(failures(node), `${variant} under Node`).toEqual([])
    expect(row.runtimes.bun.length).toBe(4)
    expect(failures(row.runtimes.bun), `${variant} under Bun`).toEqual([])
  }, 600_000)
})
