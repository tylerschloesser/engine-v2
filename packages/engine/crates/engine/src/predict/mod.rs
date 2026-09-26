//! Client-side prediction (docs/decisions/0012-prediction-and-reconciliation.md;
//! docs/plan/25-prediction-core.md): the reset-and-replay overlay, the client's own `Predicting`
//! `WorldRead`/`WorldWrite` implementor, and the pending queue. `client::core::ClientCore` is the
//! one production caller (`on_action`/`on_frame`); `.claude/rules/prediction.md` has the
//! validate-first/`?`-on-every-read/never-encode-a-provisional-id rules this module exists to keep.
//!
//! Deliberately outside the client/host directories the crate's module-layering test excludes
//! from its scan; this module itself never names either side directly (see `predicting.rs`'s own
//! module doc comment) -- every type here is usable, and tested, without either.

mod overlay;
mod pending;
mod predicting;

pub use overlay::Overlay;
pub(crate) use overlay::covers;
pub use pending::{Pending, PendingQueue, Prediction};
pub use predicting::Predicting;
pub(crate) use predicting::predict;
