//! `Host<G>` (docs/plan/13-sim-host-tick-loop.md Scope): the sim-role `Instance` -- a `Sim<G>`
//! driver plus the between-tick warmer ([`warm`]). M15 adds connections, at which point
//! `sim_admit`/`sim_build_frame` become real; this milestone's own instance leaves them at
//! `Instance`'s defaults (`Status::Unsupported`), since no connection exists yet (Non-scope).
//!
//! Genesis is a separate export from `init` (`sim_genesis`, not built eagerly): M22b's load path
//! needs to choose between "fresh world" and "world restored from storage" after `engine_init`
//! has already reserved the arena and parsed config, so `Host::init` only parses and holds the
//! parameters; `sim_genesis` is what actually builds the `Sim<G>`.

pub mod warm;

use crate::abi::config::HexU64;
use crate::abi::{Instance, RegionLayout, Role, Status};
use crate::game::Game;
use crate::sim::{Outcome, Sim, WorldParams};
use crate::worldgen::Worldgen;
use warm::Warm;

fn default_max_entities() -> u32 {
    262_144
}
fn default_max_modified_tiles() -> u32 {
    1_048_576
}
fn default_max_action_growth() -> u32 {
    4_096
}
/// 0007 §8's host cache budget default (1,024 chunks = 4 MiB at the default 32x32 chunk size);
/// mirrors `Sim::genesis`'s own private `DEFAULT_CACHE_CHUNKS` (`crate::sim`), which is what
/// actually governs `TerrainStore` capacity today -- see the module doc comment on `cache_chunks`
/// below.
fn default_cache_chunks() -> u32 {
    1024
}

/// The `game` value of `InstanceConfig` (0009 `WorldConfig.params` plus the host-only
/// `cacheChunks` knob), read once by `Host::init` and held until `sim_genesis` consumes the
/// world-params half of it. `seed`/`params` are 0008's (shared with the `gen`/`client` roles of
/// `GameInstance<G>`); `maxEntities`/`maxModifiedTiles`/`maxActionGrowth` and `cacheChunks` are
/// 0009's `WorldConfig.params`/host fields (docs/plan/13-sim-host-tick-loop.md Scope "Sim-role
/// config"). `view` (0009's untrusted-view clamp) is not parsed here: Non-scope (Connections,
/// subscriptions: M15) means nothing reads it yet.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimConfig<P> {
    seed: HexU64,
    params: P,
    #[serde(default = "default_max_entities")]
    max_entities: u32,
    #[serde(default = "default_max_modified_tiles")]
    max_modified_tiles: u32,
    #[serde(default = "default_max_action_growth")]
    max_action_growth: u32,
    /// Parsed and held on [`Host`] for M15's connection/warmer wiring, but **not yet wired to
    /// `TerrainStore` capacity**: `Sim::genesis`'s own signature is fixed by M12b's Provides and
    /// takes no cache-size parameter, so this field is inert today (docs/plan/
    /// 13-sim-host-tick-loop.md Deviations records this as a known gap, not a silent drop).
    #[serde(default = "default_cache_chunks")]
    cache_chunks: u32,
}

/// The sim-role `Instance` (Scope: "`Host<G>` (here: `Sim<G>` + warm list; M15 adds
/// connections)"). Built by `GameInstance::<G>::init` for `Role::Sim`; also usable standalone
/// (this crate's own tests, and any future low-level caller that wants a bare sim-role instance
/// without the `Gen`/`Client` arms of `GameInstance`).
pub struct Host<G: Game> {
    /// Held until [`Host::sim_genesis`] consumes it (or, in a future milestone, a load path
    /// consumes it instead). `None` once genesis has run.
    pending: Option<WorldParams<G>>,
    /// The host-only knobs `WorldParams<G>` has no room for (see [`SimConfig::cache_chunks`]'s own
    /// doc comment on why it stays unused today).
    cache_chunks: u32,
    sim: Option<Sim<G>>,
    /// Reused across every `sim_tick` call (`Sim::step` itself clears it first): avoids a fresh
    /// allocation on the hot tick path.
    outcomes: Vec<Outcome<G>>,
    warm: Warm,
}

impl<G: Game> Host<G> {
    /// The live `Sim<G>`, once `sim_genesis` has run. `None` beforehand.
    pub fn sim(&self) -> Option<&Sim<G>> {
        self.sim.as_ref()
    }

    /// The `cacheChunks` config value, read but not yet wired anywhere (see
    /// [`SimConfig::cache_chunks`]'s own doc comment): exposed so a future milestone that does
    /// wire it does not also have to re-plumb it through `Host::init`.
    pub fn cache_chunks(&self) -> u32 {
        self.cache_chunks
    }
}

impl<G: Game> Instance for Host<G>
where
    G::Global: Default,
{
    fn init(role: Role, game_cfg_json: &str, _layout: &mut RegionLayout) -> Result<Self, Status> {
        if role != Role::Sim {
            return Err(Status::BadConfig);
        }
        let cfg: SimConfig<<G::Worldgen as Worldgen>::Params> =
            serde_json::from_str(game_cfg_json).map_err(|_| Status::BadConfig)?;
        Ok(Host {
            pending: Some(WorldParams {
                seed: cfg.seed.0,
                worldgen: cfg.params,
                max_entities: cfg.max_entities,
                max_modified_tiles: cfg.max_modified_tiles,
                max_action_growth: cfg.max_action_growth,
            }),
            cache_chunks: cfg.cache_chunks,
            sim: None,
            outcomes: Vec::new(),
            warm: Warm::new(),
        })
    }

    fn sim_genesis(&mut self) -> Status {
        if self.sim.is_some() {
            return Status::AlreadyInitialised;
        }
        let Some(params) = self.pending.take() else {
            return Status::AlreadyInitialised;
        };
        self.sim = Some(Sim::genesis(params));
        Status::Ok
    }

    fn sim_tick(&mut self) -> Status {
        let Some(sim) = self.sim.as_mut() else {
            return Status::NotInitialised;
        };
        // No records this milestone (Non-scope: Actions are M16, connections are M15): every tick
        // still runs `Game::tick` and advances the clock (`Sim::step`'s own contract).
        sim.step(&[], &mut self.outcomes);
        Status::Ok
    }

    fn sim_hash(&mut self) -> u64 {
        self.sim.as_ref().map_or(0, Sim::state_hash)
    }

    fn sim_seal_frame(&mut self, _persist: &mut [u8]) -> Result<u32, Status> {
        if self.sim.is_none() {
            return Err(Status::NotInitialised);
        }
        // Non-scope (Storage, snapshots, real log bytes: M22): always 0 until then.
        Ok(0)
    }

    fn sim_warm_one(&mut self) -> u32 {
        let Some(sim) = self.sim.as_ref() else {
            return 0;
        };
        let terrain = sim.authority().store().terrain();
        u32::from(self.warm.warm_one(terrain).is_some())
    }

    /// "20 Hz is hardcoded" gap (docs/plan/13-sim-host-tick-loop.md): `G`'s own real rate, not
    /// the trait default.
    fn tick_hz(&mut self) -> u32 {
        G::TICK_RATE.hz_value()
    }
}
