//! Fixture game `fx-puts` (docs/plan/12-store-and-game-trait.md): the fixture 0003's Consequences
//! names ("the puts cover every replicated scope of 0011": `set_tile`/`spawn`/`put_entity`/
//! `despawn`/`put_player` are chunk- or player-scoped, `put_global` goes to everyone). This
//! milestone declares types only -- `Action`, `Reject`, `Entity`, `Player`, `Global` (`Ui` is
//! `()`, per Scope) -- so `Store<Puts>` and `Delta<Puts>` compile against a real, non-trivial
//! `Game::Entity`/`Player`/`Global`/`Action`/`Reject` set natively and for `wasm32`. `impl Game`
//! (`register`/`prototype`/`anchor`/`genesis`/`on_player`/`apply`/`tick`, the `Sim` role) is
//! M12b's.
//!
//! `Instance` is implemented directly (M02 conventions, like `fx-hash`/`fx-terrain`), not through
//! `Game`/`export_game!`: every role but `init` defaults to `Status::Unsupported`, since this
//! fixture drives no role's export yet. That is enough to build for `wasm32` and be picked up by
//! `tests/wasm/allowlist.test.ts` (`puts_fixture_builds_wasm32`).

use engine::abi::{Instance, RegionLayout, Role, Status};
use engine::game::Unknown;
use ts_rs::TS;

/// A tile position, plain data (`Action` must stay `Codec + TS`; not `engine::world::TilePos`,
/// which does not derive `TS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
}

/// One action per replicated put this fixture exercises (0003 Consequences, 0011 "Scopes"):
/// `SetTile`/`Spawn`/`Despawn` are chunk-scoped (by the entity's `anchor`, 0024 §7), `Deposit`
/// puts an existing entity (`EntityPut` on an id already present -- the no-alloc-on-existing-key
/// path `Store::apply` exercises), `SetGlobal` is the `Global`-scope put. Handlers (M12b) decide
/// exactly how each maps to a `WorldWrite` call; this milestone only fixes the wire shape.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub enum Action {
    SetTile { pos: Pos, base: u8, resource: u8 },
    Spawn { pos: Pos },
    Despawn { id: u32 },
    Deposit { id: u32, amount: u16 },
    SetGlobal { day: u32 },
}

/// `From<Unknown>` (0003: "add a `?` to each read and `impl From<Unknown> for Reject`").
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
pub enum Reject {
    /// A read the handler tried missed (`Unknown`).
    Unknown,
    /// A named id (e.g. `Despawn`/`Deposit`'s target) does not exist.
    NotFound,
}

impl From<Unknown> for Reject {
    fn from(_: Unknown) -> Self {
        Reject::Unknown
    }
}

/// Replicated whole-value entity (0003: "plain data, no `Vec`"): a depot holding an amount, so
/// `Deposit` has something to add to.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Entity {
    pub amount: u16,
}

/// Private per-player state: how many deposits this player has made.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Player {
    pub deposits: u32,
}

/// One value for every client (0011 "Scopes"): a day counter `SetGlobal` puts.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Global {
    pub day: u32,
}

pub struct Puts;

impl Instance for Puts {
    fn init(_role: Role, _game_cfg_json: &str, _layout: &mut RegionLayout) -> Result<Self, Status> {
        Ok(Puts)
    }
}

engine::export_instance!(Puts);
