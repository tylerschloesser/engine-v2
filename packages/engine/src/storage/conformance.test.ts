// docs/plan/22-persistence-log-and-snapshots.md Tests added: `storage_conformance_memory`. Needs
// no `.wasm` fixture (unlike the rest of this milestone's own Persistence tests, `tests/wasm/
// persistence.test.ts`), so it lives beside its source per `packages/engine/CLAUDE.md`'s own
// convention ("unit: *.test.ts beside the source in src/").
import { expect, test } from 'vitest'
import { runStorageConformance } from './conformance.js'
import { memoryStorage } from './memory.js'

test('storage_conformance_memory', async () => {
  const passed = await runStorageConformance(() => memoryStorage())
  expect(passed).toEqual([
    'write_then_read',
    'read_missing_key_is_null',
    'append_accumulates_in_call_order',
    'write_after_append_then_append_lands_after',
    'write_after_append_survives_sync_and_flush',
    'delete_removes_the_key',
    'list_returns_matching_keys_sorted',
    'sync_never_throws_on_an_unknown_key',
    'flush_resolves',
  ])
})
