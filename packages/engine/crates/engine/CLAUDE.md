# engine crate (Rust side)

The crate game authors path-depend on; it and the game crate compile into one WASM module. It ships inside the npm package (`files` lists `crates`).

## Workspace

A member of the root cargo workspace. These live at the repo root, not here: profiles and `[workspace.lints]` (`Cargo.toml`), the clippy ban lists (`clippy.toml`, owned by `docs/decisions/0002-determinism-same-wasm-everywhere.md` §3), the toolchain pin (`rust-toolchain.toml`), nextest profiles (`.config/nextest.toml`). This crate's `Cargo.toml` inherits `version`, `edition`, `publish` and `lints` from the workspace.

`[profile.dev.package."*"]` covers only non-member dependencies, so this crate builds at the dev `opt-level` (0024 §13).

## Commands

- `pnpm test rust [-t <name>]`: nextest over the workspace; `-t` is a substring of the test name. Raw `cargo nextest run` and `cargo test` also work.
- `pnpm lint` runs `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`. `pnpm format` fixes formatting.
- On macOS, native linking needs `DEVELOPER_DIR` when the Xcode licence is not accepted; the scripts set it (`scripts/lib/env.mjs`). For a bare `cargo` call that links: `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo …`.

## Layout

- `src/abi/`: the JS↔WASM boundary (0014). `registry.rs` is the single owner of the ABI and states the rule for adding to it; `mod.rs` holds what the exports do; `boot.rs`, `regions.rs`, `arena.rs`, `panic.rs`, `config.rs` are the pieces. `panic::fatal` exists because std formats a panic message into a `String` before the hook runs: use it, not `panic!`, anywhere the allocator may be the failure.
- `src/hash.rs`: `Fnv64`. `src/testing/` (feature `testing`, dev-dependencies only): `golden_bytes` (`assert_golden`, `assert_golden_bytes!`/`assert_golden_hash!`), `cache_matrix` (below).
- `src/world/` (0007): `tile.rs`/`coords.rs`/`traits.rs` are plain data; `overlay.rs` is the sparse per-chunk state (`ChunkOverlay`, `Overlays`); `cache.rs` is the dense LRU slab pool (`CacheCapacity`/`CacheEvent` are its only public seam); `terrain.rs`'s `TerrainStore` composes them. **The cache is not state**: never serialized, hashed, or part of `modified_tiles`; `TerrainStore::tile`/`materialize` take `&self` (a `RefCell` inside) because a read may generate and evict. No method here returns a reference into a slab -- reads return `Tile` by value, `copy_chunk` copies out.
- Adding or changing anything that touches the cache: prove invisibility with `engine::testing::assert_cache_invisible(|cfg| { .. build a store at cfg.capacity, prewarm with cfg.prewarm, run a script, return checkpoints .. })` (feature `testing`) -- it replays your closure at capacity 1, the default and `Unlimited`, crossed with three prewarm orders, and fails if any leg's checkpoints differ. `world_cache_invisible.rs`'s `cache_invisible_matrix` is the reference caller.
- `src/game.rs` (0003, M12): the `Game` trait, ids (`PlayerId`, `EntityId`), `Unknown`, `PlayerEvent`, `Presence`, and every shell 0003 needs declared now (`TickCx`, `FrameCx`, `FrameView`, `DrawList`, `PresenceTable`, `OldStore`, `SaveIncompatible`) plus the empty `WorldRead`/`WorldWrite` shell traits its method signatures require -- all filled in by the milestone named on each. `src/time.rs`: `Tick`, `Ticks`, `TickRate` (conversions are M12b's). `src/rng.rs`: `SimRng` (hand-rolled PCG32, 0002 "Randomness"). `src/delta.rs`: the engine-defined `Delta<G>` (0011, plus the engine-only `Roster` variant of 0024 §8). `src/store.rs`: `Store<G>` -- tile overlays (`TerrainStore`), entities, players, global -- whose only mutator is `apply(&Delta<G>)`; canonical `encode`/`decode` and `impl StateHash`.
- Determinism rules for everything here: `.claude/rules/determinism.md`. `world/cache.rs` also carries `.claude/rules/hot-paths.md` (reads are per-tick).

## Tests

- Unit tests inline (`#[cfg(test)] mod tests`); scenario and replay tests in `tests/*.rs`.
- Slow tier: name the test function `slow_*`. `pnpm test` filters it out; `pnpm test:slow` runs only those.
- `tests/runner_control.rs` is the runner's permanent negative control (fails only under `pnpm test --self-check-fail`). Keep it.
- `cargo fmt --check` only sees files in a target's module tree: a stray `.rs` outside `src/` or `tests/` is never checked.

## Dependencies

Policy and the exact allowed list: `docs/decisions/0017-packaging-and-build.md` §7. Anything else needs an ADR (`write-adr` skill). Dev-dependencies are unrestricted.

## One crate, for now

`crates/` holds one crate named `engine`. The triggers for splitting it (compile budget, lint scope, a proc-macro) and the constraints on any split are in `docs/plan/01-scaffolding.md`, Planning decisions (b), until an ADR replaces them.
