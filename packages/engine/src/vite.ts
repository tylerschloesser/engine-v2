// `engine/vite`: Node built-ins only (docs/decisions/0017 §2); `vite` is imported for types only, so
// it stays a types-only optional peer. The `engine()` plugin of 0017 §5: drives `buildGame`, serves
// the `.wasm` as data through `virtual:engine/wasm` in dev and in build, sets COOP/COEP (0015 §3),
// rebuilds on Rust edits and reports rustc errors to Vite's overlay.
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { buildGame, CargoBuildError, type Profile } from './build-game.js'

export {
  type BuildGameOptions,
  type BuildGameResult,
  buildGame,
  CargoBuildError,
  type GameJson,
  type Profile,
} from './build-game.js'

export interface EngineOptions {
  /** Directory of the game's Rust crate, relative to the Vite root. */
  crate: string
  /** Default: `dev` for `vite dev`, `release` for `vite build` (0017 §4). */
  profile?: Profile
}

/** `plugin.api.profile`, readable once the config has resolved (0017 §4). */
export interface EnginePluginApi {
  profile: Profile
}

const VIRTUAL_ID = 'virtual:engine/wasm'
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`
const DEV_ROUTE = '/@engine/game.wasm'
const REBUILD_DEBOUNCE_MS = 30

const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * Recursive `fs.watch` on `dir` for `.rs` and `Cargo.toml` changes, `target/` ignored. Kept behind
 * one function so a Linux CI failure (0017 "untested") can swap the implementation (M10) without
 * touching the plugin around it. `undefined` when `dir` does not exist (an unbuilt fixture crate).
 */
export function watchCrate(dir: string, onChange: (file: string) => void): FSWatcher | undefined {
  if (!existsSync(dir)) return undefined
  return watch(dir, { recursive: true }, (_event, file) => {
    if (!file) return
    const rel = file.replaceAll('\\', '/')
    if (rel === 'target' || rel.startsWith('target/')) return
    if (!(rel.endsWith('.rs') || rel.endsWith('Cargo.toml'))) return
    onChange(rel)
  })
}

/** The engine npm package's real directory, whether this file runs from `src/` or `dist/`: what
 * `server.fs.allow` needs (0017 §3), the real (non-symlinked) path Vite's default root can miss. */
function enginePackageDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** The engine crate's directory, watched alongside the game crate (matters when workspace-linked). */
function engineCrateDir(): string {
  return join(enginePackageDir(), 'crates')
}

export function engine(opts: EngineOptions): Plugin {
  let root = process.cwd()
  let crateDir = ''
  let profile: Profile = opts.profile ?? 'release'
  let version = 0
  let buildHash = ''
  let wasmBytes: Buffer | undefined
  let built: Promise<void> | undefined
  const watchers: FSWatcher[] = []
  const api: EnginePluginApi = { profile }

  const doBuild = async (): Promise<void> => {
    const result = await buildGame({ crate: crateDir, profile })
    wasmBytes = await readFile(result.wasmPath)
    buildHash = result.buildHash
    version++
  }

  return {
    name: 'engine:vite',
    api,

    config(_userConfig, env) {
      profile = opts.profile ?? (env.command === 'build' ? 'release' : 'dev')
      api.profile = profile
      return {
        server: {
          headers: COI_HEADERS,
          fs: { allow: [enginePackageDir()] },
        },
        preview: { headers: COI_HEADERS },
        worker: { format: 'es' },
      }
    },

    configResolved(cfg) {
      root = cfg.root
      crateDir = resolve(root, opts.crate)
    },

    async buildStart() {
      // Called once per environment/build; only the first call runs cargo.
      built ??= doBuild()
      await built
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID
      return undefined
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined
      if (this.environment?.mode === 'dev') {
        const wasm = { url: `${DEV_ROUTE}?v=${version}`, buildHash }
        return `export default ${JSON.stringify(wasm)}\n`
      }
      if (!wasmBytes) throw new Error('engine:vite: virtual:engine/wasm loaded before build')
      const ref = this.emitFile({ type: 'asset', name: 'game.wasm', source: wasmBytes })
      return `export default { url: import.meta.ROLLUP_FILE_URL_${ref}, buildHash: ${JSON.stringify(buildHash)} }\n`
    },

    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url !== DEV_ROUTE) return next()
        if (!wasmBytes) return next()
        res.setHeader('Content-Type', 'application/wasm')
        res.setHeader('Cache-Control', 'no-store')
        // Terminating the response here skips Vite's own header middleware (0015 §3: every
        // response needs these, the wasm route's own response included).
        for (const [key, value] of Object.entries(COI_HEADERS)) res.setHeader(key, value)
        res.end(wasmBytes)
        return undefined
      })

      let timer: NodeJS.Timeout | undefined
      let running = false
      let again = false
      const rebuild = async (): Promise<void> => {
        if (running) {
          again = true
          return
        }
        running = true
        try {
          await doBuild()
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID)
          if (mod) server.moduleGraph.invalidateModule(mod)
          server.ws.send({ type: 'full-reload', path: '*' })
        } catch (e) {
          const message =
            e instanceof CargoBuildError ? e.stderr : e instanceof Error ? e.message : String(e)
          server.ws.send({ type: 'error', err: { message, stack: '', plugin: 'engine:vite' } })
        } finally {
          running = false
          if (again) {
            again = false
            void rebuild()
          }
        }
      }
      const onChange = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => void rebuild(), REBUILD_DEBOUNCE_MS)
      }
      // The game crate, and the engine crate next to this file (matters when workspace-linked).
      for (const dir of [crateDir, engineCrateDir()]) {
        const watcher = watchCrate(dir, onChange)
        if (watcher) watchers.push(watcher)
      }
      server.httpServer?.on('close', () => {
        for (const watcher of watchers) watcher.close()
      })
    },
  }
}
