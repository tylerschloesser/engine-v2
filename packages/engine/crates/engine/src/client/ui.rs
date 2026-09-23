//! The `ui` call policy and its encode (docs/plan/16b-ui-observation-and-clock.md Scope): when the
//! replica changes or the client-side dirty flag is set, call `ClientSide::ui` into a reused
//! `G::Ui`, and only if the value differs from the last one emitted, serialise it into a kind-1 UI-
//! ring record (`[kind u8 = 1][len u32 LE][JSON]`, sharing `RegionId::Ui` with docs/plan/
//! 16-action-round-trip.md's kind-2 `ActionResults` records -- a consumer dispatches on the kind
//! byte, never assumes every record is one kind).

use crate::client::ClientSide;
use crate::client::frame_view::FrameView;
use crate::game::Game;

/// Kind byte for a UI-ring `Ui` record (docs/plan/16b-ui-observation-and-clock.md Scope). Kind 2
/// (`ActionResults`) is docs/plan/16-action-round-trip.md's own, sharing this same region and
/// buffer.
const UI_RECORD_KIND_UI: u8 = 1;

/// Appends one `[kind u8 = 1][len u32 LE][JSON]` record to `buf` for the current `G::Ui` value
/// (Scope: "serialise with `serde_json` into the UI-out region as a kind-1 record"). Called only
/// after [`UiObserver`]'s own `PartialEq` comparison found a real change, not per frame -- human-
/// rate, the same 0016 §2 exemption `game_instance::push_result_record`/`ClientCore::on_action`
/// already rely on: allocates a `String`, and `G::Ui` may itself own `Vec`/`String` (0003: "it is
/// not replicated").
fn push_ui_record<G: Game>(buf: &mut Vec<u8>, ui: &G::Ui) {
    let json =
        serde_json::to_string(ui).expect("G::Ui is TS + Serialize: JSON encoding cannot fail");
    buf.push(UI_RECORD_KIND_UI);
    buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
    buf.extend_from_slice(json.as_bytes());
}

/// Owns the reused `G::Ui` pair (`current`/`previous`, 0003: "a reused `G::Ui`") and the "should
/// `ClientSide::ui` run this frame" policy (Scope, Planning decisions "`Ui` is coalesced to the
/// newest value per rAF"): `ui` runs only when a frame mutated the replica since the last check
/// (`mutations`, `ClientCore::mutations()`) or the client-side dirty flag (0024 §7d) is set; its
/// output is compared by `PartialEq`, and only a real change is serialised.
pub struct UiObserver<G: Game> {
    current: G::Ui,
    previous: G::Ui,
    dirty: bool,
    last_mutations: u64,
    /// Test-only counters (coordinator gate, M16b cut 2: `no_ui_change_no_main_allocation` must
    /// assert, not merely claim in a `formula` string, that `ui` actually ran and that zero kind-1
    /// records were ever written). Plain `u32` wrapping counters, read only through the test-only
    /// `client_ui_stats` ABI export -- incrementing one costs nothing a hot path doesn't already
    /// pay (a field write), so this adds no allocation risk to the measured window itself.
    calls: u32,
    records: u32,
}

impl<G: Game> UiObserver<G> {
    pub fn new() -> Self {
        UiObserver {
            current: G::Ui::default(),
            previous: G::Ui::default(),
            dirty: false,
            last_mutations: 0,
            calls: 0,
            records: 0,
        }
    }

    /// Number of times `client.ui(..)` was actually invoked (`should_run` was true) since this
    /// observer was created -- test-only, `client_ui_stats`'s own first field.
    pub fn calls(&self) -> u32 {
        self.calls
    }

    /// Number of times a kind-1 record was actually appended (a real `PartialEq` inequality, not
    /// merely a call) since this observer was created -- test-only, `client_ui_stats`'s own second
    /// field.
    pub fn records(&self) -> u32 {
        self.records
    }

    /// The client-side dirty flag's setter (Scope: "0024 §7d: `Ui` may depend on client-side state
    /// such as the presence spring; M18 lands `FrameCx::ui_dirty()`, which sets the flag from
    /// `ClientSide::frame`; this milestone owns the policy and the flag, set in tests through a
    /// test hook"). Production sets it from `FrameCx::ui_dirty()` starting M18; until then only a
    /// test calls this directly.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Runs the call policy for one `frame(t_ms)`. `mutations` is `ClientCore::mutations()`'s
    /// current value, read by the caller so this type stays independent of `ClientCore` itself
    /// (native tests drive it with a hand-rolled counter, no `ClientCore` required). Returns
    /// whether a kind-1 record was appended to `out`.
    pub fn maybe_run(
        &mut self,
        client: &G::Client,
        view: &FrameView<'_, G>,
        mutations: u64,
        out: &mut Vec<u8>,
    ) -> bool
    where
        G::Client: ClientSide<G>,
    {
        let should_run = mutations != self.last_mutations || self.dirty;
        if !should_run {
            return false;
        }
        self.last_mutations = mutations;
        self.dirty = false;
        client.ui(view, &mut self.current);
        self.calls = self.calls.wrapping_add(1);
        if self.current != self.previous {
            push_ui_record::<G>(out, &self.current);
            core::mem::swap(&mut self.current, &mut self.previous);
            self.records = self.records.wrapping_add(1);
            true
        } else {
            false
        }
    }
}

impl<G: Game> Default for UiObserver<G> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Replica;
    use crate::client::frame_view::Clocks;
    use crate::game::{PlayerEvent, PlayerId, TickCx, Unknown, WorldWrite};
    use crate::world::{
        CacheCapacity, ChunkCoord, ChunkDims, PristineSource, PrototypeId, Registry, Tile, TilePos,
    };
    use crate::world_access::WorldRead;
    use crate::worldgen::Worldgen;

    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct UAction;
    #[derive(
        Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS,
    )]
    struct UReject;
    impl From<Unknown> for UReject {
        fn from(_: Unknown) -> Self {
            UReject
        }
    }
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct UEntity;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct UPlayer;
    #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
    struct UGlobal;

    /// This test module's own `Ui`: a plain counter, so a real change is directly observable
    /// through `PartialEq`.
    #[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, ts_rs::TS)]
    struct UUi {
        n: u32,
    }

    struct UWorldgen;
    impl Worldgen for UWorldgen {
        type Params = ();
        const WORLDGEN_VERSION: u32 = 0;
        fn generate(_seed: u64, _params: &(), _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    /// A `ClientSide` whose `ui` output is driven entirely by a field on the client itself (0024
    /// §7d: "`Ui` may depend on client-side state"), not by anything in `FrameView`'s own world --
    /// what `ui_reruns_when_dirty_flag_set` needs to isolate the dirty-flag half of the policy from
    /// any replica mutation.
    #[derive(Default)]
    struct UClient {
        n: core::cell::Cell<u32>,
    }
    impl ClientSide<UGame> for UClient {
        fn ui(&self, _view: &FrameView<'_, UGame>, out: &mut UUi) {
            out.n = self.n.get();
        }
    }

    struct UGame;
    impl Game for UGame {
        const SCHEMA_VERSION: u32 = 1;
        type Worldgen = UWorldgen;
        type Action = UAction;
        type Reject = UReject;
        type Entity = UEntity;
        type Player = UPlayer;
        type Global = UGlobal;
        type Presence = ();
        type Ui = UUi;
        type Client = UClient;
        fn register(_r: &mut Registry) {}
        fn prototype(_e: &UEntity) -> PrototypeId {
            PrototypeId(0)
        }
        fn anchor(_e: &UEntity) -> TilePos {
            TilePos::new(0, 0)
        }
        fn genesis(_w: &mut dyn WorldWrite<Self>) {}
        fn on_player(_w: &mut dyn WorldWrite<Self>, _who: PlayerId, _ev: PlayerEvent) {}
        fn apply(
            _w: &mut dyn WorldWrite<Self>,
            _who: PlayerId,
            _a: &UAction,
        ) -> Result<(), UReject> {
            Ok(())
        }
        fn tick(_cx: &mut TickCx<'_, Self>) {}
    }

    struct FlatSource;
    impl PristineSource for FlatSource {
        fn generate(&self, _chunk: ChunkCoord, out: &mut [Tile]) {
            out.fill(Tile::VOID);
        }
    }

    fn replica() -> Replica<UGame> {
        Replica::<UGame>::new(
            ChunkDims::new(UGame::CHUNK_BITS),
            Box::new(FlatSource),
            CacheCapacity::Chunks(128),
            PlayerId(1),
        )
    }

    fn view(r: &Replica<UGame>) -> FrameView<'_, UGame> {
        FrameView::new(
            r as &dyn WorldRead<UGame>,
            Clocks {
                authoritative: r.tick(),
                predicted: r.tick(),
            },
            r.own_player(),
        )
    }

    #[test]
    fn ui_called_only_after_replica_change() {
        let r = replica();
        let client = UClient::default();
        client.n.set(1);
        let mut observer = UiObserver::<UGame>::new();
        let mut out = Vec::new();

        // No mutation yet (mutations == last_mutations == 0): `ui` must not run at all.
        assert!(!observer.maybe_run(&client, &view(&r), 0, &mut out));
        assert!(
            out.is_empty(),
            "ui must not run before any replica mutation"
        );

        // A mutation (mutations moves to 1): `ui` runs, and since the value differs from the
        // `Default` previous, a record is written.
        assert!(observer.maybe_run(&client, &view(&r), 1, &mut out));
        assert_eq!(out[0], 1, "kind byte: Ui record");

        // No further mutation (mutations stays 1): `ui` must not run again, even though the
        // client's own field changed underneath it.
        out.clear();
        client.n.set(2);
        assert!(!observer.maybe_run(&client, &view(&r), 1, &mut out));
        assert!(out.is_empty());
    }

    #[test]
    fn ui_reruns_when_dirty_flag_set() {
        let r = replica();
        let client = UClient::default();
        client.n.set(5);
        let mut observer = UiObserver::<UGame>::new();
        let mut out = Vec::new();
        assert!(observer.maybe_run(&client, &view(&r), 1, &mut out));

        // No mutation, no dirty flag: no rerun.
        out.clear();
        client.n.set(6);
        assert!(!observer.maybe_run(&client, &view(&r), 1, &mut out));
        assert!(out.is_empty());

        // The dirty flag (the test hook standing in for `FrameCx::ui_dirty()`, M18) forces a
        // rerun even with `mutations` unchanged, and the new value (6) differs from the last one
        // emitted (5), so a record is written.
        observer.mark_dirty();
        assert!(observer.maybe_run(&client, &view(&r), 1, &mut out));
        assert_eq!(out[0], 1);
    }

    #[test]
    fn ui_unchanged_value_writes_nothing() {
        let r = replica();
        let client = UClient::default();
        client.n.set(9);
        let mut observer = UiObserver::<UGame>::new();
        let mut out = Vec::new();
        assert!(observer.maybe_run(&client, &view(&r), 1, &mut out));

        // A later mutation with the identical `Ui` value: `ui` runs (mutations moved) but the
        // `PartialEq` comparison finds no change, so nothing is written.
        out.clear();
        assert!(!observer.maybe_run(&client, &view(&r), 2, &mut out));
        assert!(out.is_empty());
    }

    /// The golden-JSON shape `bindings/PutsUi.ts` (M16b step 4, not built in this cut) must match:
    /// plain `serde_json` field order, no envelope beyond the kind-1 record header.
    #[test]
    fn ui_json_matches_ts_shape() {
        let mut buf = Vec::new();
        push_ui_record::<UGame>(&mut buf, &UUi { n: 42 });
        assert_eq!(buf[0], 1);
        let len = u32::from_le_bytes(buf[1..5].try_into().unwrap()) as usize;
        let json = core::str::from_utf8(&buf[5..5 + len]).unwrap();
        assert_eq!(json, r#"{"n":42}"#);
    }
}
