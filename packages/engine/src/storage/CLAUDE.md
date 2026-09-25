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

- `opfs.ts` (docs/plan/23-persistence-opfs-and-lifecycle.md steps 1-2): `opfsStorage(worldId)` --
  the OPFS row of the 0005 Storage table, browser-only, sim worker only (0015). Rejects with
  `OpfsUnavailable` when `getDirectory()`/the first `createSyncAccessHandle()` fails. Keys map onto
  nested OPFS directories one-for-one on `/`. `append`/`sync`'s fast path is a plain (non-`async`)
  method returning `undefined`, no options object (a reused `APPEND_SEEK`, `.at` overwritten, seeks
  once at open; every later `append` is a bare `write(view)`, cursor auto-advancing) -- an `async`
  function always allocates a Promise even doing nothing async, which would cost the sim worker's
  zero-GC budget every tick (`.claude/rules/hot-paths.md`, Planning decision 4). `write` (snapshot/
  manifest/sessions) writes synchronously into an already-open `.scratch` handle and returns
  `undefined`; the promise-only half (close, `move()` onto the real key, reopen the next scratch)
  is queued as one closure behind `pendingAsync()` -- the sim worker's own future hook, not wired in
  yet, built and tested here (`storage-opfs.spec.ts`). `scratchReady()`/`snapshotDeferred` are for
  that same future caller (Planning decision 2); a `write()` with no scratch ready falls back to a
  direct, still-correct, non-allocation-free write, draining any queued continuation first so calls
  land in call order. `read`/`list` consult an in-flight-write map first, so a caller sees its own
  write immediately regardless of path. Decision 3 (Deviations): rename, not slot files --
  `FileSystemFileHandle.move()`'s 2-arg form (`move(directory, name)`) works in Chromium, WebKit and
  Firefox (WebKit's own 1-arg form throws) and overwrites an existing destination. Ambient types
  (`createSyncAccessHandle`/`move`/`FileSystemSyncAccessHandle`, missing from `lib.dom.d.ts`) live in
  `opfs-types.d.ts`, listed directly in any tsconfig that doesn't transitively import `opfs.ts`
  (`../virtual.d.ts`'s own pattern). Test-only: Playwright's WebKit needs a real, on-disk profile for
  OPFS at all (`launchPersistentContext`, not the default ephemeral context) -- any spec touching
  OPFS uses `tests/browser/support/opfs-context.ts`'s `test`/`expect`, not the default ones -- and
  does not isolate OPFS per profile the way Chromium/Firefox do, so a page using non-namespaced keys
  wipes the whole OPFS root once at the very start (never in `opfsStorage` itself).
