# packages/engine/fixtures

One line per fixture: what feature it pins. Each directory's own `CLAUDE.md` (where present) has
the detail; `hash` has none yet, described here instead.

- `hash` (`fx-hash`): determinism itself (docs/decisions/0002 §2) -- an f32 spring, the same sim in
  16.16 fixed point, and a SplitMix64 action stream, hashed and compared natively/Node/Bun/browser.
- `terrain` (`fx-terrain`): the renderer data path (gen worker -> `TerrainFeed` -> `TerrainStore` ->
  `Uploader` -> upload ring) with deterministic, hand-picked tiles so pixel-probe tests stay exact.
- `worldgen` (`fx-worldgen`): a real, non-trivial `Worldgen` impl (`docs/decisions/0008`) --
  height/moisture noise, a `hash2` resource scatter -- for the gen-worker and client pristine-cache
  paths, plus its own cache-invisibility and zero-allocation coverage.
- `puts` (`fx-puts`): `WorldRead`/`WorldWrite`/`Authority`/`Sim` (docs/plan/
  12b-world-access-and-sim-driver.md) against a real, non-trivial `Game` -- one handler per
  replicated scope (`Paint`/`Spawn` chunk-scoped, `SetNote` player-scoped, `SetMotd` global-scoped),
  `Bump`/`Remove` exercising the reject path, `Roll` exercising `SimRng`, and a `tick` rule that
  changes state on its own (no action) once a simulated second.
- `drawables` (`fx-drawables`, docs/plan/17-drawlist-and-sprites.md): `ClientSide::extract`/
  `FrameView::entities()`/`DrawList` -- three fixed genesis entities, one "small" and skipped by
  `extract` once `FrameView::zoom()` crosses `SMALL_ZOOM_THRESHOLD`. `tests/drawlist_golden.rs`
  proves `extract` + `sort_into`'s output is a pure function of replica + camera (a real, connected
  `Replica` built through `engine::testing::testkit::Loopback`) and pins it with
  `assert_golden_bytes!`.
