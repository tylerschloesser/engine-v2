// Headless verification matrix. Usage: node test/run.mjs   (env BROWSERS=chromium,firefox,webkit)
import { spawn, execFileSync } from 'node:child_process'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pw from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vite = join(root, 'node_modules/.bin/vite')
const browsers = (process.env.BROWSERS ?? 'chromium').split(',')
const rows = []
let port = 5301

function startServer(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(vite, args, { cwd: root, env: { ...process.env, ...env, NO_COLOR: '1' } })
    let out = ''
    const onData = (d) => {
      out += d
      if (/Local:\s+http/.test(out)) resolve({ p, out: () => out })
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', onData)
    p.on('exit', (c) => reject(new Error(`vite ${args.join(' ')} exited ${c}\n${out}`)))
    setTimeout(() => reject(new Error('server start timeout\n' + out)), 120_000)
  })
}

async function getResult(page, url) {
  const problems = []
  page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()))
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  await page.goto(url)
  const deadline = Date.now() + 20_000
  let result
  while (Date.now() < deadline) {
    try {
      result = await page.evaluate(() => window.__result)
      if (result) break
    } catch {
      /* navigation (e.g. optimizer reload) destroyed the context; retry */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return { result: result ?? { ok: false, error: 'timeout waiting for __result' }, problems }
}

const cases = []
for (const pattern of ['A', 'B'])
  for (const wasm of ['virtual', 'url']) for (const compile of ['main', 'worker']) cases.push({ pattern, wasm, compile })

for (const mode of ['dev', 'preview']) {
  for (const exclude of ['1', '0']) {
    for (const workerFormat of ['es', 'default']) {
      const env = { SPIKE_EXCLUDE: exclude, SPIKE_WORKER_FORMAT: workerFormat }
      const label = `${mode} exclude=${exclude} worker.format=${workerFormat}`
      let server
      let buildInfo = ''
      try {
        if (mode === 'preview') {
          rmSync(join(root, 'dist'), { recursive: true, force: true })
          execFileSync(vite, ['build'], { cwd: root, env: { ...process.env, ...env, NO_COLOR: '1' }, stdio: 'pipe' })
          buildInfo = readdirSync(join(root, 'dist/assets')).join(' ')
          server = await startServer(['preview', '--port', String(++port), '--strictPort'], env)
        } else {
          // --force + fresh cache so every dev config starts from a cold optimizer.
          rmSync(join(root, 'node_modules/.vite'), { recursive: true, force: true })
          server = await startServer(['--port', String(++port), '--strictPort', '--force'], { ...env, SPIKE_PROFILE: 'release' })
        }
      } catch (e) {
        rows.push({ label, case: '(server/build)', pass: false, detail: String(e.message).slice(0, 2000) })
        console.log('FAIL', label, String(e.message).slice(0, 2000))
        continue
      }
      for (const name of browsers) {
        const browser = await pw[name].launch()
        for (const c of cases) {
          const page = await browser.newPage()
          const url = `http://localhost:${port}/?pattern=${c.pattern}&wasm=${c.wasm}&compile=${c.compile}&panic`
          const { result: r, problems } = await getResult(page, url)
          const importsOk = c.compile === 'worker' || (r.imports?.length > 0 && r.imports.every((i) => i.module === 'engine'))
          const ctOk = c.compile === 'worker' || r.wasmContentType === 'application/wasm'
          const hashedOk = mode === 'dev' || /\/assets\/[\w.-]+-[\w-]{8,}\.wasm$/.test(r.wasmUrl ?? '')
          const pass =
            r.ok === true && r.sum === 42 && r.abiVersion === 1 && importsOk && ctOk && hashedOk &&
            r.how === (c.compile === 'main' ? 'module' : 'streaming') &&
            /deliberate panic from game code/.test(r.panic ?? '') && r.logs?.includes('[1] engine_init ok')
          rows.push({ label, browser: name, ...c, pass, hash: r.hash, coi: r.crossOriginIsolated, wasmUrl: r.wasmUrl, imports: r.imports?.map((i) => `${i.module}.${i.name}`).join(','), exports: r.exports?.join(','), error: r.error, problems: problems.join(' | ') })
          console.log(pass ? 'PASS' : 'FAIL', label, name, JSON.stringify(c), pass ? '' : JSON.stringify({ r, problems }))
          await page.close()
        }
        await browser.close()
      }
      if (buildInfo) console.log('   dist/assets:', buildInfo)
      server.p.kill('SIGTERM')
    }
  }
}

const hashes = new Set(rows.filter((r) => r.pass).map((r) => r.hash))
const failed = rows.filter((r) => !r.pass)
writeFileSync(join(root, 'test/matrix-result.json'), JSON.stringify(rows, null, 2))
console.log(`\n${rows.length - failed.length}/${rows.length} passed; distinct state hashes after 1000 ticks: ${[...hashes].join(', ')}`)
const sample = rows.find((r) => r.pass && r.imports)
if (sample) console.log('imports:', sample.imports, '\nexports:', sample.exports)
process.exit(failed.length || hashes.size !== 1 ? 1 : 0)
