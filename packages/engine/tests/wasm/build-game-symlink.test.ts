// M35 ( Planning decisions): `buildGame` accepts a crate path
// that goes through a symlink. `cargo metadata` reports the resolved `manifest_path`, which
// `artifactPath()` matched by exact string, so a symlinked crate dir (macOS `$TMPDIR`, a symlinked
// home) failed with the misleading "has no cdylib target". The link points at the real `fx-hash`
// fixture, whose build is warm by now.
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildGame } from '../../src/build-game.js'
import { fixtureDir } from '../support/fixtures.js'

test('build: a crate reached through a symlink builds (realpath)', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'engine-symlink-'))
  try {
    const link = join(scratch, 'hash-link')
    await symlink(fixtureDir('hash'), link)
    const result = await buildGame({ crate: link, profile: 'dev' })
    expect(existsSync(result.wasmPath)).toBe(true)
    // The output lands beside the real crate, not under the link.
    expect(result.dir).toBe(join(await realpath(fixtureDir('hash')), 'target', 'engine', 'dev'))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 120_000)
