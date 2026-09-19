// `fake-engine/vite` — Node built-ins only; vite is a types-only optional peer.
import type { Plugin, ViteDevServer } from 'vite'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EngineOptions {
  /** Path to the game's Rust crate, relative to the Vite root. */
  crate: string
  /** Cargo profile. Default: 'dev' for `vite dev`, 'release' for `vite build`. */
  profile?: 'dev' | 'release'
  /** Inject optimizeDeps.exclude for the engine package. Spike toggle. Default true. */
  exclude?: boolean
  /** Inject worker.format. Spike toggle. Default 'es'. `null` leaves Vite's default. */
  workerFormat?: 'es' | 'iife' | null
  /** Inject COOP/COEP headers. Default true. */
  crossOriginIsolation?: boolean
}

const VIRTUAL = 'virtual:engine/wasm-url'
const RESOLVED = '\0' + VIRTUAL
const DEV_ROUTE = '/@engine/game.wasm'
const PKG_NAME = 'fake-engine'

function cargoBuild(crateDir: string, profile: 'dev' | 'release'): Promise<{ ok: boolean; ms: number; stderr: string }> {
  return new Promise((res) => {
    const t0 = performance.now()
    const args = ['build', '--target', 'wasm32-unknown-unknown', '--color', 'never']
    if (profile === 'release') args.push('--release')
    const p = spawn('cargo', args, { cwd: crateDir, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (e) => res({ ok: false, ms: performance.now() - t0, stderr: String(e) }))
    p.on('close', (code) => res({ ok: code === 0, ms: performance.now() - t0, stderr }))
  })
}

export function engine(opts: EngineOptions): Plugin {
  let root = process.cwd()
  let crateDir = ''
  let wasmPath = ''
  let profile: 'dev' | 'release' = 'release'
  let version = 0
  let built: Promise<void> | undefined
  const watchers: FSWatcher[] = []

  const build = async () => {
    const r = await cargoBuild(crateDir, profile)
    if (!r.ok) throw new Error(`[${PKG_NAME}] cargo build failed:\n${r.stderr}`)
    version++
    console.log(`[${PKG_NAME}] cargo build (${profile}) ok in ${r.ms.toFixed(0)} ms`)
  }

  return {
    name: `${PKG_NAME}:vite`,

    config(_user, env) {
      profile = opts.profile ?? (env.command === 'serve' && !env.isPreview ? 'dev' : 'release')
      const coi =
        opts.crossOriginIsolation === false
          ? undefined
          : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
      return {
        server: coi ? { headers: coi } : {},
        preview: coi ? { headers: coi } : {},
        worker: opts.workerFormat === null ? {} : { format: opts.workerFormat ?? 'es' },
        optimizeDeps: opts.exclude === false ? {} : { exclude: [PKG_NAME] },
        build: { target: 'es2022' },
      }
    },

    configResolved(cfg) {
      root = cfg.root
      crateDir = resolve(root, opts.crate)
      const manifest = readFileSync(join(crateDir, 'Cargo.toml'), 'utf8')
      const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(manifest)?.[1]
      if (!name) throw new Error(`[${PKG_NAME}] no package name in ${crateDir}/Cargo.toml`)
      wasmPath = join(
        crateDir,
        'target/wasm32-unknown-unknown',
        profile === 'release' ? 'release' : 'debug',
        name.replaceAll('-', '_') + '.wasm',
      )
    },

    async buildStart() {
      // Called once per environment/build; only the first call does the cargo build.
      built ??= build()
      await built
    },

    resolveId(id) {
      if (id === VIRTUAL) return RESOLVED
    },

    load(id) {
      if (id !== RESOLVED) return
      if (this.environment?.mode === 'dev') return `export default ${JSON.stringify(`${DEV_ROUTE}?v=${version}`)}`
      const ref = this.emitFile({ type: 'asset', name: 'game.wasm', source: readFileSync(wasmPath) })
      return `export default import.meta.ROLLUP_FILE_URL_${ref}`
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(DEV_ROUTE)) return next()
        if (!existsSync(wasmPath)) return next()
        const body = readFileSync(wasmPath)
        res.setHeader('Content-Type', 'application/wasm')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
        res.end(body)
      })

      let timer: NodeJS.Timeout | undefined
      let running = false
      let again = false
      const rebuild = async () => {
        if (running) return void (again = true)
        running = true
        try {
          await build()
          const mod = server.moduleGraph.getModuleById(RESOLVED)
          if (mod) server.moduleGraph.invalidateModule(mod)
          server.ws.send({ type: 'full-reload', path: '*' })
          console.log(`[${PKG_NAME}] full-reload sent t=${Date.now()}`)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          console.error(message)
          server.ws.send({ type: 'error', err: { message, stack: '', plugin: PKG_NAME } })
        } finally {
          running = false
          if (again) (again = false), void rebuild()
        }
      }
      const onChange = (_ev: string, file: string | null) => {
        if (!file || !(file.endsWith('.rs') || file.endsWith('Cargo.toml'))) return
        if (file.startsWith('target')) return
        console.log(`[${PKG_NAME}] change: ${file} t=${Date.now()}`)
        clearTimeout(timer)
        timer = setTimeout(rebuild, 30)
      }
      // The game crate, and the engine crate next to this file (matters when workspace-linked).
      const engineCrates = resolve(dirname(fileURLToPath(import.meta.url)), '../crates')
      for (const dir of [crateDir, engineCrates]) {
        if (existsSync(dir)) watchers.push(watch(dir, { recursive: true }, onChange))
      }
      server.httpServer?.on('close', () => watchers.forEach((w) => w.close()))
    },
  }
}
