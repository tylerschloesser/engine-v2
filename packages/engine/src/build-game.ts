// `buildGame()`: a game crate in, `game.wasm` + `game.json` out (docs/decisions/0017 §4–§5). Plain
// cargo and Node built-ins only. The Vite plugin (M02b), `pnpm test` and server scripts all call it.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export type Profile = 'dev' | 'release'

export type BuildGameOptions = {
  /** Directory of the game crate (the one holding its `Cargo.toml`). */
  crate: string
  /** Default `dev`. A dev client cannot join a release server, by design (0017 §4). */
  profile?: Profile
  /** Accepted and ignored with a warning until M35 runs `wasm-opt`. */
  wasmOpt?: boolean
  /** Environment for the cargo spawns. Default `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * 0017 §5's bindings step (docs/plan/16-action-round-trip.md step 4): run, after a successful
   * `cargo build`, `cargo test export_bindings` in `crate` with `TS_RS_EXPORT_DIR=dir` (relative
   * to `crate`; ts-rs's own default is `./bindings` when unset, which is exactly a fixture's own
   * top-level `bindings/` convention -- a game passes `'src/bindings'` for 0017 §1's layout).
   * Absent by default: most callers (every fixture but `puts` today) have no `#[ts(export)]` type
   * at all, and `cargo test` is a second, slower native compile+link beyond the `cargo build`
   * above that every other fixture would otherwise pay for nothing.
   */
  bindings?: { dir: string }
}

export type BuildGameResult = {
  /** `<crate>/target/engine/<profile>/` */
  dir: string
  wasmPath: string
  jsonPath: string
  /** SHA-256 of the final bytes, as hex: the handshake token and log-segment stamp. */
  buildHash: string
  abiVersion: number
  profile: Profile
  cargoMs: number
  /** Set only when `opts.bindings` was given: how long the bindings `cargo test` took. */
  bindingsMs?: number
}

let writeSeq = 0

/** What `game.json` holds. */
export type GameJson = { buildHash: string; abiVersion: number; profile: Profile }

export class CargoBuildError extends Error {
  /** Everything cargo wrote to stderr, rustc's messages included. */
  readonly stderr: string
  constructor(what: string, stderr: string) {
    super(`${what} failed\n${stderr}`)
    this.name = 'CargoBuildError'
    this.stderr = stderr
  }
}

type Spawned = { code: number; stdout: string; stderr: string }

function cargo(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Spawned> {
  return new Promise((done) => {
    const child = spawn('cargo', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => done({ code: 127, stdout, stderr: `cannot run cargo: ${e.message}` }))
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }))
  })
}

type Metadata = {
  target_directory: string
  packages: { manifest_path: string; targets: { name: string; kind: string[] }[] }[]
}

/** Where cargo puts the crate's `.wasm`: the workspace's target directory plus the cdylib's name. */
async function artifactPath(crate: string, profile: Profile, env: NodeJS.ProcessEnv) {
  const meta = await cargo(['metadata', '--format-version', '1', '--no-deps'], crate, env)
  if (meta.code !== 0) throw new CargoBuildError('cargo metadata', meta.stderr)
  const { target_directory, packages } = JSON.parse(meta.stdout) as Metadata
  const manifest = join(crate, 'Cargo.toml')
  const lib = packages
    .find((p) => p.manifest_path === manifest)
    ?.targets.find((t) => t.kind.includes('cdylib'))
  if (!lib) throw new CargoBuildError('buildGame', `${manifest} has no cdylib target`)
  const file = `${lib.name.replaceAll('-', '_')}.wasm`
  const profileDir = profile === 'release' ? 'release' : 'debug'
  return join(target_directory, 'wasm32-unknown-unknown', profileDir, file)
}

/**
 * The module's `engine_abi_version()`. Every function import gets a stub, whatever its name, so a
 * module with imports outside the allowlist still builds and the allowlist test can say why it is
 * wrong (0014 §3); the loader would refuse it with a bare `LinkError`.
 */
function readAbiVersion(bytes: Uint8Array<ArrayBuffer>): number {
  const module = new WebAssembly.Module(bytes)
  const stubs: Record<string, Record<string, () => void>> = {}
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') continue
    const space = stubs[entry.module] ?? {}
    stubs[entry.module] = space
    space[entry.name] = () => {}
  }
  const version = new WebAssembly.Instance(module, stubs).exports.engine_abi_version
  if (typeof version !== 'function') {
    throw new Error('buildGame: no engine_abi_version export; is `engine::export_game!` missing?')
  }
  return version() as number
}

export async function buildGame(opts: BuildGameOptions): Promise<BuildGameResult> {
  const crate = resolve(opts.crate)
  const profile = opts.profile ?? 'dev'
  const env = opts.env ?? process.env
  if (opts.wasmOpt) console.warn('buildGame: wasmOpt is ignored until the packaging milestone')

  const artifact = await artifactPath(crate, profile, env)
  const args = ['build', '--target', 'wasm32-unknown-unknown', '--color', 'never']
  if (profile === 'release') args.push('--release')
  const start = performance.now()
  const built = await cargo(args, crate, env)
  const cargoMs = performance.now() - start
  if (built.code !== 0) throw new CargoBuildError('cargo build', built.stderr)

  const bytes = await readFile(artifact)
  const buildHash = createHash('sha256').update(bytes).digest('hex')
  const abiVersion = readAbiVersion(bytes)

  const dir = join(crate, 'target', 'engine', profile)
  const wasmPath = join(dir, 'game.wasm')
  const jsonPath = join(dir, 'game.json')
  const json: GameJson = { buildHash, abiVersion, profile }
  await mkdir(dirname(wasmPath), { recursive: true })
  // Write beside the target, then rename: a reader (the dev server's wasm route, a concurrent
  // build of the same crate, a test comparing bytes) never sees a truncated 3.7 MB file.
  const tmp = `.${process.pid}.${++writeSeq}.tmp`
  await writeFile(wasmPath + tmp, bytes)
  await rename(wasmPath + tmp, wasmPath)
  await writeFile(jsonPath + tmp, `${JSON.stringify(json, null, 2)}\n`)
  await rename(jsonPath + tmp, jsonPath)

  const result: BuildGameResult = {
    dir,
    wasmPath,
    jsonPath,
    buildHash,
    abiVersion,
    profile,
    cargoMs,
  }
  if (opts.bindings) {
    const bindingsStart = performance.now()
    await exportBindings({ crate, dir: opts.bindings.dir, env })
    result.bindingsMs = performance.now() - bindingsStart
  }
  return result
}

// Where `.cargo/config.toml`'s own `[env]` points `TS_RS_EXPORT_DIR` by default, relative to
// whichever crate's test binary is running (cargo always runs a test binary with its own manifest
// directory as its cwd) -- gitignored, so every crate's `export_bindings_*` test can run harmlessly
// there as part of an ordinary `cargo test`/`nextest run`.
const TS_RS_SCRATCH_DIR = 'target/ts-rs-scratch'

/**
 * The bindings step's own cargo invocation, exported so a test can compare its package-selection
 * flags against `cargo-tests`'s (`scripts/suites.mjs`'s `buildSteps`) without calling cargo at all
 * -- deterministically, not by measuring wall time. `--workspace` is load-bearing (see
 * `exportBindings`'s own doc comment): reintroducing a `-p <crate>`/no-flag scope here is exactly
 * the regression `./build-game-bindings-scope.test.ts` exists to catch.
 */
export const BINDINGS_CARGO_ARGS = ['test', '--workspace', '--color', 'never', 'export_bindings']

/**
 * 0017 §5's bindings step, split out so the Vite plugin's dev rebuild can call it without
 * `await`ing it (Deviations: "without gating the reload") while `buildGame()` itself and
 * `scripts/build-fixtures.mjs` always await it. A game/fixture with no `#[ts(export)]` type just
 * runs zero matching tests and copies nothing (`cargo test`'s own behaviour for a name filter that
 * matches no test).
 *
 * Runs plain `cargo test --workspace ... export_bindings` with *no* env override (docs/plan/
 * 17d-fast-tier-wall-time.md step 2, measured with
 * `CARGO_LOG=cargo::core::compiler::fingerprint=info`): a single-package `cargo test -p <crate>`
 * -- with or without a `TS_RS_EXPORT_DIR` override, that made no difference -- resolves a
 * different fingerprint for the crate's own `serde` dependency edge than `cargo nextest run
 * --workspace --no-run` does (`UnitDependencyInfoChanged { old_name: "serde", ... }` on the
 * crate's own lib target), even though every workspace member declares identical `serde`
 * features; it is the *package-selection scope* (`-p` vs `--workspace`) that cargo's per-invocation
 * feature/metadata-hash resolution is sensitive to, not anything this function used to set. Each
 * mismatched scope re-dirtied the other's work on every `pnpm test` (M17d's evidence: 15-16 s of
 * recompiling one crate, every single run). Matching `cargo-tests`'s own `--workspace` scope here
 * -- with the *same*, un-overridden environment `.cargo/config.toml` already gives every other
 * cargo invocation of the build -- fixes it by construction.
 *
 * `--workspace` also runs *every* workspace member's own `export_bindings_*` tests (any fixture
 * with a `#[ts(export)]` type, not just `crate`), each writing to its own `TS_RS_SCRATCH_DIR`
 * (harmless and gitignored, same as an ordinary `pnpm test rust` run today). This function then
 * copies only `crate`'s own scratch output into the caller's real, committed `dir` -- the one
 * place `BINDINGS_FIXTURES`-style opt-in still lives, now as "which crate's files get copied"
 * rather than "which crate's tests get a separate, scope-mismatched cargo invocation".
 */
export async function exportBindings(opts: {
  crate: string
  dir: string
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  const crate = resolve(opts.crate)
  const env = opts.env ?? process.env
  const built = await cargo(BINDINGS_CARGO_ARGS, crate, env)
  if (built.code !== 0) throw new CargoBuildError('cargo test export_bindings', built.stderr)

  const scratch = join(crate, TS_RS_SCRATCH_DIR)
  const dest = join(crate, opts.dir)
  await mkdir(dest, { recursive: true })
  let entries: string[]
  try {
    entries = await readdir(scratch)
  } catch {
    entries = [] // No `#[ts(export)]` type in this crate: nothing to copy.
  }
  for (const name of entries) {
    await copyFile(join(scratch, name), join(dest, name))
  }
}
