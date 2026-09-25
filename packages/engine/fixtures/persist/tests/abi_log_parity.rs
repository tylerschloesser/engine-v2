//! docs/plan/22-persistence-log-and-snapshots.md Exit criteria: "The native log written by step 3
//! and the log written by the Node host for the same script are byte-identical
//! (`log_bytes_native_equals_wasm`)." Step 3's own recorded log (`persist_fixture_log.hex`) was
//! built by directly pushing a hand-picked `Record::Player{Joined}` through testkit
//! (`support::record()`), bypassing `Host::connect`'s own real admit pipeline (which always queues
//! *both* `Joined` and `Connected` on a first connect) -- not reachable from a real `.wasm` build
//! at all (`Host::queue_action_for_test`-style backdoors are `#[cfg(feature = "testing")]`), so
//! that golden is the wrong baseline for an ABI-driven comparison. This test's own script goes
//! through the *real* admit pipeline instead (`testkit::Loopback::add_client`/`action`, exactly
//! `Host::connect`/`Host::on_uplink`), and blesses its own golden
//! (`persist_abi_log_parity.hex`) that `tests/wasm/persist-log-parity.test.ts` drives the identical
//! script against, over the real `.wasm`, through `sim_connect`/`sim_admit` -- the two must produce
//! byte-identical concatenated `sim_seal_frame()` output, since both run the same Rust code, one
//! native and one compiled to WASM.

use engine::abi::Instance;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::world::{CacheCapacity, ChunkDims};
use engine::worldgen::Pristine;
use fx_persist::{Action, FlatWorldgen, Persist, Pos};

fn params() -> WorldParams<Persist> {
    WorldParams {
        seed: 42,
        worldgen: (),
        max_entities: 64,
        max_modified_tiles: 64,
        max_action_growth: 64,
    }
}

fn seal_and_tick(lb: &mut Loopback<Persist>, log: &mut Vec<u8>) {
    let mut buf = vec![0u8; 8192];
    let n = lb
        .host
        .sim_seal_frame(&mut buf)
        .expect("sim_seal_frame must succeed once genesis has run");
    if n > 0 {
        log.extend_from_slice(&buf[..n as usize]);
    }
    lb.step();
}

#[test]
fn persist_abi_log_parity() {
    let mut lb = Loopback::<Persist>::new(params());
    let source: Box<dyn engine::world::PristineSource> =
        Box::new(Pristine::<FlatWorldgen>::new(42, ()));
    let (_client, player) = lb.add_client(0, ChunkDims::new(5), source, CacheCapacity::Unlimited);

    let mut log = Vec::new();
    seal_and_tick(&mut lb, &mut log); // Joined + Connected (Host::connect, both on first connect)

    lb.action(
        player,
        Action::PlaceTimer {
            at: Pos { x: 5, y: 5 },
            period: 7,
        },
    );
    seal_and_tick(&mut lb, &mut log);

    for _ in 0..3 {
        seal_and_tick(&mut lb, &mut log); // idle
    }

    lb.action(player, Action::Roll);
    seal_and_tick(&mut lb, &mut log);

    lb.action(
        player,
        Action::Harvest {
            at: Pos { x: 0, y: 0 },
        },
    );
    seal_and_tick(&mut lb, &mut log);

    lb.action(
        player,
        Action::Harvest {
            at: Pos { x: 0, y: 0 },
        },
    );
    seal_and_tick(&mut lb, &mut log);

    for _ in 0..5 {
        seal_and_tick(&mut lb, &mut log); // idle
    }

    engine::assert_golden_bytes!("persist_abi_log_parity", &log);
}
