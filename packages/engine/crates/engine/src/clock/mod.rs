//! The client's own wall-clock estimation (docs/plan/26-prediction-rendering-and-clocks.md
//! Planning decisions: "`HostClock` lives here, not in M30"): [`HostClock`] turns a stream of
//! `(tick, arrived_ms)` samples into a smooth, monotone estimate of "what tick is it *right now*"
//! even between frames (0010: idle ticks send nothing, so a clock that only stepped on frames
//! would freeze a bar for up to a heartbeat); [`LeadEstimator`] turns a stream of ack samples into
//! the round-trip lead 0012's "Two clocks" adds to the authoritative tick.
//!
//! Neither type names `Game` or `ClientCore`: both are plain estimators over `Tick`/`Ticks`,
//! driven by `client::core::ClientCore` (`.claude/rules/hot-paths.md` governs that call site, not
//! this module -- see each type's own doc comment for its own allocation story).

mod host_clock;
mod lead;

pub use host_clock::HostClock;
pub use lead::LeadEstimator;
