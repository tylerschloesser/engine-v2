// .wasm size: raw / gzip -9 / brotli 11, per opt-level, with and without wasm-opt (npm binaryen, spike-only).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'

const sz = (buf) => ({
  raw: buf.length,
  gzip: gzipSync(buf, { level: 9 }).length,
  brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
})
// Rust >= 1.87's wasm32-unknown-unknown enables these by default, and `strip = true` removes the
// target_features section wasm-opt would otherwise detect them from, so they must be passed explicitly.
const FEATURES = ['--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-sign-ext', '--enable-mutable-globals', '--enable-nontrapping-float-to-int', '--enable-multivalue', '--enable-reference-types']
const rows = []
for (const opt of ['3', '"s"', '"z"']) {
  const dir = `target/sizes-${opt.replaceAll('"', '')}`
  const t0 = Date.now()
  execFileSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release', '--target-dir', dir, '--config', `profile.release.opt-level=${opt}`], { cwd: 'sim', stdio: 'pipe' })
  const coldMs = Date.now() - t0
  const wasm = `sim/${dir}/wasm32-unknown-unknown/release/sim.wasm`
  rows.push({ variant: `opt-level=${opt} lto=fat cgu=1 panic=abort strip`, coldBuildMs: coldMs, ...sz(readFileSync(wasm)) })
  for (const flag of ['-O3', '-Oz']) {
    const outFile = wasm.replace('.wasm', `.opt${flag}.wasm`)
    const t1 = Date.now()
    execFileSync('node_modules/.bin/wasm-opt', [flag, ...FEATURES, '--strip-debug', wasm, '-o', outFile], { stdio: 'pipe' })
    rows.push({ variant: `  + wasm-opt ${flag}`, wasmOptMs: Date.now() - t1, ...sz(readFileSync(outFile)) })
    const m = new WebAssembly.Module(readFileSync(outFile)) // still valid, still engine.* only
    if (!WebAssembly.Module.imports(m).every((i) => i.module === 'engine')) throw new Error('imports changed')
  }
}
execFileSync('cargo', ['build', '--target', 'wasm32-unknown-unknown'], { cwd: 'sim', stdio: 'pipe' })
rows.push({ variant: 'dev profile (opt-level=1, deps 3, debuginfo)', ...sz(readFileSync('sim/target/wasm32-unknown-unknown/debug/sim.wasm')) })
console.table(rows)
writeFileSync('test/sizes-result.json', JSON.stringify(rows, null, 2))
