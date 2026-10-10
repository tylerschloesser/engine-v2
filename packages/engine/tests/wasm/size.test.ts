// `size @slow` (M35; ADR 0062 "Download", 0015 §6, 0017 §9): the
// release `game.wasm` of `games/reference` at brotli 11 against the warn and fail budgets, and the
// engine JS a game's browser bundle carries against `size.engineJsBrotli`. Every number is written to
// `test-results/wasm/size.json` (raw and brotli per file) whatever the verdict. A size between warn
// and fail passes and prints a `console.warn` line: it is recorded, never hidden.
//
// Two cells for the JS, both recorded, one asserted:
// - `dist`: every `dist/*.js` reachable from a non-test subpath, unminified, comments included, as
//   `tsc` wrote them. Recorded only: that includes `engine/server/*` and `engine/vite`, which a
//   browser never downloads, and doc comments.
// - `browser`: `engine` and `engine/render`, plus the worker script `client.js` reaches as a
//   `new Worker(new URL(...))` asset, bundled and minified by Vite, the way a game's own build
//   ships them. This is the one `size.engineJsBrotli` is read against.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'
import { build } from 'vite'
import { beforeAll, expect, test } from 'vitest'
import { buildGame } from '../../src/build-game.js'
import { budget } from '../support/budgets.js'
import { ENGINE_DIR, productionEntries, reachableDist } from '../support/dist-graph.js'

const REPO = join(ENGINE_DIR, '../..')
const OUT = join(REPO, 'test-results/wasm/size.json')

type FileSize = { file: string; raw: number; brotli: number }

const brotli = (bytes: Uint8Array): number =>
  brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length

const sum = (rows: FileSize[], key: 'raw' | 'brotli'): number =>
  rows.reduce((total, row) => total + row[key], 0)

/** The browser entrypoints through Vite's own minifying bundler, in memory. */
async function browserBundle(): Promise<FileSize[]> {
  const entry = '\0size-entry'
  const dist = (name: string): string => join(ENGINE_DIR, 'dist', name)
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root: ENGINE_DIR,
    worker: { format: 'es' },
    build: { write: false, minify: true, target: 'es2022', rollupOptions: { input: entry } },
    plugins: [
      {
        name: 'size-entry',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? `import * as client from ${JSON.stringify(dist('client.js'))}
import * as render from ${JSON.stringify(dist('render.js'))}
globalThis.__size = [client, render]`
            : undefined,
      },
    ],
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) =>
    'output' in r ? r.output : [],
  )
  return outputs
    .filter((o) => o.fileName.endsWith('.js'))
    .map((o) => {
      const bytes = Buffer.from(o.type === 'chunk' ? o.code : (o.source as string | Uint8Array))
      return { file: o.fileName, raw: bytes.length, brotli: brotli(bytes) }
    })
}

type Measured = {
  wasm: FileSize
  distJs: FileSize[]
  browserJs: FileSize[]
}
let measured: Measured

beforeAll(async () => {
  const built = await buildGame({ crate: join(REPO, 'games/reference/sim'), profile: 'release' })
  const bytes = readFileSync(built.wasmPath)
  const wasm = { file: 'games/reference game.wasm', raw: bytes.length, brotli: brotli(bytes) }
  const distJs = reachableDist(productionEntries()).map((file) => {
    const js = readFileSync(join(ENGINE_DIR, file))
    return { file, raw: js.length, brotli: brotli(js) }
  })
  const browserJs = await browserBundle()
  measured = { wasm, distJs, browserJs }

  const warn = budget('size.wasmBrotliWarn')
  const fail = budget('size.wasmBrotliFail')
  const engineJs = budget('size.engineJsBrotli')
  mkdirSync(join(REPO, 'test-results/wasm'), { recursive: true })
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        wasm: {
          ...wasm,
          warnBudget: warn,
          failBudget: fail,
          status: wasm.brotli > fail ? 'fail' : wasm.brotli > warn ? 'warn' : 'ok',
        },
        engineJs: {
          budget: engineJs,
          browser: {
            brotli: sum(browserJs, 'brotli'),
            raw: sum(browserJs, 'raw'),
            files: browserJs,
          },
          dist: { brotli: sum(distJs, 'brotli'), raw: sum(distJs, 'raw'), files: distJs },
        },
      },
      null,
      2,
    )}\n`,
  )
}, 600_000)

test('size @slow: reference game.wasm brotli is under the fail budget (warn recorded)', () => {
  const { brotli: size } = measured.wasm
  const warn = budget('size.wasmBrotliWarn')
  if (size > warn) {
    console.warn(`size: game.wasm is ${size} B brotli, over the ${warn} B warn budget`)
  }
  expect(size, 'release game.wasm brotli 11 (size.wasmBrotliFail)').toBeLessThanOrEqual(
    budget('size.wasmBrotliFail'),
  )
  expect(measured.wasm.raw).toBeGreaterThan(0)
})

test('size @slow: engine JS the browser downloads is within size.engineJsBrotli', () => {
  const total = sum(measured.browserJs, 'brotli')
  const exact = budget('size.engineJsBrotliExact')
  console.log(
    `size: engine JS ${total} B brotli (recorded ${exact}, ${total - exact >= 0 ? '+' : ''}${total - exact})`,
  )
  expect(
    total,
    `engine JS brotli 11 (client + render + worker, minified): ${measured.browserJs
      .map((f) => `${f.file} ${f.brotli}`)
      .join(', ')}`,
  ).toBeLessThanOrEqual(budget('size.engineJsBrotli'))
})

// 0017 §7: `ts-rs` is a normal dependency of the engine crate and nothing of it is reachable from an
// export, so LTO removes it. Looked for by name: `release-names` is `release` with `strip = false`,
// so every symbol that survived is in the module's `name` section.
test('ts-rs zero bytes @slow', async () => {
  const built = await buildGame({
    crate: join(REPO, 'games/reference/sim'),
    profile: 'release-names',
  })
  const bytes = Buffer.from(readFileSync(built.wasmPath))
  // Controls first: names are in this module (the game's own crate and the engine's), so an absent
  // `ts_rs` is the finding and not a stripped section.
  expect(bytes.includes('reference_sim'), 'game symbols are named').toBe(true)
  expect(bytes.includes('serde_json'), 'engine dependencies are named').toBe(true)
  const at = bytes.indexOf('ts_rs')
  expect(
    at,
    at < 0
      ? ''
      : `a ts_rs symbol survives LTO near byte ${at}: ${bytes.subarray(at - 40, at + 60)}`,
  ).toBe(-1)
}, 600_000)
