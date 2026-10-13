//! Shared native test support (M20 Provides: "native test helper
//! `sim/tests/common/mod.rs::RefScenario`"). `#![allow(dead_code)]`: each `tests/*.rs` file is its
//! own binary that includes this module whole, so a helper only some of them call (e.g. `landmarks_
//! fixture.rs` uses neither `RefScenario` nor most of its methods) would otherwise warn -- and
//! `pnpm lint`'s `-D warnings` would fail the build over an unused method in a *different* test
//! binary's copy of this shared file.
#![allow(dead_code)]

use engine::game::{PlayerEvent, PlayerId, WorldRead, WorldWrite};
use engine::sim::{Record, Rejected, Sim, WorldParams};
use engine::world::{Tile, TilePos, TileRect};
use reference_sim::{RefAction, RefGame, RefParams, RefPlayer, RefReject, TileXY};

/// The one seed every native test in this crate shares (Provides: "the `TEST_SEED` value") --
/// `reference_sim::content::SEED` (M20b step 5 Deviations) is now the single source of that literal;
/// this alias keeps every existing test's own `TEST_SEED` reference unchanged.
pub const TEST_SEED: u64 = reference_sim::content::SEED;

/// A fresh `Sim<RefGame>` plus a per-player `seq` counter, so a test can `join`/`dispatch`/
/// `step_ticks` without repeating `Sim::genesis`/`Sim::step` plumbing (Provides: "new world, join a
/// player, dispatch, step ticks, read player and tile, state hash").
pub struct RefScenario {
    sim: Sim<RefGame>,
    out: Vec<engine::sim::Outcome<RefGame>>,
    seqs: std::collections::BTreeMap<PlayerId, u32>,
}

impl RefScenario {
    /// A fresh world at [`TEST_SEED`] with default `RefParams` -- the same seed and params
    /// `src/main.ts` uses, so a native test's landmark tiles are what a player actually sees.
    pub fn new() -> Self {
        Self::with_caps(
            engine::transport::DEFAULT_MAX_LINES,
            engine::transport::DEFAULT_MAX_ITEMS,
        )
    }

    /// [`Self::new`] with other transport caps (M52: `0, 0` is a world that declares none, like the
    /// large-save bench's).
    pub fn with_caps(max_lines: u32, max_items: u32) -> Self {
        RefScenario {
            sim: Sim::genesis(WorldParams {
                seed: TEST_SEED,
                worldgen: RefParams::default(),
                // Was `0`: an inert placeholder while the state-budget check was Non-scope
                // (M12b/M15). M21 makes it real, so this native test harness needs a genuine
                // headroom figure -- 0007 §8's own default -- instead of a value that would now
                // reject every entity-creating action as `StateBudgetFull`.
                max_entities: 262_144,
                max_modified_tiles: 1_048_576,
                max_action_growth: 4_096,
                max_lines,
                max_items,
            }),
            out: Vec::new(),
            seqs: std::collections::BTreeMap::new(),
        }
    }

    pub fn join(&mut self, who: PlayerId) {
        self.sim.step(
            &[Record::Player {
                who,
                ev: PlayerEvent::Joined,
            }],
            &mut self.out,
        );
    }

    /// Dispatches `action` for `who` (auto-incrementing `who`'s own `seq`) and steps one tick,
    /// returning the sim's own verdict.
    pub fn dispatch(&mut self, who: PlayerId, action: RefAction) -> Result<(), RefReject> {
        let seq = {
            let s = self.seqs.entry(who).or_insert(0);
            *s += 1;
            *s
        };
        self.sim
            .step(&[Record::Action { who, seq, action }], &mut self.out);
        match &self.out[0].result {
            Ok(_) => Ok(()),
            Err(Rejected::Game(r)) => Err(*r),
            Err(Rejected::Engine(e)) => panic!("unexpected engine reject: {e:?}"),
        }
    }

    /// Logs a `Disconnected` event for `who` (0004: connection events are logged records, so a
    /// replay cancels the same collect at the same tick).
    pub fn disconnect(&mut self, who: PlayerId) {
        self.sim.step(
            &[Record::Player {
                who,
                ev: PlayerEvent::Disconnected,
            }],
            &mut self.out,
        );
    }

    /// Logs a `Connected` event for `who`.
    pub fn connect(&mut self, who: PlayerId) {
        self.sim.step(
            &[Record::Player {
                who,
                ev: PlayerEvent::Connected,
            }],
            &mut self.out,
        );
    }

    /// Grants `n` of `item` with a direct player put (native-test-only, like [`Self::set_tile`]:
    /// not an action, not in the `.wasm`), so a test need not replay hundreds of collect ticks.
    pub fn give(&mut self, who: PlayerId, item: reference_sim::content::ItemId, n: u32) {
        let mut p = self.player(who);
        p.inventory.add(item, n);
        self.sim.authority_mut().put_player(who, p);
    }

    /// `PlaceFurnace { origin }` for `who` (Provides: `RefScenario::place(player, origin)`).
    pub fn place(&mut self, who: PlayerId, origin: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::PlaceFurnace {
                origin: TileXY::from_tile(origin),
            },
        )
    }

    /// `FurnaceDeposit { at, item, count }` for `who` (Provides: `RefScenario::deposit`).
    pub fn deposit(
        &mut self,
        who: PlayerId,
        at: TilePos,
        item: reference_sim::content::ItemId,
        count: u32,
    ) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::FurnaceDeposit {
                at: TileXY::from_tile(at),
                item: item as u8,
                count,
            },
        )
    }

    /// `FurnaceTake { at }` for `who` (Provides: `RefScenario::take`).
    pub fn take(&mut self, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::FurnaceTake {
                at: TileXY::from_tile(at),
            },
        )
    }

    /// `FurnacePickUp { at }` for `who` (Provides: `RefScenario::pick_up`).
    pub fn pick_up(&mut self, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::FurnacePickUp {
                at: TileXY::from_tile(at),
            },
        )
    }

    /// The furnace whose footprint covers `at` on the host, by value (Provides:
    /// `RefScenario::furnace_at`); `None` when the tile is empty or holds a belt.
    pub fn furnace_at(&self, at: TilePos) -> Option<reference_sim::Furnace> {
        self.entity_value_at(at)?.as_furnace().copied()
    }

    /// The belt on `at` on the host, by value (M51); `None` when the tile is empty or a furnace's.
    pub fn belt_at(&self, at: TilePos) -> Option<reference_sim::Belt> {
        self.entity_value_at(at)?.as_belt().copied()
    }

    /// The entity whose footprint covers `at` on the host, by value.
    pub fn entity_value_at(&self, at: TilePos) -> Option<reference_sim::RefEntity> {
        let id = self.entity_at(at)?;
        self.sim
            .authority()
            .entity(id)
            .expect("host reads are total")
            .copied()
    }

    /// Replaces the furnace covering `at` with `f` by a direct put (native-test-only, like
    /// [`Self::give`]): reaches states that would take 999 smelts. The put wakes the furnace.
    pub fn put_furnace(&mut self, at: TilePos, f: reference_sim::Furnace) {
        let id = self.entity_at(at).expect("a furnace is there");
        self.sim
            .authority_mut()
            .put_entity(id, reference_sim::RefEntity::Furnace(f));
    }

    /// The host's world as a plain `&dyn WorldRead` (what `can_place` takes).
    pub fn read(&self) -> &dyn WorldRead<RefGame> {
        self.sim.authority()
    }

    /// Writes recorded since genesis (`Authority::changes`; nothing clears them here): two readings
    /// differ exactly when something was put in between.
    pub fn writes_logged(&self) -> usize {
        self.sim.authority().changes().len()
    }

    /// Entity puts (spawns included) recorded since genesis: a furnace placement is exactly one.
    pub fn entity_puts_logged(&self) -> usize {
        self.sim
            .authority()
            .changes()
            .iter()
            .filter(|(_, d)| matches!(d, engine::delta::Delta::EntityPut { .. }))
            .count()
    }

    /// Entities the last tick's rules visited (`next_woken`/`next_due` pops).
    pub fn visited_last_tick(&self) -> u64 {
        self.sim.authority().entities_visited_per_tick()
    }

    /// The occupant of `pos` on the host (real ids only: there is no prediction here).
    pub fn entity_at(&self, pos: TilePos) -> Option<engine::game::EntityId> {
        self.sim
            .authority()
            .entity_at(pos)
            .expect("host reads are total")
    }

    /// How many entities (furnaces) the host holds whose footprint touches the square of `radius`
    /// tiles around the origin (every test here places near it).
    pub fn furnace_count(&self) -> usize {
        let r = 200;
        let mut n = 0;
        self.sim
            .authority()
            .entities_in(
                TileRect::new(TilePos::new(-r, -r), TilePos::new(r, r)),
                &mut |_, _| n += 1,
            )
            .expect("host reads are total");
        n
    }

    /// Every entity the host holds near the origin (`furnace_count`'s square), ascending id.
    pub fn entities(&self) -> Vec<(engine::game::EntityId, reference_sim::RefEntity)> {
        let r = 200;
        let mut all = Vec::new();
        self.sim
            .authority()
            .entities_in(
                TileRect::new(TilePos::new(-r, -r), TilePos::new(r, r)),
                &mut |id, e| all.push((id, *e)),
            )
            .expect("host reads are total");
        all.sort_by_key(|(id, _)| id.0);
        all.dedup_by_key(|(id, _)| id.0);
        all
    }

    /// `PlaceBelt { at, dir, kind }` for `who` (M51).
    pub fn place_belt(
        &mut self,
        who: PlayerId,
        at: TilePos,
        dir: reference_sim::Dir,
        kind: reference_sim::BeltKind,
    ) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::PlaceBelt {
                at: TileXY::from_tile(at),
                dir,
                kind,
            },
        )
    }

    /// `RotateBelt { at }` for `who` (M51).
    pub fn rotate_belt(&mut self, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::RotateBelt {
                at: TileXY::from_tile(at),
            },
        )
    }

    /// `PickUpBelt { at }` for `who` (M51).
    pub fn pick_up_belt(&mut self, who: PlayerId, at: TilePos) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::PickUpBelt {
                at: TileXY::from_tile(at),
            },
        )
    }

    /// Applies `actions` for `who` in one tick (several edits served by the same tick rule), each
    /// with its own verdict.
    pub fn dispatch_batch(
        &mut self,
        who: PlayerId,
        actions: &[RefAction],
    ) -> Vec<Result<(), RefReject>> {
        let mut batch = Vec::new();
        for &action in actions {
            let s = self.seqs.entry(who).or_insert(0);
            *s += 1;
            batch.push(Record::Action {
                who,
                seq: *s,
                action,
            });
        }
        self.sim.step(&batch, &mut self.out);
        self.out
            .iter()
            .map(|o| match &o.result {
                Ok(_) => Ok(()),
                Err(Rejected::Game(r)) => Err(*r),
                Err(Rejected::Engine(e)) => panic!("unexpected engine reject: {e:?}"),
            })
            .collect()
    }

    /// M52: the host's lines are what the belts in `entities()`'s square say, recomputed from scratch
    /// (`rules::belts::topology`'s rules, not its incremental code): every live belt stores the shape
    /// its neighbours give and is mapped; a straight belt shares its lines with the belt in front iff
    /// that one faces the same way (one position block of 256 further from the front) and with the
    /// belt behind iff that one is a straight belt facing the same way; a curve is a line pair of its
    /// own (106 on the turn side, 295); the belt fronting a pair sets its output from its front tile
    /// (`output_of`: `Next` lane for lane, `Merge` onto the near lane at +64 / +192, `Sink` from a
    /// despawner, else `DeadEnd`); every line has one segment, and the store holds exactly two lines
    /// per fronting belt. M53b: a spawner joins nothing and nothing joins it in front; a despawner
    /// joins nothing in front and no belt in front of it joins it; a spawner's lanes carry the
    /// schedule its configuration asks (`topology::schedule_for`), and no other line has one. M54: a
    /// splitter's halves each hold four straight 128-position lines running its way (`splitter_lanes`),
    /// each input lane forks onto the left and right halves' output lanes (`a` the left), each half's
    /// output lines follow `output_of` like a fronting belt's, a belt behind a half feeds its input
    /// lanes, and the store holds eight lines per splitter.
    pub fn assert_topology(&self) {
        self.assert_topology_in(TileRect::new(
            TilePos::new(-200, -200),
            TilePos::new(200, 200),
        ));
    }

    /// [`Self::assert_topology`] over the belts in `rect` (its line count check then counts only
    /// those: every line must belong to a belt in `rect`). Also: no full cap dropped a belt's lines
    /// (`topology::belts_unmapped`).
    pub fn assert_topology_in(&self, rect: TileRect) {
        assert_eq!(
            reference_sim::rules::belts::topology::belts_unmapped(),
            0,
            "belts left unmapped by a full cap"
        );
        assert_eq!(
            reference_sim::rules::belts::topology::spawners_unscheduled(),
            0,
            "spawner lanes left unscheduled by a refused set_spawner"
        );
        self.assert_lines_in(rect);
    }

    /// [`Self::assert_topology`]'s structure check alone, without the cap counters (M54 fix round 1:
    /// a cap test that dropped lines on purpose, then re-mapped them).
    pub fn assert_lines(&self) {
        self.assert_lines_in(TileRect::new(
            TilePos::new(-200, -200),
            TilePos::new(200, 200),
        ));
    }

    fn assert_lines_in(&self, rect: TileRect) {
        use engine::transport::Output;
        use reference_sim::rules::belts::topology::{
            Link, lanes_at, output_of, shape_of, splitter_halves, splitter_lanes,
        };
        use reference_sim::{BeltKind, BeltShape};
        let w = self.read();
        let tr = w.transport();
        let store = self.transport_store();
        let ahead = |t: TilePos, d: reference_sim::Dir, n: i32| {
            let (dx, dy) = match d {
                reference_sim::Dir::East => (1, 0),
                reference_sim::Dir::South => (0, 1),
                reference_sim::Dir::West => (-1, 0),
                reference_sim::Dir::North => (0, -1),
            };
            TilePos::new(t.x + dx * n, t.y + dy * n)
        };
        let live = |t: TilePos| {
            w.entity_at(t).expect("host").and_then(|id| {
                w.entity(id)
                    .expect("host")
                    .and_then(|e| e.as_live_belt().copied())
            })
        };
        let mut fronts = 0u32;
        let mut all = Vec::new();
        w.entities_in(rect, &mut |id, e| all.push((id, *e)))
            .expect("host reads are total");
        all.sort_by_key(|(id, _)| id.0);
        all.dedup_by_key(|(id, _)| id.0);
        for (_, e) in all {
            let Some(b) = e.as_belt().copied() else {
                continue;
            };
            assert!(!b.removing, "a removing belt outlived its tick: {b:?}");
            let t = b.origin.tile();
            let shape = shape_of(w, t, b.dir).expect("host");
            assert_eq!(b.shape, shape, "{t:?}: stored shape");
            // The outputs a line pair fronting on `t` (facing `dir`) must have for `link`.
            let want_outs = |t: TilePos, link: Link| -> [Output; 2] {
                let f = ahead(t, b.dir, 1);
                match link {
                    Link::DeadEnd => [Output::DeadEnd; 2],
                    Link::Sink => [Output::Sink; 2],
                    Link::Next => match splitter_lanes(tr, f) {
                        Some(s) => [Output::Next(s.input[0]), Output::Next(s.input[1])],
                        None => {
                            let mf = lanes_at(tr, f).expect("front mapped");
                            [Output::Next(mf.lane[0]), Output::Next(mf.lane[1])]
                        }
                    },
                    Link::SideLoad { near } => {
                        let mf = lanes_at(tr, f).expect("front mapped");
                        let line = mf.lane[usize::from(near)];
                        let at = |lane: u8| mf.off + if lane == near { 64 } else { 192 };
                        [
                            Output::Merge { line, at: at(0) },
                            Output::Merge { line, at: at(1) },
                        ]
                    }
                }
            };
            if b.kind == BeltKind::Splitter {
                assert_eq!(
                    b.shape,
                    BeltShape::Straight,
                    "{t:?}: a splitter is straight"
                );
                let halves = splitter_halves(&b);
                let lanes = halves.map(|h| {
                    let s =
                        splitter_lanes(tr, h).unwrap_or_else(|| panic!("{h:?}: splitter lines"));
                    assert_eq!(s.dir, b.dir, "{h:?}: splitter lines run its way");
                    s
                });
                for (h, s) in halves.into_iter().zip(lanes) {
                    for l in s.input.into_iter().chain(s.output) {
                        assert_eq!(tr.len(l), Ok(128), "{h:?}: splitter line {l:?} len");
                        let mut n = 0;
                        tr.segments(l, &mut |_| n += 1).expect("line");
                        assert_eq!(n, 1, "{h:?}: line {l:?} segments");
                        assert_eq!(store.schedule(l).expect("line"), None, "{h:?}: no schedule");
                    }
                    for k in 0..2 {
                        assert_eq!(
                            tr.out(s.input[k]),
                            Ok(Output::Fork {
                                a: lanes[0].output[k],
                                b: lanes[1].output[k],
                            }),
                            "{h:?} lane {k}: the input fork"
                        );
                    }
                    let want = want_outs(h, output_of(w, h, b).expect("host"));
                    assert_eq!(
                        [tr.out(s.output[0]), tr.out(s.output[1])],
                        [Ok(want[0]), Ok(want[1])],
                        "{h:?} {b:?}: splitter output"
                    );
                }
                fronts += 4;
                continue;
            }
            let m = lanes_at(tr, t).unwrap_or_else(|| panic!("{t:?} is not mapped"));
            for lane in 0..2 {
                let want = if b.kind == BeltKind::Spawner && m.off + 256 == m.len {
                    reference_sim::rules::belts::topology::schedule_for(b.spawn[lane])
                        .map(|s| (s.period, s.kinds, s.next))
                } else {
                    None
                };
                let got = store
                    .schedule(m.lane[lane])
                    .expect("line")
                    .map(|(s, _)| (s.period, s.kinds, s.next));
                if m.off + 256 == m.len {
                    assert_eq!(got, want, "{t:?} lane {lane}: schedule");
                }
            }
            for l in m.lane {
                let mut n = 0;
                tr.segments(l, &mut |_| n += 1).expect("line");
                assert_eq!(n, 1, "{t:?}: line {l:?} segments");
                if shape == BeltShape::Straight {
                    assert_eq!(tr.len(l), Ok(m.len), "{t:?}: lanes of one length");
                }
            }
            if shape != BeltShape::Straight {
                let left = shape == BeltShape::CurveLeft;
                let lens = if left { [106, 295] } else { [295, 106] };
                assert_eq!(
                    (tr.len(m.lane[0]), tr.len(m.lane[1]), m.off),
                    (Ok(lens[0]), Ok(lens[1]), 0),
                    "{t:?}: curve"
                );
            } else {
                let front = live(ahead(t, b.dir, 1)).filter(|f| {
                    f.dir == b.dir
                        && b.kind == BeltKind::Belt
                        && !matches!(f.kind, BeltKind::Spawner | BeltKind::Splitter)
                });
                let back = live(ahead(t, b.dir, -1)).filter(|k| {
                    k.dir == b.dir
                        && b.kind != BeltKind::Spawner
                        && k.kind == BeltKind::Belt
                        && shape_of(w, ahead(t, b.dir, -1), k.dir) == Ok(BeltShape::Straight)
                });
                // Joined to a same-way neighbour, unless the joined run would pass
                // `MAX_LINE_TILES`: then a run boundary (the output check below sees the `Next`).
                let max = engine::transport::MAX_LINE_TILES;
                let tiles = |l: &reference_sim::rules::belts::topology::TileLanes| l.len / 256;
                if front.is_some() {
                    let mf = lanes_at(tr, ahead(t, b.dir, 1)).expect("front mapped");
                    if m.off > 0 {
                        assert_eq!((mf.lane, mf.off + 256), (m.lane, m.off), "{t:?}: one run");
                    } else {
                        assert!(
                            tiles(&m) + tiles(&mf) > max,
                            "{t:?}: not joined to the front"
                        );
                    }
                } else {
                    assert_eq!(m.off, 0, "{t:?}: joined to nothing in front");
                }
                if back.is_some() {
                    if m.off + 256 == m.len {
                        let mb = lanes_at(tr, ahead(t, b.dir, -1)).expect("back mapped");
                        assert!(
                            tiles(&m) + tiles(&mb) > max,
                            "{t:?}: not joined to the back"
                        );
                    }
                } else {
                    assert_eq!(m.off + 256, m.len, "{t:?}: joined to nothing behind");
                }
                assert!(tiles(&m) <= max, "{t:?}: a run past MAX_LINE_TILES");
            }
            if m.off != 0 {
                continue;
            }
            fronts += 1;
            let want = want_outs(t, output_of(w, t, b).expect("host"));
            assert_eq!(
                [tr.out(m.lane[0]), tr.out(m.lane[1])],
                [Ok(want[0]), Ok(want[1])],
                "{t:?} {b:?}: output"
            );
        }
        assert_eq!(
            tr.lines_len(),
            2 * fronts,
            "two lines per fronting belt and eight per splitter, no leak"
        );
    }

    /// The host's transport store itself (M53b: `Transport::schedule`, `scheduled_inserts_total`,
    /// which the `TransportRead` a rule sees does not answer).
    pub fn transport_store(&self) -> &engine::transport::Transport {
        self.sim.authority().store().transport()
    }

    /// `SetSpawner { at, lane, item, rate }` for `who` (M53b).
    pub fn set_spawner(
        &mut self,
        who: PlayerId,
        at: TilePos,
        lane: u8,
        item: u8,
        rate: u8,
    ) -> Result<(), RefReject> {
        self.dispatch(
            who,
            RefAction::SetSpawner {
                at: TileXY::from_tile(at),
                lane,
                item,
                rate,
            },
        )
    }

    /// Makes `w` x `h` tiles from `min` plain grass with no resource (native-test-only, like
    /// [`Self::set_tile`]): placement tests must not depend on what worldgen put there.
    pub fn clear_area(&mut self, min: TilePos, w: i32, h: i32) {
        for dy in 0..h {
            for dx in 0..w {
                self.set_tile(
                    TilePos::new(min.x + dx, min.y + dy),
                    Tile::new(reference_sim::content::GRASS, 0, 0),
                );
            }
        }
    }

    pub fn step_ticks(&mut self, n: u32) {
        for _ in 0..n {
            self.sim.step(&[], &mut self.out);
        }
    }

    pub fn tick(&self) -> engine::time::Tick {
        self.sim.authority().tick()
    }

    pub fn player(&self, who: PlayerId) -> RefPlayer {
        *self.sim.authority().player(who).expect("player exists")
    }

    pub fn tile(&self, pos: TilePos) -> Tile {
        self.sim.authority().tile(pos).expect("tile readable")
    }

    /// Direct world write, bypassing `apply` (native-test-only convenience: constructing a
    /// near-depleted tile without actually running nine real collects first).
    pub fn set_tile(&mut self, pos: TilePos, t: Tile) {
        self.sim.authority_mut().set_tile(pos, t);
    }

    /// The game's `Global` (per-player palette indices), by value.
    pub fn global(&self) -> reference_sim::RefGlobal {
        *self.sim.authority().global()
    }

    /// `Delta::Global` writes recorded since genesis (`writes_logged`'s sibling).
    pub fn global_puts_logged(&self) -> usize {
        self.sim
            .authority()
            .changes()
            .iter()
            .filter(|(_, d)| matches!(d, engine::delta::Delta::Global { .. }))
            .count()
    }

    /// The host's `SimRng` state (it is in the snapshot; `state_hash` does not cover it).
    pub fn rng(&self) -> engine::rng::SimRng {
        self.sim.authority().rng()
    }

    pub fn hash(&self) -> u64 {
        self.sim.state_hash()
    }

    /// Writes a snapshot of the host and restores it into a fresh `Sim` (what a saved world does on
    /// load: the same path `engine::testing::replay::heavy` uses), replacing `self.sim`.
    pub fn save_and_load(&mut self) {
        use engine::authority::Authority;
        use engine::game::Game as _;
        use engine::persist::{Identity, SnapshotProgress, SnapshotReader, SnapshotWriter};
        use engine::store::Store;
        use engine::world::{CacheCapacity, ChunkDims, PristineSource, TerrainStore};
        use engine::worldgen::{Pristine, WorldgenStamp};
        let identity = Identity {
            build_hash: [0; 16],
            engine_version: "0.0.0".to_string(),
            game_version: "0.0.0".to_string(),
            schema_version: RefGame::SCHEMA_VERSION,
            tick_rate_hz: RefGame::TICK_RATE.hz_value(),
            worldgen: WorldgenStamp {
                version:
                    <reference_sim::RefWorldgen as engine::worldgen::Worldgen>::WORLDGEN_VERSION,
                fingerprint: 0,
            },
        };
        let rng = self.sim.authority().rng();
        let mut w = SnapshotWriter::begin(
            self.sim.authority().store(),
            self.sim.tick(),
            &rng,
            0,
            0,
            0,
            &identity,
        );
        let mut bytes = vec![0u8; w.total_len()];
        let n = w.next(&mut bytes);
        assert_eq!(n, bytes.len());
        let source: Box<dyn PristineSource> = Box::new(
            Pristine::<reference_sim::RefWorldgen>::new(TEST_SEED, RefParams::default()),
        );
        let terrain = TerrainStore::new(
            ChunkDims::new(RefGame::CHUNK_BITS),
            source,
            CacheCapacity::Chunks(1024),
        );
        let shell = Store::new(terrain, Default::default());
        let mut reader: SnapshotReader<RefGame> = SnapshotReader::new(shell);
        let info = match reader.push(&bytes) {
            Ok(SnapshotProgress::Done(info)) => info,
            _ => panic!("a snapshot this process just wrote must decode"),
        };
        let authority = Authority::from_snapshot(reader.into_store(), info.rng, info.tick);
        self.sim = Sim::from_parts(authority);
    }
}

impl Default for RefScenario {
    fn default() -> Self {
        Self::new()
    }
}

pub mod bench_host;
pub mod bench_run;
