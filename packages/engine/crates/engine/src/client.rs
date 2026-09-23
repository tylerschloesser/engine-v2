//! What the client-role WASM instance exposes back into the engine's generic dispatch (0014 §4's
//! client hot exports; the client *shell* is TypeScript, docs/decisions/0015 §1). The camera block
//! (0019 §1; docs/plan/06b-workers-and-spawn.md, Scope) and `TerrainFeed` (docs/plan/
//! 08b-gen-workers-and-queue.md, Scope): the ABI-facing wrapper around `GenQueue` a client instance
//! embeds beside its own `TerrainStore`.

pub mod camera;
pub mod core;
pub mod frame_view;
pub mod input;
pub mod replica;
pub mod terrain_feed;
pub mod texel;
pub mod ui;
pub mod upload;

pub use camera::CameraBlock;
pub use core::{ActionError, ClientCore, FrameSummary, OUTBOX_CAPACITY};
pub use frame_view::{Clocks, FrameView};
pub use input::{InputEvent, InputQueue};
pub(crate) use replica::DirtyEvent;
pub use replica::Replica;
pub use terrain_feed::TerrainFeed;
pub use texel::{ClientSide, TileTexel, install_visual_tables};
pub use ui::UiObserver;
pub use upload::Uploader;
