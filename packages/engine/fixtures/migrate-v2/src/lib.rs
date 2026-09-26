//! Fixture game `fx-migrate-v2` (docs/plan/24b-upgrade-and-migration.md Scope): `SCHEMA_VERSION =
//! 2`, `TICK_RATE` the default 20Hz -- same tick rate as `fx-migrate-v1`, so a migration from it
//! is a pure schema-version bump (`fx-migrate-v2-hz30` is the sibling that also changes the tick
//! rate). The whole game is in `game.rs` (shared with `fx-migrate-v2-hz30` by `#[path]`, "three
//! tiny crates sharing source").

#[path = "game.rs"]
mod game;
pub use game::*;

pub type V2Game = game::V2<20>;

engine::export_game!(V2Game);

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings_enginereject() {
        // Same reasoning as every other fixture's own hand-written copy of this test.
        let cfg = ts_rs::Config::from_env();
        <engine::sim::EngineReject as ts_rs::TS>::export_all(&cfg).expect("could not export type");
    }
}
