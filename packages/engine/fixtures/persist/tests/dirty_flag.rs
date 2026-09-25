//! docs/plan/22-persistence-log-and-snapshots.md fix round 1, gap 2: Planning decisions 7 ("dirty
//! means a put happened *or a record was logged* since the last snapshot"). A reconnect
//! (`Host::connect` on an already-`ever_joined` slot) pushes only `Record::Player{Connected}` --
//! no `on_player` state write (`fx_persist::Persist::on_player`'s own `Joined`-only arm), and no
//! `Authority::record_ack` call (admitted-action-only) -- so before this fix, `sim_dirty()` stayed
//! `0` even though a real, non-empty frame was about to be logged.

use engine::abi::{Instance, Status};
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::world::{CacheCapacity, ChunkDims, PristineSource};
use engine::worldgen::Pristine;
use fx_persist::{FlatWorldgen, Persist};

fn params() -> WorldParams<Persist> {
    WorldParams {
        seed: 1,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

fn source() -> Box<dyn PristineSource> {
    Box::new(Pristine::<FlatWorldgen>::new(1, ()))
}

#[test]
fn connect_only_tick_dirties_the_world() {
    let mut lb = Loopback::<Persist>::new(params());
    let (_c, _player) = lb.add_client(0, ChunkDims::new(5), source(), CacheCapacity::Unlimited);

    let mut buf = vec![0u8; 4096];

    // The first connect: Joined + Connected, a real state write (`on_player`'s `Joined` arm).
    let n = lb.host.sim_seal_frame(&mut buf).expect("seal");
    assert!(n > 0, "the first connect must produce a real frame");
    lb.step();
    assert_eq!(
        lb.host.sim_dirty(),
        1,
        "the first connect's own Joined write must dirty the world"
    );

    // Snapshot to clear dirty, so the check below starts from a known-clean state.
    assert_eq!(lb.host.sim_snapshot_begin(0, 0), Status::Ok);
    loop {
        let n = lb.host.sim_snapshot_next(&mut buf).expect("drain");
        if n == 0 {
            break;
        }
    }
    assert_eq!(
        lb.host.sim_dirty(),
        0,
        "sim_snapshot_begin must clear dirty"
    );

    // Reconnect the *same* connection: `ever_joined` is already set, so `Host::connect` pushes
    // only `Record::Player{Connected}` this time -- no write, no `record_ack`.
    let conn0 = lb.conn(0);
    lb.host.connect(conn0);
    let n2 = lb.host.sim_seal_frame(&mut buf).expect("seal");
    assert!(
        n2 > 0,
        "a reconnect must still produce a real, non-empty frame"
    );
    assert_eq!(
        lb.host.sim_dirty(),
        1,
        "a logged Connected-only frame must dirty the world (Planning decisions 7: \
         'a put happened or a record was logged')"
    );
}
