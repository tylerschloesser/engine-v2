//! Fixture game `fx-migrate-v2-hz30` (docs/plan/24b-upgrade-and-migration.md Scope): the same
//! `SCHEMA_VERSION = 2` schema as `fx-migrate-v2`, at `TICK_RATE` 30Hz instead of 20 -- "three tiny
//! crates sharing source by `#[path]`": this crate `#[path]`-includes `fx-migrate-v2`'s own
//! `game.rs` verbatim and instantiates its const-generic `V2<HZ>` at `30` instead of `20`, so a
//! migration into this build exercises both a schema bump *and* a tick-rate change at once
//! (`migrate_hz_change_rescales_engine_timers`).

#[path = "../../migrate-v2/src/game.rs"]
mod game;
pub use game::*;

pub type V2Game = game::V2<30>;

engine::export_game!(V2Game);

#[cfg(test)]
mod tests {
    #[test]
    fn export_bindings_enginereject() {
        let cfg = ts_rs::Config::from_env();
        <engine::sim::EngineReject as ts_rs::TS>::export_all(&cfg).expect("could not export type");
    }
}
