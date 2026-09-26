//! One shared integration-test binary for every `crates/engine` scenario/replay test that has no
//! reason to be its own process (docs/plan/24c-engine-edit-rebuild-time.md). Each former top-level
//! `tests/*.rs` file is now `tests/main/*.rs`, pulled in below with `#[path]` so cargo compiles and
//! links it once, as part of this one binary, instead of once per file.
//!
//! Why this doesn't apply to every `tests/*.rs` file: `no_alloc_*.rs` each install their own
//! `#[global_allocator]` to count only that file's own allocations, and Rust allows exactly one
//! global allocator per binary -- merging any two of them is a compile error, and merging one into
//! here would make it (wrongly) also count every other test's allocations. They keep their own
//! binaries. `runner_control.rs` is the runner's own permanent negative control
//! (`packages/engine/crates/engine/CLAUDE.md`); it stays separate too, deliberately not touched by
//! a change made for build-time reasons alone.
//!
//! `#[path]` (not moving these into a `mod` declared with a matching directory, which would work
//! identically) keeps every test's own module-relative code unchanged; only the reported binary
//! name changes (`engine::codec` -> `engine::main`, for example) -- `cargo nextest list`'s own
//! output changes exactly there and nowhere else (docs/plan/24c-engine-edit-rebuild-time.md
//! Deviations has the before/after comparison).
#[path = "main/action_round_trip.rs"]
mod action_round_trip;
#[path = "main/codec.rs"]
mod codec;
#[path = "main/connection_and_subscriptions.rs"]
mod connection_and_subscriptions;
#[path = "main/gen_queue.rs"]
mod gen_queue;
#[path = "main/module_layering.rs"]
mod module_layering;
#[path = "main/state_budget.rs"]
mod state_budget;
#[path = "main/state_budget_tick.rs"]
mod state_budget_tick;
#[path = "main/timers_wakeups.rs"]
mod timers_wakeups;
#[path = "main/undo_journal.rs"]
mod undo_journal;
#[path = "main/wgsl.rs"]
mod wgsl;
#[path = "main/world_cache_invisible.rs"]
mod world_cache_invisible;
#[path = "main/world_terrain.rs"]
mod world_terrain;
#[path = "main/worldgen_core.rs"]
mod worldgen_core;
#[path = "main/worldgen_noise.rs"]
mod worldgen_noise;
