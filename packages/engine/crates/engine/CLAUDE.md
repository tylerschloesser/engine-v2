# engine crate (Rust side)

The crate game authors path-depend on; it and the game crate compile into one WASM module. It ships inside the npm package (`files` lists `crates`).

## Workspace

A member of the root cargo workspace. These live at the repo root, not here: profiles and `[workspace.lints]` (`Cargo.toml`), the clippy ban lists (`clippy.toml`, owned by `docs/decisions/0002-determinism-same-wasm-everywhere.md` §3), the toolchain pin (`rust-toolchain.toml`), nextest profiles (`.config/nextest.toml`).

This crate's `Cargo.toml` inherits `version`, `edition`, `publish` and `lints` from the workspace.

`[profile.dev.package."*"]` covers only non-member dependencies, so this crate builds at the dev `opt-level` (0024 §13).

## Commands

- `pnpm test rust [-t <name>]`: nextest over the workspace; `-t` is a substring of the test name. Raw `cargo nextest run` and `cargo test` also work.
- `pnpm lint` runs `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`. `pnpm format` fixes formatting.
- On macOS, native linking needs `DEVELOPER_DIR` when the Xcode licence is not accepted; the scripts set it (`scripts/lib/env.mjs`). For a bare `cargo` call that links: `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo …`.

## Layout

One line per module; each module's `//!` doc comment has the detail and names its milestone brief.

- `abi/` (0014): the JS↔WASM boundary. `registry.rs` is the single owner of the ABI, every export and its status, and `ABI_VERSION`. Use `panic::fatal`, not `panic!`, anywhere the allocator may be the failure (std formats the message into a `String` first).
- `game.rs` (0003): the `Game` trait, ids, `Unknown`, `PlayerEvent`, and re-exports so callers import `WorldRead`/`WorldWrite`/`TickCx`/`FrameCx`/`Presence`/... from `crate::game`.
- `world_access.rs` (0003): `WorldRead`/`WorldWrite`, `View`. `authority.rs`: `Authority<G>`, scopes, the undo journal, `TickCx`.
- `sim/` (`Sim<G>`, the host driver; `timers`/`wake`/`active`, `pub(crate)`), `store/` (`Store<G>`, whose only mutator is `apply(&Delta<G>)`; `index.rs`'s `ChunkIndex`), `delta.rs`, `budget.rs` (state budget, 0004/0023), `rng.rs` (`SimRng`, PCG32), `time.rs`, `hash.rs` (`Fnv64`), `codec.rs`, `bytes.rs`.
- `world/` (0007): tiles, coords, overlays (never sort by `ChunkCoord`'s derived `Ord`, `(x, y)`: the wire order is `(cy, cx)`, so every sort site keys `(c.y, c.x)`; `Replica::region_hash` once iterated the other way and diverged from `Host`'s; per-tick scratch sorts use `host::insertion_sort_by_key`, since `[T]::sort_by_key` may allocate), `cache.rs` (the dense LRU slab pool), `terrain.rs`'s `TerrainStore`. `worldgen.rs`, `noise.rs`, `gen_queue.rs`, `view.rs` (0008).
- `host/`: `Host<G>`, the sim-role instance and connection table; `subs.rs` (subscriptions, 0010), `warm.rs`, `pacing.rs`. `session/`: handshake codecs (0013).
- `client/`, `client.rs`: `Replica<G>`, `ClientCore<G>`, drawlist, `FrameView`, `FrameCx`, input, upload, UI. `predict/` (0012; `.claude/rules/prediction.md`). `interp/`, `clock/`: float, client-only, never reachable from `apply`/`tick`.
- `game_instance.rs`: `GameInstance<G>`, what `export_game!` points at; dispatches each role to `Host<G>`, `GenCore`, or `ClientInstance<G>`.
- `integrity.rs` (0013, M31b): the one chunk/`Global`/player hash both `Host` and `Replica` call (snapshot `version` written as 0: bookkeeping, not state), `DesyncLog` (ring of 16 + counter). Schedule: `host/hashes.rs` (`HashMode` `Off | Production | All`, default `Production`; `Off` is for scenarios pinning non-hash bytes); wire: `wire/hashes.rs`.
- `presence.rs` (0001/0019 presence channel), `persist/` (own `CLAUDE.md`), `wire/` (own `CLAUDE.md`), `migrate.rs` (0005 upgrades).
- `testing/` (feature `testing`, dev-dependencies only): `golden_bytes`, `cache_matrix`, `testkit` (`run_script`, `Loopback<G>`), `budgets` (reads `packages/engine/budgets.json`), `replay`, `worldgen_contract`. Replay/heavy hash tests cannot see (a) restore silently reusing the live instance (prove decode with a corrupted snapshot that must return `Corrupt` from `sim_restore_push`) or (b) a self-consistent relative-encoding error: the `sim_segment_header` reset of `last_logged_tick`/`log_ref_tick` is pinned by no test, so keep it when touching `sim_segment_header`, `sim_restore_end` or heavy mode. Heavy-mode fast tests need a state-dependent action (`Roll`) well past several N=25 boundaries, else dropping the restored `SimRng` passes.

## Seam rules

- Determinism rules for everything here: `.claude/rules/determinism.md`. `world/cache.rs` also carries `.claude/rules/hot-paths.md`.
- **`host/` and `client/` are outside the deterministic core: they may read subscriptions and cameras; `sim/` may not import them** (nor may `store/`, `world/`, `authority.rs`, ...: `tests/main/module_layering.rs` lists the exemptions). That is why `budget.rs` is not under `host/`.
- **The cache is not state**: never serialized, hashed or part of `modified_tiles`. `TerrainStore::tile`/`materialize` take `&self` (a `RefCell` inside); nothing returns a reference into a slab. `Store<G>` embeds `TerrainStore`, which embeds the cache, so the overlay write sees the pristine value and replicas applying `Delta::Tile` stay canonical (writes materialise the chunk first). A change touching the cache proves invisibility with `testing::assert_cache_invisible` (`tests/main/world_cache_invisible.rs` is the reference caller).
- **`ChunkIndex` is derived**: never encoded or hashed, rebuilt by `Store::rebuild_indexes`. **Timers, the wake queue and active lists are sim state**: encoded and hashed (0007 §7).
- **Presence never enters `Store`, the log or a hash** (`presence.rs`). **The Hello camera report is never copied into `ConnSlot.camera`** (`client_hello()` sends a zeroed but parseable one; it subscribed around (0,0) on the attach tick): `Host::attach` seeds only `initial_camera` and the resume hint, `connect` keeps `None`.
- **Puts through `TickCx` never auto-wake**; only `Authority`'s own `WorldWrite` (from `apply`/`on_player`/`genesis`) does.
- "Validate first, write after" is enforced: a rejecting `apply` that wrote panics in debug/test builds and is rolled back by the undo journal in release ([0037](../../../../docs/decisions/0037-undo-journal-adopted.md)).
- **`extract` is pure over `FrameView`**: iterate `entities()`, never allocate; positions are `WorldPos`. `frame` mutates (`FrameCx`), `extract` reads.

## Tests

- Unit tests inline (`#[cfg(test)] mod tests`). A stale `target/` carrying `com.apple.provenance` (`xattr target`) costs 5.5 s on every fresh test binary's first launch (577 s `unit` vs 36-40 s): `mv target target-old` and rebuild cold (40-90 s); keep scratch `target-*` dirs outside the repo (`context-artifacts.test.mjs` `ENOBUFS`). A scenario or replay test is `tests/main/<name>.rs` plus a `#[path = "main/<name>.rs"] mod <name>;` line in `tests/main.rs`, never a bare `tests/<name>.rs` (one linked binary, M24c; `scripts/lib/engine-test-binary-layout.test.mjs` enforces it).
- A top-level `tests/*.rs` binary needs a real isolation reason: its own `#[global_allocator]` (`no_alloc_*.rs`) or the runner's negative control (`runner_control.rs`: keep it, keep it separate; it fails only under `pnpm test --self-check-fail`).
- `no_alloc_*` measures `abi::arena::thread_live_bytes()` (calling thread only, a difference of two readings), never the process-wide `live_bytes()` (M30c); the counter is net (allocated minus freed), so an alloc/free pair is invisible and a flat rise is real growth, never "churn" (M15 blamed BTreeMap churn for 90 B/tick; it was three unbounded Host growers). `no_alloc_codec.rs`'s `instrument_counts_the_measuring_thread_only` is the control.
- Slow tier: name the test function `slow_*`. `pnpm test` filters it out; `pnpm test:slow` runs only those.
- `cargo fmt --check` only sees files in a target's module tree: a stray `.rs` outside `src/` or `tests/` is never checked.

## Dependencies

Policy and the exact allowed list: `docs/decisions/0017-packaging-and-build.md` §7. Anything else needs an ADR (`write-adr` skill). Dev-dependencies are unrestricted.

## One crate, for now

`crates/` holds one crate named `engine`. The triggers for splitting it (compile budget, lint scope, a proc-macro) and the constraints on any split are in `docs/decisions/0067-phase-3-decisions-runtime-packaging-hosting.md`.
