// `createScratchApp` (M35 Seams; M38 may reuse it): a Vite game
// outside both workspaces, built the way an external developer builds one (0017 §8). It lives under
// `<tmpdir>/engine-tarball-test/`, never inside the repo (0017 §6: an ancestor `[workspace]` would
// adopt the crate), and installs the engine either from a `pnpm pack` tarball or as a `link:`.
//
// Layout of the scratch root (shared by concurrent processes, never removed as a whole):
//   tarballs-<pid>/engine-0.0.0.tgz   one `pnpm pack` per process
//   <install>-<pattern>[-<label>]/    one app: package.json (no lockfile), node_modules, sim/, src/
// `CARGO_TARGET_DIR` is a sibling directory kept between runs, so the slow tier pays the cold
// dependency build once (`<tmpdir>/engine-tarball-target/`).
//
// Not realpath'd: macOS `$TMPDIR` is a symlink, which is the point (`buildGame` resolves it).
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ENGINE_PKG = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '')
const TEMPLATE = fileURLToPath(new URL('../browser/packaging/scratch-app/', import.meta.url))

export const SCRATCH_ROOT = join(tmpdir(), 'engine-tarball-test')
export const SCRATCH_TARGET = join(tmpdir(), 'engine-tarball-target')

export type ScratchOptions = {
  pattern: 'A' | 'B'
  install: 'tarball' | 'link'
  /** Names the app directory beside the others (`<install>-<pattern>-<label>`): two specs asking for
   * the same install and pattern in different Playwright workers must not share one directory. */
  label?: string
}

export interface RunningServer {
  url: string
  /** Everything the process wrote so far. */
  log(): string
  stop(): Promise<void>
}

export interface ScratchApp {
  dir: string
  pattern: 'A' | 'B'
  install: 'tarball' | 'link'
  /** `<dir>/sim/target/engine/<profile>`: where `buildGame` writes `game.wasm` and `game.json`. */
  buildDir(profile: 'dev' | 'release'): string
  /** The environment every child of this app runs in (`CARGO_TARGET_DIR`, no `NO_COLOR` surprises). */
  env: NodeJS.ProcessEnv
  /** `vite dev` on a free port; resolves once Vite prints its `Local:` line. */
  dev(): Promise<RunningServer>
  /** `vite build`, to completion: returns Vite's output. */
  build(): Promise<string>
  /** `vite preview` on a free port (after `build()`). */
  preview(): Promise<RunningServer>
  /** Runs `command args` in the app directory (`node`, `bun`...). */
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>
}

let prepared: Promise<string> | undefined

/** Packs the engine once per process into a directory of its own; returns the `.tgz` path. The root
 * itself is shared by every Playwright worker that runs a scratch app at the same time (the packaging
 * project runs its specs in parallel), so nothing here removes it: each process clears only its own
 * tarball directory and each app its own `dir`. */
function prepareRoot(): Promise<string> {
  prepared ??= (async () => {
    const tarballs = join(SCRATCH_ROOT, `tarballs-${process.pid}`)
    await rm(tarballs, { recursive: true, force: true })
    await mkdir(tarballs, { recursive: true })
    await mkdir(SCRATCH_TARGET, { recursive: true })
    await run('pnpm', ['pack', '--pack-destination', tarballs], { cwd: ENGINE_PKG })
    const [file] = (await readdir(tarballs)).filter((f) => f.endsWith('.tgz'))
    if (!file) throw new Error('createScratchApp: pnpm pack wrote no tarball')
    return join(tarballs, file)
  })()
  return prepared
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function spawnServer(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  ready: RegExp,
  timeoutMs: number,
): Promise<RunningServer & { url: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(join(cwd, 'node_modules/.bin/vite'), args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let exited = false
    const exit = new Promise<void>((done) => {
      child.once('exit', () => {
        exited = true
        done()
      })
    })
    const onData = (d: Buffer) => {
      out += d
      if (ready.test(out)) {
        clearTimeout(timer)
        resolve({
          url: `http://127.0.0.1:${env.SCRATCH_PORT}`,
          log: () => out,
          async stop() {
            if (!exited) child.kill('SIGTERM')
            await exit
          },
        })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`vite ${args.join(' ')} exited ${code} before it was ready:\n${out}`))
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`vite ${args.join(' ')} not ready after ${timeoutMs} ms:\n${out}`))
    }, timeoutMs)
  })
}

export async function createScratchApp(opts: ScratchOptions): Promise<ScratchApp> {
  const tarball = await prepareRoot()
  const dir = join(
    SCRATCH_ROOT,
    `${opts.install}-${opts.pattern}${opts.label ? `-${opts.label}` : ''}`,
  )
  await rm(dir, { recursive: true, force: true })
  await cp(TEMPLATE, dir, {
    recursive: true,
    filter: (src) => !src.endsWith('Cargo.toml.template') && !src.endsWith('/src/worker.ts'),
  })
  await cp(join(TEMPLATE, 'sim/Cargo.toml.template'), join(dir, 'sim/Cargo.toml'))
  // What a game ships beside its crate (0017 §6): the exact toolchain pin.
  await cp(join(REPO_ROOT, 'rust-toolchain.toml'), join(dir, 'rust-toolchain.toml'))

  const main = await readFile(join(dir, 'src/main.ts'), 'utf8')
  const createWorker =
    opts.pattern === 'B'
      ? "createWorker: track(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })),"
      : ''
  await writeFile(join(dir, 'src/main.ts'), main.replace('/*CREATE_WORKER*/', createWorker))
  await writeFile(join(dir, 'src/config.ts'), `export const PATTERN = '${opts.pattern}'\n`)
  if (opts.pattern === 'B') await cp(join(TEMPLATE, 'src/worker.ts'), join(dir, 'src/worker.ts'))

  const rootPkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>
  }
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'scratch-app',
        private: true,
        type: 'module',
        dependencies: {
          engine: opts.install === 'tarball' ? `file:${tarball}` : `link:${ENGINE_PKG}`,
        },
        devDependencies: { vite: rootPkg.devDependencies.vite },
      },
      null,
      2,
    )}\n`,
  )

  const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: SCRATCH_TARGET, NO_COLOR: '1' }
  // `--ignore-workspace` and no lockfile: nothing of this repo's pnpm setup applies (0017 §8).
  await run('pnpm', ['install', '--ignore-workspace', '--lockfile=false'], { cwd: dir, env })

  return {
    dir,
    pattern: opts.pattern,
    install: opts.install,
    buildDir: (profile) => join(dir, 'sim/target/engine', profile),
    env,
    async dev() {
      const port = await freePort()
      return spawnServer(
        ['--port', String(port), '--strictPort'],
        dir,
        { ...env, SCRATCH_PORT: String(port) },
        /Local:\s+http/,
        600_000,
      )
    },
    async build() {
      const { stdout, stderr } = await run(join(dir, 'node_modules/.bin/vite'), ['build'], {
        cwd: dir,
        env,
        maxBuffer: 64 << 20,
        timeout: 900_000,
      })
      return stdout + stderr
    },
    async preview() {
      const port = await freePort()
      return spawnServer(
        ['preview', '--port', String(port), '--strictPort'],
        dir,
        { ...env, SCRATCH_PORT: String(port) },
        /Local:\s+http/,
        60_000,
      )
    },
    exec: (command, args) =>
      run(command, args, { cwd: dir, env, maxBuffer: 64 << 20, timeout: 120_000 }),
  }
}
