# 0005: Persistence, upgrades and crash recovery

Status: Accepted (2026-09-19). Amended by [0024](0024-planning-amendments.md) §2, §3, §4, §8.

## Context

Requirements in [`../spec/simulation.md`](../spec/simulation.md): the engine manages storage in the browser and on the server; snapshots are occasional and exist for crash recovery; actions are kept indefinitely; idle worlds pause; upgrades may invalidate saves behind a clean error and an optional `migrate` hook, and old binaries are not archived; export/import is in scope. Forces: a browser tab has no reliable shutdown hook, so a "final save" cannot be the durability mechanism; Safari deletes script-writable storage after 7 days of browser use without interaction; OPFS sync access handles are exclusive and worker-only; a Rust panic traps and poisons the WASM instance; a log replays only against the `.wasm` that produced it ([0002](0002-determinism-same-wasm-everywhere.md)).

## Decision

**Formats.** postcard 1.x (through `Codec`, [0003](0003-game-facing-api.md)) for action payloads and the engine `Store`, inside hand-written engine containers. Bulk tile overlays are written as raw little-endian arrays, bypassing serde.

- *Sim identity*: the first 128 bits of the build hash (SHA-256 of the `.wasm` file, computed once by the build: [0017](0017-packaging-and-build.md)), plus readable `engine_version`, `game_version`, `SCHEMA_VERSION`, `tick_rate_hz` and the worldgen stamp (`WORLDGEN_VERSION` + fingerprint, [0007](0007-world-model.md)). The handshake carries the full 32 bytes of the same hash ([0013](0013-sessions-and-integrity.md)).
- *Snapshot* = `magic | container_version u16 | identity | tick u32 | log position (segment, byte offset) | engine section (tick, SimRng, player table, id counters, overlays, entities, active lists and timers in canonical order) | state_hash u64 | crc32`. Taken at a tick boundary; the log position is the first frame after that tick. Written to a temp key, then atomically replaced; the previous snapshot is kept until the new one verifies.
- *Log* = a sequence of **segments**. A segment header carries the identity and names its base snapshot (segment 0's base is genesis: seed + world params). A segment holds one **frame** per tick that had actions: `len varint | tick_delta varint | count varint | records | crc32`; a record is `kind u8 | player_slot u8 | payload`. Kinds: game action (payload = `seq varint | G::Action`; the `seq` is what lets replay rebuild each player's last processed `seq`, [0004](0004-action-timing-and-rejection.md)), connection event, `Skip`. Ticks without actions are not logged; they are implied by `tick_delta`.
- No compaction: the full log from tick 0 is kept (sizes: [0004](0004-action-timing-and-rejection.md)). Snapshots are pruned to the base snapshot of every segment plus the latest two. Sealed segments may be gzip-compressed with `CompressionStream`.

**Cadence.** A snapshot every **60 s of sim time (1,200 ticks at 20 Hz)** if anything changed, plus at every clean boundary the host can detect: zero-player pause, server shutdown signal, browser `visibilitychange -> hidden` and `pagehide` (best effort, never relied on). Log frames are handed to `append` **before** they are applied (write-ahead); the storage `sync` barrier runs at most once per second when dirty. When an appended frame counts as durable depends on the adapter (table under Storage).

**Loss windows.**

| Event | Admitted actions lost | Action-free sim progress lost |
|---|---|---|
| Tab close, worker or renderer crash, WASM panic | 0 (at most the one in-flight frame) | up to 60 s (1,200 ticks) |
| OS crash or power loss on any local-disk adapter; server process killed (`fs` adapter) | up to 1 s | up to 60 s |
| Server on an object-store adapter (batched appends) | up to 2 s | up to 60 s |

After a crash the world resumes at max(latest snapshot tick, last logged frame tick). Lost idle progress (a furnace re-smelts a few ingots) is indistinguishable from the tab having been paused.

**Recovery** = newest snapshot whose CRC verifies, seek to its log position, re-apply frames until the first truncated or CRC-failing frame (truncate there), resume. Afterwards the host bumps the **session epoch**; clients seeing a new epoch drop predicted and interpolated state and take a full resync ([0013](0013-sessions-and-integrity.md)).

**Upgrades.** On load, if the running identity hash differs from the stored one: load the latest snapshot (directly if `SCHEMA_VERSION` and `tick_rate_hz` match; otherwise through `G::migrate`, and if that returns `SaveIncompatible` the engine reports `SaveIncompatible` to the game's TypeScript and leaves every file untouched); re-execute the short log tail with the new code and mark the old segment `tail_reexecuted`; write a snapshot; seal the old segment; open a new segment based on that snapshot. Re-executing the tail is safe because `apply` always validates ([0001](0001-camera-and-presence.md)); at worst an action is now rejected. Old segments stay replayable only by rebuilding the binary their header names from git.

**Storage.** One injected interface, the `storage` member of the host services in [0009](0009-transport-and-hosting.md):

```ts
interface Storage {
  // write side: called from the tick path, return value never awaited there
  append(key: string, bytes: Uint8Array): void | Promise<void>;
  sync(key: string): void | Promise<void>;                  // durability barrier; may be a no-op
  write(key: string, bytes: Uint8Array): void | Promise<void>;   // atomic replace (snapshots, manifest, sessions)
  delete(key: string): void | Promise<void>;
  onError: ((err: unknown) => void) | null;                 // set by the host; a failed or lost write is fatal to the world (0004)
  // off the tick path only: load, recovery, pause, shutdown, export
  flush(): Promise<void>;                                   // resolves when everything handed over so far is durable
  read(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
}   // keys: worlds/<id>/manifest, log/<segment>, snap/<tick>, sessions
```

**The tick path never awaits storage and, in steady state, no shipped adapter allocates a promise on it.** The sim host is one code base for the sim worker and the server ([0015](0015-threads-memory-and-topology.md)): it calls `append`/`sync`/`write`/`delete`, ignores the return value, and learns of failure only through `onError`. `bytes` is an engine-owned view valid only during the call, so an adapter either consumes it synchronously or copies it. Calls on one key take effect in call order. The host awaits `flush()` at the clean boundaries of Cadence (pause, `stop()`, before export) and nowhere else. `void | Promise<void>` exists for deployer-written adapters whose backend is promise-only; their allocation is their own, and only the browser is held to [0016](0016-zero-gc-definition.md).

| Adapter | `append` does | A frame is durable | `write` (snapshot) |
|---|---|---|---|
| Browser OPFS | synchronous `write` at the end offset of a sync access handle opened at load; returns `void` | against tab close, worker crash and WASM panic: when `append` returns. Against OS crash or power loss: at the next `sync` (synchronous `flush()`, ≤ 1 s) | synchronous write + `flush()` into a scratch file whose handle was opened in advance; the rename to `snap/<tick>` and the opening of the next scratch handle are promise-only OPFS calls, started and not awaited (a few promises per 60 s; the worker reaches its event loop through the `yield` flag of [0015](0015-threads-memory-and-topology.md)) |
| Node / Bun / Deno `fs` | copies into a preallocated in-memory buffer; returns `void` | when the asynchronous `write` + `datasync` started by `sync` (≤ 1 s) or by a full buffer completes, off the tick path. Against a WASM panic: when `append` returns (the JS host and its buffer survive) | temp file, `datasync`, `rename`, all asynchronous after one copy |
| Object store, Durable Object (deployer-written) | copies into a buffer | when the numbered part object is stored; parts are cut at most every 2 s | one object put |
| Memory | copies | never (`durable: false`) | replaces the value |

These are the durability points behind the loss windows above. Recovery needs no atomic rename to be safe: it takes the newest snapshot whose CRC verifies, so a torn or unrenamed snapshot only means the previous one is used.

- *Browser*: OPFS with sync access handles, owned by the sim worker (a dedicated worker). The worker holds `navigator.locks.request("world:<id>", { ifAvailable: true })` for its lifetime; if unavailable the engine reports `WorldBusy` ("open in another tab"). The exclusive OPFS handle is the backstop. The main-thread entrypoint calls `navigator.storage.persist()` once after a user gesture at world creation (the method is not exposed in workers) and exposes `{ persisted, usage, quota }`; the answer is never relied on. No OPFS (Safari private mode): an in-memory adapter and `durable: false`.
- *Server*: the engine ships a Node `fs` adapter (built-in module, zero npm dependencies) and the memory adapter. Hosts without files (Durable Objects, object stores) get a deployer-written adapter that emulates `append` with numbered part objects; per-frame CRCs tolerate a partial last part.
- *Export/import*: `exportWorld(id)` streams one gzip file holding the manifest, all segments, the pruned snapshot set and the session table; `importWorld(bytes)` writes them through `Storage` and then takes the normal load path, including the upgrade path. This is the only real protection against Safari's 7-day eviction, and the move from single-player to hosted.

**Single-player to hosted.** Works by construction: same `.wasm`, same containers, same keys, and single-player logs `Joined`/`Connected` under a real `PlayerId`. Export, import on the server, and the same browser secret reclaims the same player ([0013](0013-sessions-and-integrity.md)). With an identical binary the log continues in the same segment.

**Panic recovery.** The sim builds `panic=abort` on stable Rust; any trap means the instance is garbage.
1. The host wraps every export call in `try/catch`; on `WebAssembly.RuntimeError` it never calls that instance again. The compiled `WebAssembly.Module` is kept, so a new instance is cheap. The panic message leaves through an output-only `engine.panic(ptr, len)` import ([0014](0014-js-wasm-boundary.md)).
2. Fresh instance, latest valid snapshot, replay the log tail, bump the session epoch, resume. Sockets stay open (the JS host survived); clients see `Resyncing`, then the reconnect-style full resync. Single-player is identical over the worker channel; if the worker itself dies the main thread respawns it.
3. A panic is deterministic, so replay may hit it again. If it recurs inside `apply` of one record, the host appends a **`Skip { segment, offset }`** record, restarts recovery honoring it, and acks the sender with `EngineFault` ([0004](0004-action-timing-and-rejection.md)). The log stays append-only and replay stays exact, because skip records are part of the log.
4. If it recurs inside `tick`, the world is wedged under this build: stop, keep all files, raise `onFatal({ tick, message })`. A fixed build then loads the last snapshot through the upgrade path. A failed `memory.grow` takes the same route ([0015](0015-threads-memory-and-topology.md)).

**Idle pause is replay-safe by construction.** The core has no clock; only the host calls `tick`. Pausing (zero players after the grace period, or a hidden single-player tab; lifecycle in [0013](0013-sessions-and-integrity.md)) means the host snapshots and stops calling `tick`; the counter stops, and nothing about the pause is logged. When a timer fires late the host runs at most 5 catch-up ticks per wakeup and lets sim time fall behind wall time. Replay runs ticks as fast as it can.

## Alternatives rejected

- **bincode** (unmaintained, RUSTSEC-2025-0141), **bitcode** (format stability is a stated non-goal), **rkyv** (zero-copy is wasted on small worlds; archived types leak into game code), **a hand-rolled derive** (a proc-macro project for no gain).
- **A self-describing, evolvable snapshot format** (CBOR, protobuf): pays size on every snapshot to automate only the easy migrations.
- **Log compaction behind snapshots**: contradicts the Requirement and saves tens of MB at most.
- **Hand-bumped "sim version" as identity**: forgotten exactly when it matters; a toolchain bump can change codegen. **Cross-version replay from tick 0**: unsound by definition. **Archiving old binaries**: declined by Tyler.
- **IndexedDB as primary** (no append; structured clone and event garbage per write), **localStorage** (5 MiB, blocks the main thread), **SQLite-WASM** (a large dependency for a problem we do not have).
- **`panic=unwind` recovery**: needs nightly and `-Zbuild-std`, and OOM and stack overflow still abort.
- **Relying on a final save at tab close**: no such hook exists on mobile.

## Consequences

- The sim worker must be a dedicated worker, and single-player storage lives with the sim worker, not the client worker ([0015](0015-threads-memory-and-topology.md)).
- A changed `.wasm` always starts a new segment, even for a rules-only change; history before the boundary is verifiable only with the old binary.
- Engine-to-UI events the TypeScript surface must carry: `SaveIncompatible`, `WorldBusy`, `durable: false`, storage estimate, `Resyncing`, `onFatal`.
- Heavy mode ([0002](0002-determinism-same-wasm-everywhere.md)) is the test that snapshots capture all state; recovery, skip records, torn-frame truncation and the upgrade path each need a scripted test ([0020](0020-testing-strategy.md)).
- Deferred to Phase 2: OPFS append/flush latency on iOS Safari, because it only tunes the 1 s sync interval and needs a device. Deferred to Phase 2: the `OldStore` shape handed to `migrate` ([0003](0003-game-facing-api.md)), because no second schema exists yet.

## Sources

- [`../research/simulation.md`](../research/simulation.md) 1.3, 1.4, 1.6, 1.7, 3.4-3.6, 3.8, 3.10, 3.11, 3.13
- postcard stable wire format (1.1.3, checked 2026-09-19): https://postcard.jamesmunns.com/ ; bincode advisory: https://rustsec.org/advisories/RUSTSEC-2025-0141.html
- OPFS sync handles: https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle ; state of OPFS, May 2026: https://powersync.com/blog/sqlite-persistence-on-the-web
- Quotas and eviction: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ; Safari 7-day rule: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ; `persist()` is Window-only: https://storage.spec.whatwg.org/#api
- Web Locks: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API ; `CompressionStream`: https://web.dev/blog/compressionstreams
- Panics and re-instantiation: https://blog.cloudflare.com/making-rust-workers-reliable/ ; timer throttling: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Factorio version-locked replays and migrations: https://lua-api.factorio.com/latest/auxiliary/migrations.html
