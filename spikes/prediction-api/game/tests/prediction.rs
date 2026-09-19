use spike_engine::harness::Sim;
use spike_engine::*;
use spike_game::*;

const P1: PlayerId = PlayerId(1);
const P2: PlayerId = PlayerId(2);
const C00: ChunkCoord = ChunkCoord { x: 0, y: 0 };
const C10: ChunkCoord = ChunkCoord { x: 1, y: 0 };
const CW0: ChunkCoord = ChunkCoord { x: -1, y: 0 };

fn cfg() -> Config {
    Config { seed: 7 }
}

/// Everything a renderer could show for a region: tiles, occupants BY VALUE (entity ids are not
/// visible), and own-player state. "No visible change" means this value is equal.
#[derive(PartialEq, Debug, Clone)]
struct Visible {
    cells: Vec<(TilePos, Option<Tile>, Option<Furnace>)>,
    me: Option<Player>,
}

fn visible(w: &dyn WorldRead<RefGame>, who: PlayerId, x: std::ops::Range<i32>, y: std::ops::Range<i32>) -> Visible {
    let mut cells = Vec::new();
    for yy in y {
        for xx in x.clone() {
            let p = TilePos::new(xx, yy);
            let occ = w.entity_at(p).ok().flatten().and_then(|id| w.entity(id).ok().flatten().copied());
            cells.push((p, w.tile(p).ok(), occ));
        }
    }
    Visible { cells, me: w.player(who).ok().copied() }
}

fn sim_one(delay: u32, subs: &[ChunkCoord]) -> Sim<RefGame> {
    let mut s = Sim::new(cfg());
    s.add_client(cfg(), P1, delay, subs);
    s.run(2 * delay + 2); // join + chunk snapshots arrive
    assert!(s.client(0).view().player(P1).is_ok(), "own player state replicated");
    s
}

fn furnace_at(w: &dyn WorldRead<RefGame>, p: TilePos) -> Option<Furnace> {
    w.entity_at(p).unwrap().and_then(|id| w.entity(id).unwrap().copied())
}

#[test]
fn predicted_placement_is_immediate_and_converges_with_no_visible_change() {
    let mut s = sim_one(3, &[C00]);
    let origin = TilePos::new(5, 5);
    let before = visible(&s.client(0).view(), P1, 0..12, 0..12);

    let (seq, st) = s.client(0).submit(Action::PlaceFurnace { origin });
    assert_eq!(st, Prediction::Applied);
    let predicted = visible(&s.client(0).view(), P1, 0..12, 0..12);
    assert_ne!(predicted, before, "shows immediately, before any network traffic");
    assert_eq!(furnace_at(&s.client(0).view(), TilePos::new(6, 6)), Some(Furnace { origin, iron_in: 0, coal: 0 }));
    assert_eq!(predicted.me.unwrap().inv[Item::Furnace as usize], 1);
    assert!(s.client(0).view().entity_at(origin).unwrap().unwrap().is_provisional());
    assert!(s.host.auth.entity_at(origin).unwrap().is_none(), "host has not heard of it yet");

    // Every frame until (and after) the ack: what the player sees never changes.
    let mut confirmed_at = None;
    for step in 0..12 {
        s.step();
        assert_eq!(visible(&s.client(0).view(), P1, 0..12, 0..12), predicted, "visible change at step {step}");
        for e in s.client(0).events.drain(..) {
            if let ClientEvent::Confirmed { seq: q, remap, .. } = e {
                assert_eq!(q, seq);
                assert_eq!(remap.len(), 1, "provisional -> real id mapping derived mechanically");
                assert!(remap[0].0.is_provisional() && !remap[0].1.is_provisional());
                confirmed_at = Some(step);
            }
        }
    }
    assert_eq!(confirmed_at, Some(6), "ack after 2*delay+1 = 7 steps");
    assert_eq!(s.client(0).pending().count(), 0);
    assert_eq!(s.client(0).overlay_len(), 0, "overlay is empty: the view is now purely authoritative");
    assert!(!s.client(0).view().entity_at(origin).unwrap().unwrap().is_provisional());
    assert_eq!(visible(&s.client(0).view(), P1, 0..12, 0..12), visible(&s.host.auth, P1, 0..12, 0..12));
}

#[test]
fn placement_is_trait_driven_water_is_not_buildable() {
    let mut s = sim_one(1, &[C00, CW0]);
    // x = -4 is water; the footprint -4..-2 overlaps it. The rule never names water.
    let (_, st) = s.client(0).submit(Action::PlaceFurnace { origin: TilePos::new(-4, 5) });
    assert_eq!(st, Prediction::Rejected(Reject::NotBuildable));
    // And on top of another furnace: the same query.
    s.client(0).submit(Action::PlaceFurnace { origin: TilePos::new(5, 5) });
    let (_, st) = s.client(0).submit(Action::PlaceFurnace { origin: TilePos::new(6, 6) });
    assert_eq!(st, Prediction::Rejected(Reject::NotBuildable));
}

#[test]
fn rejected_because_another_player_took_the_spot_rolls_back_cleanly() {
    let mut s = Sim::new(cfg());
    let slow = s.add_client(cfg(), P1, 4, &[C00]);
    let fast = s.add_client(cfg(), P2, 1, &[C00]);
    s.run(10);
    let before = visible(&s.client(slow).view(), P1, 0..12, 0..12);

    let (seq, st) = s.client(slow).submit(Action::PlaceFurnace { origin: TilePos::new(5, 5) });
    assert_eq!(st, Prediction::Applied);
    s.client(fast).submit(Action::PlaceFurnace { origin: TilePos::new(6, 6) }); // overlaps, arrives first

    let mut rejected = false;
    let mut saw_early_rollback = false;
    for _ in 0..14 {
        s.step();
        let c = s.client(slow);
        let inv = c.view().player(P1).unwrap().inv[Item::Furnace as usize];
        let mine = furnace_at(&c.view(), TilePos::new(5, 5)).is_some();
        // Never a half state: either my ghost + item spent, or no ghost + item back.
        assert!((mine && inv == 1) || (!mine && inv == 2), "torn rollback: mine={mine} inv={inv}");
        if !mine && c.pending().count() == 1 {
            // The other furnace's delta arrived before my reject ack: re-prediction already fails.
            assert_eq!(c.pending().next().unwrap().status, Prediction::Rejected(Reject::NotBuildable));
            saw_early_rollback = true;
        }
        for e in c.events.drain(..) {
            if let ClientEvent::Rejected { seq: q, reason, .. } = e {
                assert_eq!((q, reason), (seq, Reject::NotBuildable));
                rejected = true;
            }
        }
    }
    assert!(rejected && saw_early_rollback);
    let after = visible(&s.client(slow).view(), P1, 0..12, 0..12);
    assert_eq!(after.me, before.me, "inventory fully restored");
    assert_eq!(furnace_at(&s.client(slow).view(), TilePos::new(6, 6)).unwrap().origin, TilePos::new(6, 6));
    assert_eq!(s.client(slow).overlay_len(), 0);
    assert_eq!(after, visible(&s.host.auth, P1, 0..12, 0..12));
}

#[test]
fn insufficient_inventory_is_rejected_locally_and_by_the_host() {
    let mut s = sim_one(2, &[C00]);
    let c = s.client(0);
    assert_eq!(c.submit(Action::PlaceFurnace { origin: TilePos::new(0, 0) }).1, Prediction::Applied);
    assert_eq!(c.submit(Action::PlaceFurnace { origin: TilePos::new(3, 0) }).1, Prediction::Applied);
    // The third depends on the first two *pending* actions having spent the items.
    let (seq3, st) = c.submit(Action::PlaceFurnace { origin: TilePos::new(6, 0) });
    assert_eq!(st, Prediction::Rejected(Reject::NoItem));
    assert!(furnace_at(&c.view(), TilePos::new(6, 0)).is_none(), "no ghost for a locally rejected action");
    let shown = visible(&c.view(), P1, 0..12, 0..4);

    s.run(8);
    let mut reasons = vec![];
    for e in s.client(0).events.drain(..) {
        if let ClientEvent::Rejected { seq, reason, .. } = e {
            reasons.push((seq, reason));
        }
    }
    assert_eq!(reasons, vec![(seq3, Reject::NoItem)], "host agrees, via the same handler");
    assert_eq!(visible(&s.client(0).view(), P1, 0..12, 0..4), shown);
    assert_eq!(shown, visible(&s.host.auth, P1, 0..12, 0..4));
}

#[test]
fn action_touching_an_unsubscribed_chunk_is_not_predicted_but_still_resolves() {
    // Subscribed to chunk (0,0) only. A 2x2 furnace at x=31 spans into chunk (1,0).
    let mut s = sim_one(2, &[C00]);
    let before = visible(&s.client(0).view(), P1, 28..32, 3..8);

    // Entirely inside the subscription: predicted.
    assert_eq!(s.client(0).submit(Action::PlaceFurnace { origin: TilePos::new(28, 0) }).1, Prediction::Applied);

    // Spanning the edge: the handler's trait query returns Unknown -> prediction declined.
    let (seq, st) = s.client(0).submit(Action::PlaceFurnace { origin: TilePos::new(31, 5) });
    assert_eq!(st, Prediction::NotPredictable);
    assert_eq!(visible(&s.client(0).view(), P1, 28..32, 3..8).cells, before.cells, "no partial ghost");
    assert_eq!(s.client(0).view().player(P1).unwrap().inv[0], 1, "and no partial inventory spend");
    assert_eq!(s.client(0).pending().count(), 2, "still sent, still tracked: UI can show 'pending'");

    s.run(7);
    // The host has the full world, accepts it, and the furnace is delivered because its footprint
    // overlaps a subscribed chunk even though part of it lies outside.
    let confirmed = s.client(0).events.drain(..).any(|e| matches!(e, ClientEvent::Confirmed { seq: q, .. } if q == seq));
    assert!(confirmed);
    assert_eq!(furnace_at(&s.client(0).view(), TilePos::new(31, 6)).unwrap().origin, TilePos::new(31, 5));
    assert_eq!(s.client(0).view().tile(TilePos::new(32, 5)), Err(Unknown), "still unknown over the edge");
    assert_eq!(s.client(0).view().player(P1).unwrap().inv[0], 0);

    // Subscribing later delivers a snapshot made of the same puts; then it IS predictable.
    s.host.subscribe(P1, C10);
    s.run(3);
    assert!(s.client(0).view().tile(TilePos::new(32, 5)).is_ok());
    assert_eq!(s.client(0).submit(Action::Deposit { at: TilePos::new(32, 6), item: Item::Coal, count: 1 }).1, Prediction::Applied);
}

#[test]
fn two_pending_actions_that_depend_on_each_other_replay_correctly() {
    let mut s = sim_one(3, &[C00, C10]);
    let origin = TilePos::new(31, 5); // spans the chunk border, both chunks subscribed
    assert_eq!(s.client(0).submit(Action::PlaceFurnace { origin }).1, Prediction::Applied);
    s.step(); // stagger so the two acks arrive in different frames
    // Deposits into a furnace that exists only as a prediction, addressed by tile.
    let at = TilePos::new(32, 6);
    assert_eq!(s.client(0).submit(Action::Deposit { at, item: Item::Coal, count: 3 }).1, Prediction::Applied);
    let shown = visible(&s.client(0).view(), P1, 30..34, 4..8);
    assert_eq!(furnace_at(&s.client(0).view(), at), Some(Furnace { origin, iron_in: 0, coal: 3 }));
    assert_eq!(shown.me.unwrap().inv, [1, 0, 2]);

    let mut pendings = vec![];
    for step in 0..10 {
        s.step();
        let c = s.client(0);
        pendings.push(c.pending().count());
        // Includes the frame where Place is acked (furnace now authoritative, REAL id) while
        // Deposit is still pending and is re-applied on top of it.
        assert_eq!(visible(&c.view(), P1, 30..34, 4..8), shown, "visible change at step {step}");
        assert!(c.pending().all(|p| p.status == Prediction::Applied));
    }
    assert!(pendings.contains(&1), "there was a frame with only the dependent action pending: {pendings:?}");
    assert_eq!(*pendings.last().unwrap(), 0);
    assert_eq!(shown, visible(&s.host.auth, P1, 30..34, 4..8));
}

#[test]
fn timed_collect_without_client_tick_rules() {
    let delay = 3;
    let mut s = sim_one(delay, &[C00]);
    let tile = TilePos::new(9, 9);
    let units_before = units(s.client(0).view().tile(tile).unwrap());

    // Out of range is rejected deterministically from the claimed position (presence is not sim state).
    let (_, st) = s.client(0).submit(Action::StartCollect { tile, claimed_pos: TilePos::new(20, 20) });
    assert_eq!(st, Prediction::Rejected(Reject::OutOfRange));

    let submit_tick = s.client(0).predicted_tick();
    let (_, st) = s.client(0).submit(Action::StartCollect { tile, claimed_pos: TilePos::new(8, 8) });
    assert_eq!(st, Prediction::Applied);
    let predicted = s.client(0).view().player(P1).unwrap().collecting.unwrap();
    assert_eq!(predicted.started_at, submit_tick);

    // Progress is derived from a clock, never streamed. Own-player timers use the PREDICTED clock.
    let progress = |c: &Client<RefGame>| {
        c.view().player(P1).unwrap().collecting.map(|k| (c.predicted_tick().saturating_sub(k.started_at)).min(COLLECT_TICKS))
    };
    let mut last = 0;
    let mut bar_full_at = None;
    let mut items_at = None;
    for step in 1..=40 {
        s.step();
        let c = s.client(0);
        match progress(c) {
            Some(p) => {
                // Re-prediction every frame must not make the timer drift, and the ack must not make it jump.
                assert!(p == last + 1 || (p == COLLECT_TICKS && last == COLLECT_TICKS), "bar jumped {last} -> {p} at step {step}");
                last = p;
                if p == COLLECT_TICKS && bar_full_at.is_none() {
                    bar_full_at = Some(step);
                }
            }
            None => {
                items_at.get_or_insert(step);
            }
        }
    }
    // The harness knows the exact lead, so prediction == authority here; see the skew test below.
    assert_eq!(s.host.auth.player(P1).unwrap().collecting, None);
    assert_eq!(bar_full_at, Some(COLLECT_TICKS));
    // Open problem made concrete: the bar is full one RTT before the completion delta lands.
    assert_eq!(items_at, Some(COLLECT_TICKS + 2 * delay + 1));
    assert_eq!(s.client(0).view().player(P1).unwrap().inv[Item::IronOre as usize], 1, "arrived as a delta; no client tick rule ran");
    assert_eq!(units(s.client(0).view().tile(tile).unwrap()), units_before - 1);
    assert_eq!(s.client(0).overlay_len(), 0);
}

#[test]
fn timer_prediction_error_is_bounded_by_the_clock_estimate_error() {
    let mut s = sim_one(3, &[C00]);
    s.client(0).lead -= 2; // the client under-estimates the round trip by two ticks
    s.client(0).submit(Action::StartCollect { tile: TilePos::new(9, 9), claimed_pos: TilePos::new(9, 9) });
    let predicted = s.client(0).view().player(P1).unwrap().collecting.unwrap();
    let mut seen = vec![];
    for _ in 0..8 {
        s.step();
        seen.push(s.client(0).view().player(P1).unwrap().collecting.unwrap().done_at);
    }
    let confirmed = s.host.auth.player(P1).unwrap().collecting.unwrap();
    assert_eq!(confirmed.done_at, predicted.done_at + 2);
    // Stable while pending (frozen predicted tick), then exactly one correction of 2 ticks out of
    // 20 when the ack lands: the thing sync.md 3.10 proposes to ease over ~200 ms.
    seen.dedup();
    assert_eq!(seen, vec![predicted.done_at, confirmed.done_at]);
}

#[test]
fn host_replay_from_genesis_reproduces_the_state_hash() {
    let mut s = Sim::new(cfg());
    let a = s.add_client(cfg(), P1, 2, &[C00, C10]);
    let b = s.add_client(cfg(), P2, 0, &[C00]);
    s.run(6);
    let script: Vec<(usize, Action)> = vec![
        (a, Action::PlaceFurnace { origin: TilePos::new(31, 5) }),
        (b, Action::PlaceFurnace { origin: TilePos::new(30, 6) }), // loses the race on some orderings; either way it is logged
        (a, Action::StartCollect { tile: TilePos::new(9, 9), claimed_pos: TilePos::new(9, 10) }),
        (b, Action::StartCollect { tile: TilePos::new(9, 9), claimed_pos: TilePos::new(9, 10) }),
        (a, Action::Deposit { at: TilePos::new(32, 6), item: Item::Coal, count: 2 }),
        (b, Action::PlaceFurnace { origin: TilePos::new(-4, 0) }), // rejected (water): still logged, replay rejects it again
        (b, Action::CancelCollect),
        (a, Action::PlaceFurnace { origin: TilePos::new(0, 0) }),
        (a, Action::PlaceFurnace { origin: TilePos::new(3, 3) }), // no items left
    ];
    for (i, (who, action)) in script.into_iter().enumerate() {
        s.client(who).submit(action);
        s.run(1 + (i as u32 % 3));
    }
    s.run(60);
    // collect more so that the resource layer depletes to pristine-different and then to empty
    for _ in 0..4 {
        s.client(a).submit(Action::StartCollect { tile: TilePos::new(9, 9), claimed_pos: TilePos::new(9, 9) });
        s.run(30);
    }
    s.client(a).submit(Action::Deposit { at: TilePos::new(0, 0), item: Item::IronOre, count: 1 });
    s.run(10);

    let live = s.host.auth.state_hash();
    let until = WorldRead::tick(&s.host.auth);
    let replayed = Host::<RefGame>::replay(cfg(), &s.host.log, until);
    assert_eq!(replayed.state_hash(), live);
    assert!(s.host.log.len() > 10);

    // Different log -> different hash (the hash is not vacuous).
    let truncated = Host::<RefGame>::replay(cfg(), &s.host.log[..s.host.log.len() - 1], until);
    assert_ne!(truncated.state_hash(), live);

    // And both clients converged on the authority for what they can see, with empty overlays.
    for (i, who) in [(a, P1), (b, P2)] {
        assert_eq!(s.client(i).overlay_len(), 0);
        assert_eq!(visible(&s.client(i).view(), who, 0..32, 0..16), visible(&s.host.auth, who, 0..32, 0..16));
    }
    assert_eq!(res(s.host.auth.tile(TilePos::new(9, 9)).unwrap()), RES_NONE, "patch tile mined out");
}
