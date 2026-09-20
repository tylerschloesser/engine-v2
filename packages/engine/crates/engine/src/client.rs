//! What the client-role WASM instance exposes back into the engine's generic dispatch (0014 §4's
//! client hot exports; the client *shell* is TypeScript, docs/decisions/0015 §1). One module for
//! now: the camera block (0019 §1; docs/plan/06b-workers-and-spawn.md, Scope).

pub mod camera;

pub use camera::CameraBlock;
