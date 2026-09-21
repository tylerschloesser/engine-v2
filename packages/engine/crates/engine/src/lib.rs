//! The engine crate: everything a game links against to become one WASM module.
//!
//! The JS↔WASM boundary lives in [`abi`]; `abi/registry.rs` is its single owner
//! (docs/decisions/0014). A game writes one line of it: `engine::export_game!(MyGame);`.

pub mod abi;
pub mod bytes;
pub mod client;
pub mod codec;
pub mod delta;
pub mod game;
pub mod gen_queue;
pub mod hash;
pub mod noise;
pub mod store;
#[cfg(feature = "testing")]
pub mod testing;
pub mod time;
pub mod view;
pub mod world;
pub mod worldgen;

pub use abi::panic::log;
