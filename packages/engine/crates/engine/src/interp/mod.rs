//! Remote-motion interpolation (M30; 0012 "Remote motion:
//! interpolation, not prediction"; 0010 Rates "Interpolation delay"): [`InterpBuffer`] turns a
//! stream of `{ t, pos, vel }` samples into a position at any render time (Hermite between
//! samples, bounded extrapolation, hold, fade); [`JitterStats`] and [`InterpDelay`] choose the
//! render time so it trails the host by an adaptive delay that is slewed, never stepped.
//!
//! **Float, client-only.** Everything here uses `f64`/`f32` (never hashed, 0003) and must never be
//! reachable from `apply`/`tick`. Timebase: host ticks as `f64` (`HostClock::now_f64`).

mod buffer;
mod delay;
mod jitter;

pub use buffer::{Interp, InterpBuffer, InterpKey, InterpMode, PushResult};
pub use delay::InterpDelay;
pub use jitter::JitterStats;
