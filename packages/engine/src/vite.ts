// `engine/vite`: Node built-ins only (docs/decisions/0017 §2); `vite` is imported for types only, so
// it stays a types-only optional peer. The `engine()` plugin of 0017 §5: drives `buildGame`, serves
// the `.wasm` as data through `virtual:engine/wasm` in dev and in build, sets COOP/COEP (0015 §3),
// rebuilds on Rust edits and reports rustc errors to Vite's overlay.
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { buildGame, CargoBuildError, exportBindings, type Profile } from './build-game.js'

export {
  type BuildGameOptions,
  type BuildGameResult,
  buildGame,
  CargoBuildError,
  exportBindings,
  type GameJson,
  type Profile,
} from './build-game.js'

export interface EngineOptions {
  /** Directory of the game's Rust crate, relative to the Vite root. */
  crate: string
  /** Default: `dev` for `vite dev`, `release` for `vite build` (0017 §4). */
  profile?: Profile
  /**
   * 0017 §5's bindings step (docs/plan/16-action-round-trip.md step 4): a game passes
   * `{ dir: 'src/bindings' }` (0017 §1's layout). Absent by default. The initial `buildStart`
   * build awaits it; a dev rebuild (triggered by a `.rs`/`Cargo.toml` watch) fires it without
   * awaiting it (Deviations: "without gating the reload") so a slow native `cargo test` never
   * delays the page's own `full-reload`.
   */
  bindings?: { dir: string }
}

/** `plugin.api.profile`, readable once the config has resolved (0017 §4). */
export interface EnginePluginApi {
  profile: Profile
}

const VIRTUAL_ID = 'virtual:engine/wasm'
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`
const DEV_ROUTE = '/@engine/game.wasm'
const REBUILD_DEBOUNCE_MS = 30

function errorMessage(e: unknown): string {
  return e instanceof CargoBuildError ? e.stderr : e instanceof Error ? e.message : String(e)
}

const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/** What `watchCrate` returns: enough of `FSWatcher` for the plugin's own `close()` loop, backed by
 * one or more real watchers underneath. */
export interface CrateWatcher {
  close(): void
}

/**
 * Watches `dir` for `.rs` and `Cargo.toml`/`build.rs` changes without ever recursing into
 * `target/` (docs/plan/17d-fast-tier-wall-time.md, CI round 1's fix): a *recursive* `fs.watch` on
 * `src/`, plus a *non-recursive* `fs.watch` on `dir` itself for its root-level files
 * (`Cargo.toml`, `build.rs`). The earlier version watched the whole crate directory recursively
 * and filtered `target/` only inside its callback -- on Linux, `fs.watch(dir, {recursive: true})`
 * is Node's own JS-level walker (`node:internal/fs/recursive_watch`, since libuv has no recursive
 * inotify), and it still *descends into* `target/` to set up its own per-entry watches. Cargo's
 * scratch dir there is rewritten constantly (temp files created and renamed away, e.g. its
 * `*.temp-archive` incremental-compilation cache), so the walker would routinely `readdirSync` a
 * path cargo had already removed, throw `ENOENT`, and its own `catch` block turns that into
 * `this.emit('error', error)` -- with no `'error'` listener on the watcher, Node's `EventEmitter`
 * throws it as an unhandled exception (`lib/events.js`'s `emit`: "If there is no 'error' event
 * listener then throw"), which is exactly the crash CI hit (`plugin-rebuild-error.test.ts`,
 * Deviations). Never watching `target/` at all removes the failure mode outright, on any OS, rather
 * than relying on an `'error'` handler suppressing it (which would only help for errors raised
 * *after* `fs.watch` returns the watcher -- the same walk can throw synchronously, before a caller
 * ever gets the object back, if `target/` is already churning when the watch starts).
 * `undefined` when `dir` does not exist (an unbuilt fixture crate).
 */
export function watchCrate(
  dir: string,
  onChange: (file: string) => void,
): CrateWatcher | undefined {
  if (!existsSync(dir)) return undefined
  const isSourceChange = (rel: string): boolean => rel.endsWith('.rs') || rel.endsWith('Cargo.toml')
  const watchers: FSWatcher[] = []

  const srcDir = join(dir, 'src')
  if (existsSync(srcDir)) {
    watchers.push(
      watch(srcDir, { recursive: true }, (_event, file) => {
        if (!file) return
        const rel = file.replaceAll('\\', '/')
        if (isSourceChange(rel)) onChange(`src/${rel}`)
      }),
    )
  }
  // Non-recursive: reports only `dir`'s own direct children (`Cargo.toml`, `build.rs`, and
  // directory entries like `target`/`src`/`tests` themselves appearing or disappearing), never
  // descending into any of them.
  watchers.push(
    watch(dir, { recursive: false }, (_event, file) => {
      if (!file) return
      const rel = file.replaceAll('\\', '/')
      if (isSourceChange(rel)) onChange(rel)
    }),
  )

  return {
    close(): void {
      for (const w of watchers) w.close()
    },
  }
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
  const watchers: CrateWatcher[] = []
  const api: EnginePluginApi = { profile }

  const doBuild = async (): Promise<void> => {
    const result = await buildGame({ crate: crateDir, profile })
    wasmBytes = await readFile(result.wasmPath)
    buildHash = result.buildHash
    version++
    // The very first build (`buildStart`) awaits its own bindings run, below; a later dev
    // rebuild fires this same step without awaiting it, so it never gates the reload.
  }

  /** `EngineOptions.bindings`'s own `cargo test export_bindings` run. A rejection is logged, not
   * thrown: a stale/missing `.ts` file fails `tsc`, loudly, on its own -- this step is not the one
   * that should turn a bindings-generation hiccup into a build failure the game never asked this
   * plugin to gate on (0017 §5: "without gating the reload"). */
  const doBindings = (): Promise<void> => {
    if (!opts.bindings) return Promise.resolve()
    return exportBindings({ crate: crateDir, dir: opts.bindings.dir }).catch((e: unknown) => {
      console.error(`engine:vite: bindings export failed: ${errorMessage(e)}`)
    })
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
      built ??= doBuild().then(() => doBindings())
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
          void doBindings() // 0017 §5: "without gating the reload" -- not awaited here
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
