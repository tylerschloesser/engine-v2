# packages/engine/src/storage

The 0005 `Storage` contract (`docs/decisions/0005-persistence-and-recovery.md` "Storage") and its
first two adapters. Full context: `../CLAUDE.md`'s own `storage/` bullet.

- `types.ts`: the `Storage` interface, declared exactly as 0005 (`server.ts` re-exports it
  unchanged -- no renamed Provides). `worldKeys(worldId)` builds the four namespaced keys
  (`manifest`, `log(segment)`, `snap(tick)`, `sessions`), zero-padding `segment`/`tick` so a
  lexicographic `Storage.list()` sorts them numerically too.
- `memory.ts`: `memoryStorage()`/`MemoryStorage` -- never durable (0005's own table), the
  Safari-private-mode fallback and the double every other adapter's conformance is measured
  against. `crashClone(opts)` returns an independent copy, optionally with named keys' trailing
  bytes dropped (simulating a torn `append`/`write`).
- `conformance.ts`: `runStorageConformance(make)` -- the 0005 contract's own behavioural checks
  (write-then-read, append order, delete, `list` prefix/sort, `sync`/`flush` never throwing).
  Deliberately import-free of any test runner, so a browser page (M23) can call it directly.
- `fs.ts` (docs/plan/22b-persistence-load-and-fs.md step 4): `fsStorage(dir)`, exported only from
  `engine/server/node` (the name M27/M35b use) -- zero npm dependencies, `node:fs/promises` only.
  Per open log key: two preallocated 1 MiB buffers, `append` copies into the "front" one; a full
  buffer or `sync()` rotates it into an async `fs.write` + `fdatasync` chain and checks a fresh
  buffer out of the pool; a third pending flush while both are mid-flight allocates a one-off grown
  buffer and counts it (`fsBufferGrows`, a test-only counter reached through `createFsStorageDebug`,
  never widening the `Storage` interface itself). `write` (snapshot/manifest/session, "atomic
  replace") is a separate path: temp file, `datasync`, `rename`. `read`/`list` await a live
  appender's own `sync()` first (0005: both are off the tick path only), so a key just `append`ed to
  reads back correctly without a caller needing its own explicit `sync()`.

Every adapter here copies `bytes` before returning (0005: "an engine-owned view valid only during
the call"), never retains the argument itself.

- `opfs.ts` (docs/plan/23-persistence-opfs-and-lifecycle.md): `opfsStorage(worldId)` -- the OPFS row
  of the 0005 Storage table, browser-only, sim worker only (0015). Rejects with `OpfsUnavailable`
  when `getDirectory()`/the first `createSyncAccessHandle()` fails. Keys map onto nested OPFS
  directories one-for-one on `/`. **Rules**: `append`/`sync`'s fast path is a plain (non-`async`)
  method, no options object (one reused seek object, `.at` overwritten, at open only) -- an `async`
  function always allocates a Promise even doing nothing async (`.claude/rules/hot-paths.md`).
  `write()`'s promise-only half (close scratch, `move()`, reopen) is one closure behind
  `pendingAsync()`, polled and self-yielded through `shell.runAsync` from `worker/sim.ts`'s `body()`
  after every pass -- never awaited on the tick path. `append`'s first-ever-open per key is
  serialized through one `#appendChain` (two un-awaited `append()`s to a new key otherwise race
  `createSyncAccessHandle`); `read`/`list` consult an in-flight-write map so a caller sees its own
  write immediately regardless of path. Rename, not slot files: `FileSystemFileHandle.move()`'s
  2-arg form works in Chromium, WebKit and Firefox (WebKit's 1-arg form throws) and overwrites an
  existing destination. Ambient types live in `opfs-types.d.ts`. Test-only: Playwright's WebKit needs
  `launchPersistentContext` for OPFS at all, and does not isolate it per profile, so a spec using
  non-namespaced keys wipes the whole root once at the start (`tests/browser/support/opfs-
  context.ts`), never inside `opfsStorage` itself.
- `archive.ts` (docs/plan/23-persistence-opfs-and-lifecycle.md step 5): `exportWorld`/`importWorld`/
  `deleteWorld`, plain functions over any `Storage` (re-exported unchanged from `server.ts`). Archive
  = gzip of `magic | version u16 | worldIdLen u16 | worldId | count u32 | (keyLen u16 | key relative
  | dataLen u32 | data)*`, keys relative to `worlds/<id>/` so import can re-root under a different
  id. `importWorld` refuses an existing target id without `overwrite` (`WorldExistsError`). Every
  OPFS adapter instance shares the same origin-wide root (`getDirectory()`), so the *running* world's
  own already-open `storage` reaches any other world's keys too -- `worker/sim.ts`'s export/import/
  delete request handler never opens a second `opfsStorage()` instance for a different id.
  `zero_gc_singleplayer_with_snapshot`'s own `forceSnapshot()` (`engine/test`, `gc-test` skill) is the
  deterministic way to land one real snapshot inside a measured zero-GC window.
