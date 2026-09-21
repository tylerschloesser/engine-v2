// The overlay path of `engine()` (docs/plan/02b-vite-plugin.md, "Rebuild tests must not edit
// tracked files"): breaking a *copy* of fx-hash reaches Vite's error overlay with rustc's message;
// restoring it recovers. @slow: the copy gets its own `[workspace]` table and an absolute-path
// `engine` dependency, so cargo gives it its own cold target dir instead of reusing the repo's
// (0017 "untested": a real cold build, not just the fast tier's no-content-diff touch).
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { engine } from '../../src/vite.js'
import { fixtureDir } from '../support/fixtures.js'

const ENGINE_CRATE_DIR = fileURLToPath(new URL('../../crates/engine', import.meta.url))
// Copied into the standalone crate below, not hand-duplicated: `rustup` resolves the active
// toolchain by walking up from `cwd` for a `rust-toolchain.toml`, and this copy sits outside the
// repo tree entirely (its own `[workspace]`, docs comment below), so without its own copy of this
// file it silently picks up whatever toolchain happens to be the machine's rustup default -- found
// by CI (docs/plan/10-ci-workflow.md, Deviations): the runner's default lacks the
// `wasm32-unknown-unknown` target the pin adds, so this one test alone built with an unpinned,
// target-less compiler. Reading the real file (not embedding the version string a second time)
// means a future pin bump never needs a second edit here.
const ROOT_RUST_TOOLCHAIN = fileURLToPath(
  new URL('../../../../rust-toolchain.toml', import.meta.url),
)
const BROKEN_LINE = '\nfn __plugin_rebuild_error_test() { let x = ; }\n'

/** A standalone copy of `fixtures/hash`: its own `[workspace]`, an absolute-path `engine`
 * dependency (the copy no longer sits two directories under the real one), and concrete
 * `edition`/`version` in place of the workspace-inherited ones the real fixture uses. */
async function copyStandaloneHashCrate(): Promise<string> {
  // Realpath'd: on macOS, $TMPDIR is itself a symlink (/var/folders/… -> /private/var/folders/…),
  // and `cargo metadata`'s `manifest_path` is always the resolved one; `buildGame` matches by exact
  // string, so a symlinked crate dir would never be found.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'engine-plugin-rebuild-error-')))
  await cp(fixtureDir('hash'), dir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('target'),
  })
  const manifestPath = join(dir, 'Cargo.toml')
  const original = await readFile(manifestPath, 'utf8')
  const rewritten = original
    .replaceAll('path = "../../crates/engine"', `path = ${JSON.stringify(ENGINE_CRATE_DIR)}`)
    .replace('version.workspace = true', 'version = "0.0.0"')
    .replace('edition.workspace = true', 'edition = "2024"')
    .replace(/\[lints\]\nworkspace = true\n\n/, '')
  await writeFile(manifestPath, `[workspace]\n\n${rewritten}`)
  await cp(ROOT_RUST_TOOLCHAIN, join(dir, 'rust-toolchain.toml'))
  return dir
}

let tempDir: string
let libRs: string
let server: ViteDevServer
let base: string

beforeAll(async () => {
  tempDir = await copyStandaloneHashCrate()
  libRs = join(tempDir, 'src', 'lib.rs')
  server = await createServer({
    configFile: false,
    root: tempDir,
    plugins: [engine({ crate: tempDir, profile: 'dev' })],
    server: { port: 0, strictPort: false },
    logLevel: 'silent',
  })
  await server.listen()
  const port = (server.httpServer?.address() as AddressInfo | null)?.port
  if (port === undefined) throw new Error('plugin-rebuild-error: dev server has no address')
  base = `http://localhost:${port}`
}, 60_000)

afterAll(async () => {
  await server?.close()
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function waitForMessage(
  ws: WebSocket,
  type: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>
      if (msg.type === type) {
        clearTimeout(timer)
        resolve(msg)
      }
    })
  })
}

test('plugin: rustc error reaches overlay and recovers @slow', async () => {
  const ws = new WebSocket(base.replace('http', 'ws'), 'vite-hmr')
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('vite-hmr socket errored')))
  })

  const original = await readFile(libRs, 'utf8')
  const errored = waitForMessage(ws, 'error', 30_000)
  await writeFile(libRs, original + BROKEN_LINE)
  const errorMsg = await errored
  const err = errorMsg.err as { message: string }
  expect(err.message).toMatch(/error/i)
  expect(err.message).toContain('expected expression')

  const recovered = waitForMessage(ws, 'full-reload', 30_000)
  await writeFile(libRs, original)
  await recovered

  ws.close()
}, 90_000)
