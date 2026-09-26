// `storage/archive.ts` (docs/plan/23-persistence-opfs-and-lifecycle.md step 5, Tests added):
// `archive_golden_bytes`, `export_import_roundtrip_node`, `import_refuses_existing_world`.
// `export_browser_import_node_same_hash` lives in `tests/browser/world-archive.spec.ts` instead
// (Deviations there: why a single Playwright test, not a Vitest one reading a cross-suite file).
import { expect, test } from 'vitest'
import {
  ArchiveFormatError,
  decodeContainer,
  deleteWorld,
  encodeContainer,
  exportWorld,
  importWorld,
  packArchive,
  unpackArchive,
  WorldExistsError,
} from './archive.js'
import { memoryStorage } from './memory.js'
import { worldKeys } from './types.js'

test('archive_golden_bytes', () => {
  // The pre-gzip container layout, pinned byte-for-byte (Deviations: a gzip stream is not
  // guaranteed byte-identical across runtimes/timestamps even for identical input, so this test
  // protects the container `encodeContainer` builds, not `packArchive`'s own compressed wrapper).
  const bytes = encodeContainer('w1', [
    { key: 'manifest', bytes: new Uint8Array([1, 2, 3]) },
    { key: 'log/000000', bytes: new Uint8Array([9]) },
  ])
  const expected = new Uint8Array([
    0x45,
    0x57,
    0x41,
    0x31, // magic "EWA1"
    1,
    0, // version u16 LE = 1
    2,
    0, // worldIdLen u16 LE = 2
    0x77,
    0x31, // "w1"
    2,
    0,
    0,
    0, // count u32 LE = 2
    // entry 1: key "manifest" (8 bytes)
    8,
    0,
    0x6d,
    0x61,
    0x6e,
    0x69,
    0x66,
    0x65,
    0x73,
    0x74,
    3,
    0,
    0,
    0,
    1,
    2,
    3,
    // entry 2: key "log/000000" (10 bytes)
    10,
    0,
    0x6c,
    0x6f,
    0x67,
    0x2f,
    0x30,
    0x30,
    0x30,
    0x30,
    0x30,
    0x30,
    1,
    0,
    0,
    0,
    9,
  ])
  expect([...bytes]).toEqual([...expected])
  expect(decodeContainer(bytes)).toEqual({
    worldId: 'w1',
    entries: [
      { key: 'manifest', bytes: new Uint8Array([1, 2, 3]) },
      { key: 'log/000000', bytes: new Uint8Array([9]) },
    ],
  })
})

test('decode_container_bad_magic_throws', () => {
  expect(() => decodeContainer(new Uint8Array([0, 0, 0, 0]))).toThrow(ArchiveFormatError)
})

test('export_import_roundtrip_node', async () => {
  const storage = memoryStorage()
  const keys = worldKeys('w1')
  await storage.write(keys.manifest, new TextEncoder().encode('{"v":1}'))
  await storage.write(keys.log(0), new Uint8Array([1, 2, 3]))
  await storage.write(keys.snap(10), new Uint8Array([4, 5]))

  const archive = await exportWorld(storage, 'w1')
  const target = memoryStorage()
  const result = await importWorld(target, archive)
  expect(result.worldId).toBe('w1')

  const targetKeys = worldKeys('w1')
  expect(await target.read(targetKeys.manifest)).toEqual(new TextEncoder().encode('{"v":1}'))
  expect(await target.read(targetKeys.log(0))).toEqual(new Uint8Array([1, 2, 3]))
  expect(await target.read(targetKeys.snap(10))).toEqual(new Uint8Array([4, 5]))

  // Injected-defect proof (Rules and traps, "archive missing a key"): dropping a key from the
  // exported entries must make the round trip fail to reproduce it -- proves this assertion is not
  // vacuous. Proven here inline (not reverted, since nothing is mutated): a hand-built archive
  // missing `snap/...` really does leave it absent on import.
  const { worldId, entries } = await unpackArchive(archive)
  const droppedArchive = await packArchive(
    worldId,
    entries.filter((e) => !e.key.startsWith('snap/')),
  )
  const target2 = memoryStorage()
  await importWorld(target2, droppedArchive, { worldId: 'w2' })
  expect(await target2.read(worldKeys('w2').snap(10))).toBeNull()
})

test('export_import_roundtrip_under_a_new_id', async () => {
  const storage = memoryStorage()
  const keys = worldKeys('source')
  await storage.write(keys.manifest, new Uint8Array([1]))
  await storage.write(keys.log(0), new Uint8Array([2]))

  const archive = await exportWorld(storage, 'source')
  const result = await importWorld(storage, archive, { worldId: 'renamed' })
  expect(result.worldId).toBe('renamed')
  const renamedKeys = worldKeys('renamed')
  expect(await storage.read(renamedKeys.manifest)).toEqual(new Uint8Array([1]))
  expect(await storage.read(renamedKeys.log(0))).toEqual(new Uint8Array([2]))
  // The source world is untouched by an import under a different id.
  expect(await storage.read(keys.manifest)).toEqual(new Uint8Array([1]))
})

test('import_refuses_existing_world', async () => {
  const storage = memoryStorage()
  const sourceKeys = worldKeys('a')
  await storage.write(sourceKeys.manifest, new Uint8Array([1]))
  const archive = await exportWorld(storage, 'a')

  const existingKeys = worldKeys('b')
  await storage.write(existingKeys.manifest, new Uint8Array([9]))

  await expect(importWorld(storage, archive, { worldId: 'b' })).rejects.toThrow(WorldExistsError)
  // Injected-defect proof (Rules and traps, "import overwriting without `overwrite`"): the refused
  // import must not have touched the existing world's own bytes.
  expect(await storage.read(existingKeys.manifest)).toEqual(new Uint8Array([9]))

  // `overwrite: true` does go through, and does replace the existing bytes.
  const result = await importWorld(storage, archive, { worldId: 'b', overwrite: true })
  expect(result.worldId).toBe('b')
  expect(await storage.read(existingKeys.manifest)).toEqual(new Uint8Array([1]))
})

test('delete_world_removes_all_keys', async () => {
  const storage = memoryStorage()
  const keys = worldKeys('d')
  await storage.write(keys.manifest, new Uint8Array([1]))
  await storage.write(keys.log(0), new Uint8Array([2]))
  await storage.write(keys.snap(5), new Uint8Array([3]))
  await storage.write(keys.sessions, new Uint8Array([4]))

  await deleteWorld(storage, 'd')

  expect(await storage.list('worlds/d/')).toEqual([])
  expect(await storage.read(keys.manifest)).toBeNull()
  expect(await storage.read(keys.log(0))).toBeNull()
  expect(await storage.read(keys.snap(5))).toBeNull()
  expect(await storage.read(keys.sessions)).toBeNull()

  // Injected-defect proof: a `deleteWorld` that skips one key kind must make this assertion fail --
  // proven directly (not via mutating the source, which is committed): deleting only the manifest
  // key by hand still leaves the log key behind, showing the full-set assertion above is not
  // vacuous.
  await storage.write(keys.manifest, new Uint8Array([1]))
  await storage.write(keys.log(0), new Uint8Array([2]))
  await storage.delete(keys.manifest)
  expect(await storage.list('worlds/d/')).toEqual([keys.log(0)])
})

test('delete_world_on_an_unknown_id_is_a_no_op', async () => {
  const storage = memoryStorage()
  await expect(deleteWorld(storage, 'never-existed')).resolves.toBeUndefined()
})
