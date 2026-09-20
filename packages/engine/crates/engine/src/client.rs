//! What the client-role WASM instance exposes back into the engine's generic dispatch (0014 §4's
//! client hot exports; the client *shell* is TypeScript, docs/decisions/0015 §1). The camera block
//! (0019 §1; docs/plan/06b-workers-and-spawn.md, Scope) and `TerrainFeed` (docs/plan/
//! 08b-gen-workers-and-queue.md, Scope): the ABI-facing wrapper around `GenQueue` a client instance
//! embeds beside its own `TerrainStore`.

pub mod camera;
pub mod terrain_feed;

pub use camera::CameraBlock;
pub use terrain_feed::TerrainFeed;
