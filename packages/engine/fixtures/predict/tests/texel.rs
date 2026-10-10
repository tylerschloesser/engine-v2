//! `texel_upload_only_on_change` (M26 step 3):
//! `testing::testkit::Loopback::drain_and_stage` drains a real `ClientCore`'s own dirty queue
//! into a real `Uploader`, then stages through the real, overlay-aware `Uploader::stage_predicted`
//! -- not a reimplementation. `Fixability`: see `render.rs`'s own inject-fail-revert convention;
//! this file's own failability proof is in the step-3 report, not committed here.

use engine::client::Uploader;
use engine::client::upload::RECORD_BYTES;
use engine::game::{Game, PlayerId};
use engine::predict::Prediction;
use engine::sim::WorldParams;
use engine::testing::testkit::Loopback;
use engine::wire::CameraReport;
use engine::world::{CacheCapacity, ChunkCoord, ChunkDims, PristineSource, Tile, TilePos};
use engine::worldgen::Worldgen;
use fx_predict::{Action, Pos, Predict, PredictClient, PredictWorldgen};

struct GenSource;
impl PristineSource for GenSource {
    fn generate(&self, chunk: ChunkCoord, out: &mut [Tile]) {
        PredictWorldgen::generate(0, &(), chunk, out);
    }
}

fn dims() -> ChunkDims {
    ChunkDims::new(Predict::CHUNK_BITS)
}

fn params(seed: u64) -> WorldParams<Predict> {
    WorldParams {
        seed,
        worldgen: (),
        max_entities: 4096,
        max_modified_tiles: 4096,
        max_action_growth: 4096,
    }
}

fn loopback(seed: u64) -> Loopback<Predict> {
    Loopback::new(params(seed))
}

fn add_client(lb: &mut Loopback<Predict>, delay: u32) -> (usize, PlayerId) {
    lb.add_client(
        delay,
        dims(),
        Box::new(GenSource),
        CacheCapacity::Chunks(1024),
    )
}

fn camera(cx: i32, cy: i32) -> CameraReport {
    CameraReport {
        center_x: cx,
        center_y: cy,
        half_w: 20,
        half_h: 20,
        vel_x: 0,
        vel_y: 0,
    }
}

// Module doc comment, `client/upload.rs`: `1 CHUNK`, `2 PATCH`, `3 INDIR` (private constants
// there; hardcoded here, matching this crate's own record-header offsets).
const KIND_CHUNK: u16 = 1;
const KIND_PATCH: u16 = 2;

fn chunk_texel(rec: &[u8], index: usize) -> (u16, u16) {
    let base = 16 + index * 4;
    (
        u16::from_le_bytes([rec[base], rec[base + 1]]),
        u16::from_le_bytes([rec[base + 2], rec[base + 3]]),
    )
}

/// A `PATCH` entry's own texel, if one exists for `target_slot`/`target_index` (entries carry
/// their own `slot` -- `client/upload.rs`'s own `PatchEntry`/`stage_patch`, module doc comment:
/// "up to 512 `{slot, index, texel}` entries").
fn patch_texel(rec: &[u8], target_slot: u16, target_index: u16) -> Option<(u16, u16)> {
    let count = u16::from_le_bytes([rec[4], rec[5]]) as usize;
    (0..count).find_map(|e| {
        let base = 16 + e * 8;
        let slot = u16::from_le_bytes([rec[base], rec[base + 1]]);
        let index = u16::from_le_bytes([rec[base + 2], rec[base + 3]]);
        (slot == target_slot && index == target_index).then(|| {
            (
                u16::from_le_bytes([rec[base + 4], rec[base + 5]]),
                u16::from_le_bytes([rec[base + 6], rec[base + 7]]),
            )
        })
    })
}

fn chunk_slot(rec: &[u8]) -> u16 {
    u16::from_le_bytes([rec[2], rec[3]])
}

/// Every record among `uploads` that mentions `target_slot` at all (a `CHUNK` record's own
/// header, or a `PATCH` record with a matching entry) -- what "never two uploads of a chunk in
/// one frame" means: not "the client staged nothing at all" (background subscription churn for
/// *other* chunks is unrelated and expected), but "at most one record about *this* chunk".
fn records_for_slot(
    uploads: &[(u16, Vec<u8>)],
    target_slot: u16,
    target_index: u16,
) -> Vec<&(u16, Vec<u8>)> {
    uploads
        .iter()
        .filter(|(kind, rec)| match *kind {
            KIND_CHUNK => chunk_slot(rec) == target_slot,
            KIND_PATCH => patch_texel(rec, target_slot, target_index).is_some(),
            _ => false,
        })
        .collect()
}

/// The effective texel `rec` (a `CHUNK` or `PATCH` record) carries for `target_slot`/
/// `target_index`.
fn texel_for(kind: u16, rec: &[u8], target_slot: u16, target_index: u16) -> (u16, u16) {
    if kind == KIND_PATCH {
        patch_texel(rec, target_slot, target_index).expect("checked by records_for_slot")
    } else {
        chunk_texel(rec, target_index as usize)
    }
}

/// Every record `Loopback::drain_and_stage` staged, as `(kind, bytes)` pairs.
fn stage(
    lb: &mut Loopback<Predict>,
    up: &mut Uploader<PredictClient, Predict>,
    idx: usize,
) -> Vec<(u16, Vec<u8>)> {
    let mut region = vec![0u8; RECORD_BYTES * 16];
    let n = lb.drain_and_stage(idx, up, 16, &mut region) as usize;
    (0..n)
        .map(|i| {
            let rec = &region[i * RECORD_BYTES..(i + 1) * RECORD_BYTES];
            let kind = u16::from_le_bytes([rec[0], rec[1]]);
            (kind, rec.to_vec())
        })
        .collect()
}

/// **A predicted `set_tile` uploads exactly its own chunk once at dispatch, with the predicted
/// texel; nothing more while replays carry the same content; at most one at the ack with
/// identical bytes; one at a rejection with the replica's own (unpainted) texel; never two
/// uploads of a chunk in one frame** (Tests added, verbatim).
#[test]
fn texel_upload_only_on_change() {
    let mut lb = loopback(1);
    let (idx, _who) = add_client(&mut lb, 3);
    lb.set_camera(idx, camera(10, 10));
    lb.run(4);
    let mut up = Uploader::<PredictClient, Predict>::new(dims());

    let tile = TilePos::new(5, 5);
    let index = (tile.y as usize) * 32 + (tile.x as usize); // chunk (0, 0), edge 32
    assert_eq!(dims().chunk_of(tile), ChunkCoord::new(0, 0));

    // Dispatch: exactly one CHUNK record, the predicted texel (base 9; the fixture's plain grass
    // at (5, 5) carries resource 0, `PredictWorldgen`).
    let (_seq, st) = lb.dispatch(
        idx,
        Action::Paint {
            tile: Pos {
                x: tile.x,
                y: tile.y,
            },
            base: 9,
        },
    );
    assert_eq!(st, Prediction::Applied);
    let uploads = stage(&mut lb, &mut up, idx);
    let chunk_records: Vec<_> = uploads.iter().filter(|(k, _)| *k == KIND_CHUNK).collect();
    assert_eq!(
        chunk_records.len(),
        1,
        "one upload of its chunk at dispatch: {uploads:?}"
    );
    let target_slot = chunk_slot(&chunk_records[0].1);
    assert_eq!(chunk_texel(&chunk_records[0].1, index), (9, 0));

    // Replays with unchanged content: zero uploads *of this chunk*, several steps in a row (no
    // ack yet, delay 3) -- background subscription churn for other chunks is unrelated.
    for step in 0..2 {
        lb.step();
        let uploads = stage(&mut lb, &mut up, idx);
        let mine = records_for_slot(&uploads, target_slot, index as u16);
        assert!(
            mine.is_empty(),
            "step {step}: no upload of this chunk while the overlay's own content is unchanged: \
             {mine:?}"
        );
    }

    // Run until the ack lands: at most one upload of this chunk in any single frame, and its
    // bytes are the same predicted value (0012: "converges with no visible change") -- never two.
    let mut saw_upload = false;
    for step in 0..20 {
        lb.step();
        let uploads = stage(&mut lb, &mut up, idx);
        let mine = records_for_slot(&uploads, target_slot, index as u16);
        assert!(
            mine.len() <= 1,
            "step {step}: never two uploads of this chunk in one frame: {mine:?}"
        );
        if let Some((kind, rec)) = mine.first() {
            saw_upload = true;
            let texel = texel_for(*kind, rec, target_slot, index as u16);
            assert_eq!(texel, (9, 0), "step {step}: identical bytes at the ack");
            break;
        }
    }
    assert!(saw_upload, "expected exactly one upload at the ack");
}

/// **A predicted `Paint` whose reject ack arrives after a conflicting `Place` delta lands first:
/// one upload of the chunk, showing the replica's own (unpainted) texel** (Tests added: "one at a
/// rejection with the replica's texel").
#[test]
fn texel_upload_on_rejection_shows_replica_texel() {
    let mut lb = loopback(2);
    let (slow, _who_slow) = add_client(&mut lb, 4);
    let (_fast, who_fast) = add_client(&mut lb, 1);
    lb.set_camera(slow, camera(10, 10));
    lb.set_camera(_fast, camera(10, 10));
    lb.run(4);
    let mut up = Uploader::<PredictClient, Predict>::new(dims());

    let tile = TilePos::new(6, 6);
    let index = (tile.y as usize) * 32 + (tile.x as usize);

    // The rival's real placement, admitted before `slow`'s own paint ack.
    lb.action(
        who_fast,
        Action::Place {
            origin: Pos {
                x: tile.x,
                y: tile.y,
            },
        },
    );
    lb.step();
    let _ = stage(&mut lb, &mut up, slow); // drain whatever this step alone produced

    let (_seq, st) = lb.dispatch(
        slow,
        Action::Paint {
            tile: Pos {
                x: tile.x,
                y: tile.y,
            },
            base: 9,
        },
    );
    assert_eq!(
        st,
        Prediction::Applied,
        "slow has not yet heard about the rival's machine"
    );
    let uploads = stage(&mut lb, &mut up, slow);
    // Base 9 is never produced by `PredictWorldgen` (grass = 0, water = 1): a `CHUNK` record
    // showing it at `index` can only be *this* dispatch's own predicted `Paint`, which is what
    // identifies the target chunk's own slot among whatever else this frame also staged
    // (background subscription churn for other chunks).
    let first_chunk = uploads
        .iter()
        .find(|(k, rec)| *k == KIND_CHUNK && chunk_texel(rec, index) == (9, 0))
        .expect("predicted upload at dispatch");
    let target_slot = chunk_slot(&first_chunk.1);

    let mut saw_revert = false;
    for step in 0..20 {
        lb.step();
        let uploads = stage(&mut lb, &mut up, slow);
        let mine = records_for_slot(&uploads, target_slot, index as u16);
        assert!(
            mine.len() <= 1,
            "step {step}: never two uploads of this chunk in one frame: {mine:?}"
        );
        if let Some((kind, rec)) = mine.first() {
            let texel = texel_for(*kind, rec, target_slot, index as u16);
            if texel == (0, 0) {
                saw_revert = true;
                break;
            }
        }
    }
    assert!(
        saw_revert,
        "expected the chunk to revert to the replica's own (unpainted) texel"
    );
}
