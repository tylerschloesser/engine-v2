//! The engine crate: everything a game links against to become one WASM module.
//!
//! The JS↔WASM boundary lives in [`abi`]; `abi/registry.rs` is its single owner
//! (docs/decisions/0014). A game writes one line of it: `engine::export_game!(MyGame);`.

pub mod abi;
pub mod authority;
pub mod budget;
pub mod bytes;
pub mod client;
pub mod codec;
pub mod delta;
pub mod game;
pub mod game_instance;
pub mod gen_queue;
pub mod hash;
pub mod host;
pub mod noise;
pub mod persist;
pub mod presence;
pub mod rng;
pub mod sim;
pub mod store;
#[cfg(feature = "testing")]
pub mod testing;
pub mod time;
pub mod view;
pub mod wire;
pub mod world;
pub mod world_access;
pub mod worldgen;

pub use abi::panic::log;

/// This crate's own build version (0005 "Sim identity": `Identity.engine_version`). Read directly
/// off `CARGO_PKG_VERSION` at compile time, since it is defined here rather than through
/// `export_game!`'s macro expansion (unlike [`game::Game::GAME_VERSION`], which must read the
/// *game* crate's own manifest and so can only be captured where a game's own `env!` call would
/// run).
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
