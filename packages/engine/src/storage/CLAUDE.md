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
