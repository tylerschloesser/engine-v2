//! `sampler_rate_and_on_change` (docs/plan/19-presence-channel.md Tests added): `ClientCore`'s own
//! presence sampler stays at or under 10 Hz while the sample keeps changing, sends nothing while it
//! holds still, and sends the final at-rest value exactly once. Driven entirely by explicit `t_ms`
//! values passed to `poll_uplink`/`set_presence` -- an injected clock, per the brief -- never a real
//! one.

use engine::client::{ClientCore, Replica};
use engine::game::{Game, PlayerId};
use engine::wire::UplinkReader;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile};
use fx_presence::{PlayerPresence, Presence};

struct FlatSource;
impl PristineSource for FlatSource {
    fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
        out.fill(Tile::new(1, 0, 0));
    }
}

fn client() -> ClientCore<Presence> {
    let dims = ChunkDims::new(Presence::CHUNK_BITS);
    let replica = Replica::<Presence>::new(
        dims,
        Box::new(FlatSource),
        CacheCapacity::Chunks(128),
        PlayerId(1),
    );
    ClientCore::new(replica)
}

/// LEB128 varint length in bytes, matching `ByteSink::put_varint`'s own encoding (7 payload bits
/// per byte): the same count the wire's own `presence (len varint + bytes)` framing spends on the
/// length prefix (`wire/CLAUDE.md`).
fn varint_len(mut v: u64) -> usize {
    let mut n = 1;
    v >>= 7;
    while v != 0 {
        n += 1;
        v >>= 7;
    }
    n
}

/// Polls once at `t_ms`, returning `Some(field_bytes)` -- just the presence field's own wire cost
/// (`len varint + payload`, not the whole `UplinkBatch`: type/flags/tick/action-count/camera are
/// counted separately by `counters.action.uplinkBytesPerAction`'s own row) -- when the batch
/// carried a presence sample, `None` otherwise (nothing due, or a batch with no presence attached).
fn poll_presence_field_bytes(c: &mut ClientCore<Presence>, t_ms: u32) -> Option<usize> {
    let mut buf = [0u8; 512];
    let n = c.poll_uplink(t_ms, &mut buf);
    if n == 0 {
        return None;
    }
    let batch = UplinkReader::read(&buf[..n], |_, _| {}).expect("well-formed uplink batch");
    let payload = batch.presence?;
    Some(varint_len(payload.len() as u64) + payload.len())
}

fn poll_has_presence(c: &mut ClientCore<Presence>, t_ms: u32) -> bool {
    poll_presence_field_bytes(c, t_ms).is_some()
}

#[test]
fn sampler_rate_and_on_change() {
    let mut c = client();

    // Phase A: a continuously changing sample, polled every 10 ms for one second (t = 0..990).
    // `set_presence` runs every "frame"; `poll_uplink` runs right after, as `game_instance.rs`'s
    // own `frame()`/`client_poll_uplink` pair does.
    let mut sent = 0u32;
    let mut presence_field_bytes_this_second = 0u64;
    for t in (0..1000u32).step_by(10) {
        c.set_presence(&PlayerPresence {
            pos: [t as i32, 0],
            vel: [0, 0],
        });
        if let Some(field_bytes) = poll_presence_field_bytes(&mut c, t) {
            sent += 1;
            presence_field_bytes_this_second += field_bytes as u64;
        }
    }
    // Budgets (docs/plan/19-presence-channel.md Budgets: "new budgets.json key
    // uplink_presence_bytes_per_s, measured by sampler_rate_and_on_change"):
    // `counters.presence.uplinkBytesPerSec` mirrors `counters.subscription.*`'s own convention
    // (`packages/engine/crates/engine/src/testing/budgets.rs`). Counts only the presence field's
    // own wire bytes (len varint + payload), matching the counter's own name -- the whole
    // `UplinkBatch`'s other bytes (type/flags/tick/action-count/camera) are a separate cost, not
    // this row's job (gate round 1 fix: the previous cut counted whole batches here, so its 320 B
    // ceiling silently included ~8 B/batch this row never claimed to cover).
    engine::testing::budgets::expect_within_budget(
        "counters.presence.uplinkBytesPerSec",
        presence_field_bytes_this_second,
    );
    // Inject-fail-revert (this test's own branch): raising `PRESENCE_MIN_INTERVAL_MS` above 100
    // (e.g. to 1) would let every one of the 100 polls above through -- `sent` would jump to 100,
    // failing this assertion; reverting the constant restores it to exactly 10.
    assert_eq!(
        sent, 10,
        "a continuously changing sample must go out at exactly the 10 Hz ceiling (0010 Rates), not more"
    );

    // Phase B: the sample stops changing right where phase A left it (x = 990, never sent -- the
    // last actual send inside phase A was x = 900 at t = 900). The first poll at least 100 ms after
    // that last send must carry this final, at-rest value once (Planning decisions: "the resting
    // value differs from the last sent one and goes out in the next slot").
    let resting = PlayerPresence {
        pos: [990, 0],
        vel: [0, 0],
    };
    c.set_presence(&resting);
    assert!(
        poll_has_presence(&mut c, 1000),
        "the final at-rest sample must be sent once"
    );

    // Every further poll with the same resting value, for a further half second, sends nothing.
    let mut rest_sends = 0u32;
    for t in (1010..1500u32).step_by(10) {
        c.set_presence(&resting);
        if poll_has_presence(&mut c, t) {
            rest_sends += 1;
        }
    }
    assert_eq!(rest_sends, 0, "a resting sample must send nothing further");
}
