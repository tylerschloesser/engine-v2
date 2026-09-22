# M15c: Cache invalidation on overlay replace, and terrain on screen

Status: not started · After: 15b · Tyler-dependent: no

Split from M15b at its gate, written by the orchestrator. M15b landed the ring `Connection`, the
worker plumbing and the ABI, and its connected-path tests pass; building its last two deliverables
found a real bug in **pre-existing M07/M08b code** that neither milestone's own tests could have
caught, because no code before M15b's `game_instance.rs` restructuring ever had a `Replica` and a
`TerrainFeed` sharing one `TerrainStore`. This milestone fixes that and finishes the two
deliverables it blocked. M16 depends on this milestone: "chunked world on screen" is part of the
vertical slice its marker claims.

## Goal
A chunk the client has already pristine-generated, and then receives a host snapshot for, comes back
as a resident, overlay-applied chunk and reaches the screen -- with the camera held still. The
fixture's ticking overlay tile is visible in a GPU readback, and 600 panning frames allocate nothing
in either worker.

## The bug, confirmed at M15b's gate
`TerrainStore::replace_overlay` (and `clear_overlay`) correctly evict the chunk from the dense cache
-- their own doc comment says "the next read regenerates and re-applies, which is always correct".
**Nothing triggers that next read while the camera holds still**, and two independent gates are why:
- `Cache::evict_if_present` (`world/cache.rs`), the path `replace_overlay`/`clear_overlay` take,
  removes the index entry, unlinks the slot and frees it **without calling `push_event`** -- unlike
  `materialize`'s own LRU-eviction path. So no `CacheEvent::Evicted` exists for `Uploader::on_frame`'s
  "changed" check to see. *Verified at the gate by reading `evict_if_present` directly.*
- `GenQueue::set_view` (`gen_queue.rs`) returns early on `self.last_visible == Some(view.visible)`
  alone, consulting no cache event at all. *Verified at the gate by reading the function's first
  statement.*

**The race is likely, not theoretical.** `TerrainFeed::on_frame`'s pristine-generation scan is
independent of, and typically faster than, the host round trip (camera send, `sim_admit`, tick,
downlink, apply), so a chunk entering subscription with real overlay content is normally already
resident client-side when its snapshot arrives. M15b's repro: camera fixed at `(0, 0)`, tile `(0, 0)`
pristine-generates, its host snapshot evicts it (`chunkSnapshots: 1`), and `client_chunk_hash(0, 0)`
reads `NotCached` forever while every other chunk in a 5x5 grid stays resident and `GenStats` reports
`requested: 25, delivered: 25, pending: 0, inFlight: 0`.

## Read first
1. `docs/spec/overview.md`
2. `docs/decisions/0007-world-model.md` (§1 overlays over pristine, the invisible dense cache and
   what "invisible" is allowed to mean; Consequences)
3. `docs/decisions/0008-chunk-generation.md` (§5 the generation set, `set_view`'s contract)
4. `docs/decisions/0018-renderer.md` (§3 the upload ring and its per-frame byte budget)

Also read `docs/plan/15b-ring-connection-and-replica-rendering.md`'s **Deviations** (the seam shapes
M15b landed, the repro above in full, and `connected-terrain.html`, which is already built and
working) and `docs/plan/09b-terrain-art-and-lifecycle.md`'s Deviations (the art contract and the
`floor(texel + 0.5)` sampling rule). Rules: `.claude/rules/determinism.md`, `.claude/rules/hot-paths.md`.

## Scope
- **Make overlay-driven eviction observable.** `Cache::evict_if_present` pushes a `CacheEvent` the
  same way `materialize`'s LRU eviction does, so a chunk evicted by `replace_overlay`/`clear_overlay`
  is distinguishable from one that was never resident. Keep `assert_cache_invisible`'s guarantee
  intact: events are a reporting channel, not state, and must not enter any hash.
- **Make the generation side consult it.** `GenQueue::set_view` (or `TerrainFeed::on_frame` -- pick
  the narrower of the two and say why in Deviations) must not skip its rescan when a chunk it cares
  about was evicted since the last call, even though `view.visible` is unchanged. `Uploader::
  on_frame`'s `changed` flag is the existing precedent for exactly this shape.
- **`overlay_tile_reaches_screen`**: the readback probe M15b could not build. `connected-terrain.html`
  exists and works; `fx-puts`'s `PutsClient::tile_visual` swaps the resource layer on `aux != 0`.
  Pristine colour before the tick rule fires, overlay colour after.
- **The zero-GC panning window** M15b's step 6 left unbuilt: 600 frames with panning, `sim` and
  `client` isolates within budget, ring `drops === 0`.
- **Whatever `enable_cache_events` this path needs** (M15's opt-in trap: a store paired with an
  `Uploader` that was never enabled drains nothing and shows no terrain, with no error).

## Non-scope
Actions (M16). Entities on screen, DrawList (M17). Pacing, token bucket (M31). `revealed()` and
gating the first draw (M28/M29). Do not redesign the dense cache or its LRU: the fix is to report an
eviction that already happens, not to change when eviction happens.

## Files, packages and crates touched
`packages/engine/crates/engine` (`world/cache.rs`, `world/terrain.rs`, `gen_queue.rs`,
`client/terrain_feed.rs`), `packages/engine/tests/browser`, `packages/engine/budgets.json` if the
new page needs rows.

## Seams
**Provides:** the `CacheEvent` variant (or reuse) that `replace_overlay`'s eviction emits, and
whatever `GenQueue`/`TerrainFeed` gains to consult it -- name both exactly in Deviations, since M16
and M17 build on this path.
**Consumes:** M15b `RingConnection`, `SimHost.accept`, the client worker loop, `connected-terrain.html`,
`netCounters`/`replicaHash`/`hostRegionHash`; M09 `Uploader::{patch_tile, enqueue_chunk}`,
`renderTo`/`readPixels` (the `client`-shaped overload); M08b `TerrainFeed`, `GenQueue`, `client_chunk_hash`;
M07 `TerrainStore::{replace_overlay, clear_overlay, materialize}`, `assert_cache_invisible`.

## Planning decisions
- **This is a reporting fix, not a caching-policy change.** The eviction is already correct; only
  its observability is missing. A fix that changes *when* chunks are evicted, or that keeps an
  evicted chunk resident, is out of scope and would touch 0007's invisibility guarantee.
- **`assert_cache_invisible` is the guard rail and must keep passing at capacity 1, default and
  unlimited with shuffled generation order.** If the fix makes a cache event affect any hash, it is
  wrong.
- **The browser suite has no headroom: it is at 22 s of 25 s with 103 tests** after M15b took ADR
  0020 §4's rung 3 (large-world variants born `@slow`). This milestone adds a readback test and a
  zero-GC page, so it **must** measure the suite line and take the next available rung before being
  accepted. New zero-GC pages get `@slow` burst controls automatically (ADR 0026). **If no rung
  remains that does not demote a feature's only test, stop and report** -- that means M36b's suite
  audit is being pulled forward, which is the orchestrator's call, not the implementer's.

## Order of work
1. A failing native test that reproduces the bug without a browser (pristine-generate, apply a
   snapshot, assert the chunk comes back resident on the next scan with the view unchanged).
2. The `cache.rs` event, then the `GenQueue`/`TerrainFeed` consultation. 3. `overlay_tile_reaches_screen`.
4. The zero-GC panning window. 5. Suite-line measurement and the rung decision.

## Tests added
Rust native: `overlay_replace_evicts_and_regenerates_with_view_unchanged` (step 1's reproducer, which
must fail before the fix and pass after -- paste both outputs); `cache_events_do_not_affect_any_hash`
(or extend `assert_cache_invisible`'s matrix). Browser: `overlay_tile_reaches_screen`, the zero-GC
panning window (600 frames, `sim` + `client` within budget, `drops === 0`).

## Exit criteria
- [ ] The step 1 reproducer fails before the fix and passes after, with both outputs pasted.
- [ ] `overlay_tile_reaches_screen` passes: pristine colour before, overlay colour after, by GPU readback.
- [ ] The zero-GC panning window passes for both `sim` and `client`, with `drops === 0`.
- [ ] `assert_cache_invisible` still passes at capacity 1, default and unlimited.
- [ ] The measured `browser` suite line is reported, and the rung taken (or the report that none remains).
- [ ] `pnpm test` and `pnpm lint` are green.

## Verification commands
`pnpm test rust -t overlay_replace` · `pnpm test rust -t cache_invisible` · `pnpm test browser -t overlay_tile` · `pnpm test browser -t panning` · `pnpm lint`.

## Budgets
Zero-GC rows for the panning page (M04 harness, ADR 0028's two-window rule, ADR 0029's software-mode
attribution). GPU upload row: M09's `uploadBytes` counter within the 0018 figure while panning.

## Context artifacts
Whatever `world/cache.rs`'s own module docs say about events, updated to state that an overlay
replace emits one and why.

## Manual device checks
none

## Deviations

**Steps 1-2 (native reproducer, then the fix) -- done.** Delegated as steps 1-2 only; steps 3-5
(the GPU readback test, the zero-GC panning page, the suite-line rung) go to a second implementer.

**Step 1's reproducer, both outputs.** `overlay_replace_evicts_and_regenerates_with_view_unchanged`
(`packages/engine/crates/engine/tests/gen_queue.rs`): materializes a chunk (pristine-generate),
calls `replace_overlay` on it (the host-snapshot path, which evicts it per 0007 §1), then calls
`GenQueue::set_view` again with `view.visible` byte-identical to the prior call.

Before the fix (`pnpm test rust -t overlay_replace_evicts_and_regenerates_with_view_unchanged`,
`gen_queue.rs`/`cache.rs`/`terrain.rs` reverted to `b812092`, test kept):
```
rust FAIL 1 tests    0.2s/10s
FAIL rust engine::gen_queue overlay_replace_evicts_and_regenerates_with_view_unchanged
  thread 'overlay_replace_evicts_and_regenerates_with_view_unchanged' panicked at
  packages/engine/crates/engine/tests/gen_queue.rs:249:5:
  set_view must not skip its rescan: the chunk was evicted since the last call, even though the
  view is unchanged
```
After the fix: `rust pass 1 tests    0.2s/10s`.

**1. The `CacheEvent` variant an overlay replace now emits: `CacheEvent::Evicted { chunk, slot }`,
reused, not new.** `Cache::evict_if_present` (`world/cache.rs`, the path `TerrainStore::
replace_overlay`/`clear_overlay` take) now calls `self.push_event(CacheEvent::Evicted { chunk:
ChunkCoord::from_key(key), slot })` before returning, exactly `materialize`'s own LRU-eviction shape
(same variant, same fields). `assert_cache_invisible`'s guard rail holds (Exit criteria, capacity 1/
default/Unlimited unaffected -- `evict_if_present` never runs in that matrix's own script, which
uses only `tile`/`set_tile`); a new, dedicated `cache_events_do_not_affect_any_hash`
(`tests/world_cache_invisible.rs`) interleaves `set_tile`/`replace_overlay`/`clear_overlay` across
two stores (one with cache-event recording enabled and drained mid-run, one that never enables it)
and asserts the final `hash_state` and every tile read agree. Two more unit tests pin
`evict_if_present` itself at the `Cache` level (`world/cache.rs`'s own `#[cfg(test)]`): it reports
exactly one `Evicted` and is a no-op (no event, no counter move) when the key is absent.

**2. The exact method that consults it: `GenQueue::set_view(&mut self, view: &GenView, store:
&TerrainStore) -> bool` -- unchanged signature, narrower than touching `TerrainFeed::on_frame`.**
Chose `GenQueue::set_view` over `TerrainFeed::on_frame` because `set_view` already takes `&
TerrainStore` and already owns the exact early-return this bug lives in (`self.last_visible ==
Some(view.visible)`); fixing it there needed no new parameter anywhere in the call chain
(`TerrainFeed::on_frame`, `game_instance.rs`'s `frame()` dispatch) and no change to either's public
shape. The early-return condition is now `self.last_visible == Some(view.visible) &&
self.last_invalidation_seq == store.cache_invalidation_seq()`; on any re-scan (view changed or an
invalidation happened since), `self.last_invalidation_seq` is set to the freshly-read value before
returning. (Named `invalidation_seq`, not `eviction_seq` -- see fix round 1 below; the field was
renamed after the gate found the broader trigger livelocking.)

**3. The two-consumer problem flagged in the delegation prompt was real, and is not fixed by
reusing `drain_cache_events`.** `game_instance.rs`'s `frame()` calls `c.feed.on_frame(camera,
terrain)` *then* `c.uploader.on_frame(camera, terrain)` against the *same* `TerrainStore` every
tick; `Uploader::on_frame` is the queue's one existing consumer (`store.drain_cache_events`, gated
on `changed`). Had `GenQueue::set_view`/`TerrainFeed::on_frame` also called `drain_cache_events`,
it would run first in that same `frame()` call and drain the `Evicted` event before `Uploader::
on_frame` ever saw it, permanently starving the uploader's own `changed` flag of exactly the
eviction that makes it necessary (verified by reasoning about the call order in `game_instance.rs`;
not fault-injected, since building it the starved way and then un-building it would have cost a
step for a shape this brief already asked me not to pick blind). Fix shape chosen instead: **`Cache`
gained a second, always-on signal separate from the opt-in event queue** -- `invalidation_seq: u64`,
a monotonic counter bumped inside `Cache::evict_if_present` (fix round 1 narrowed this from "inside
`push_event`, on every `Evicted`" -- see below) *regardless of `record_events`* (a scalar increment
carries none of the unbounded-growth risk `record_events` exists to gate, per M15's own
fix-round-3 comment on that field). Exposed as `TerrainStore::cache_invalidation_seq(&self) -> u64`,
a peek that never drains anything. `GenQueue` gained one field, `last_invalidation_seq: u64`,
compared against it. This means `GenQueue::set_view`'s own consultation works even for a store that
never calls `enable_cache_events` at all (e.g. `tests/gen_queue.rs`'s `ZeroSource`-backed stores,
`tests/no_alloc_gen_queue.rs`) -- deliberately: the counter's cost is one field and one branch per
invalidation, not a queue, so there was no reason to gate it the same way.

**4. `enable_cache_events`: no change needed.** `ClientInstance::init` (`game_instance.rs:125`)
already calls `replica.terrain_mut().enable_cache_events()` unconditionally (landed with M15b's own
fix for the M15 opt-in trap) on the one store `TerrainFeed`/`Uploader` now share, so the silent-drop
case the brief's Scope names ("a store paired with an `Uploader` that was never enabled") was
already closed before this milestone. Checked, not touched. A caller needing `GenQueue`'s new
consultation to work has nothing extra to call: `cache_invalidation_seq` reads `invalidation_seq`,
which is unconditional.

**No ordering constraint added.** Because `GenQueue::set_view`'s consultation is a peek
(`cache_invalidation_seq`) and not a drain, `TerrainFeed::on_frame` and `Uploader::on_frame` remain
order-independent with respect to each other's correctness (unlike the two-drain shape rejected in
item 3) -- `game_instance.rs`'s existing feed-then-uploader order is retained but is no longer load-
bearing for this fix.

**Context artifact written:** `world/cache.rs`'s own module doc comment now states that every
eviction (LRU or `evict_if_present`) reports a `CacheEvent::Evicted`, why (a consumer cannot
otherwise tell "never resident" from "resident, then invalidated"), and what `invalidation_seq` is
for and why it is narrower than "every eviction" (updated again at fix round 1, below).

**Verification, steps 1-2 as originally landed (superseded by fix round 1's own numbers below for
the trigger's final shape).** `pnpm test rust -t overlay_replace` (1, both outputs above), `pnpm
test rust -t cache_invisible` (6, includes the new `cache_events_do_not_affect_any_hash`), `pnpm
test rust -t queue` (15), `pnpm test rust -t world` (53), `pnpm test rust -t no_alloc` (8, includes
`no_alloc_gen_queue`/`no_alloc_terrain`/`no_alloc_connection` unaffected), `pnpm lint` (biome/
rustfmt/clippy/tsc all pass). `pnpm test`/the browser suite were not run (Non-scope for this range;
steps 3-5's own implementer measures the suite line per the brief's own gate) -- **this is exactly
what let the livelock below through**: nothing in the targeted native runs above exercises a cache
smaller than the generation set under a wide view, which is what the gate's browser run found.

## Fix round 1 (gate feedback)

**Gate failure.** `pnpm test` at `7f11cb2`: `browser FAIL 103 tests 32s/25s WARN over budget` (was
21s/25s on the base commit), `terrain: evicted slot shows new chunk, never stale texels` failing
with `__terrainClient.idle: never reached a quiet steady state`, plus three `gc input` budget
failures (`main` 213.97/219.85/241.51 B/frame against a 190 B budget). The coordinator's hypothesis:
`invalidation_seq` (then still named `eviction_seq`) bumped on *every* `Evicted`, including
`materialize`'s own LRU capacity eviction, which closes a feedback loop under a cache smaller than
the working set -- a livelock, not a slowdown.

**Measured, natively, before touching the fix.** `terrain-readback.spec.ts`'s own failing test uses
`clientCacheChunks: 2` under a wide view (`setHalfExtent(64, 64)`), i.e. deliberately smaller than
the generation set, so `materialize`'s LRU eviction never stops. Reproduced the same shape in
`gen_queue.rs` (temporary diagnostic, since removed): `CacheCapacity::Chunks(2)`, a 5x5-chunk view,
500 simulated frames of `set_view` + one `take`/`materialize`/`complete` cycle each. **Before the
fix:** `rescans over 500 frames = 498, materialize calls = 500, final GenStats = GenStats {
requested: 578, dispatched: 500, delivered: 500, cancelled: 0, requeued: 0, pending: 78,
in_flight: 0 }` -- confirms the mechanism exactly: `set_view` re-scans on all but the warm-up frame,
and `requested` (578) far exceeds the true chunk count (the 5x5 view's own generation set is smaller
than that), meaning chunks are being re-requested repeatedly rather than generated once. This
matches "never reached a quiet steady state" directly: the gen queue itself never quiesces
(`pending: 78` still nonzero at frame 500), so the browser page's `idle()` (which requires
`pending === 0 && inFlight === 0` for 8 consecutive frames) can never return.

**Cause, and the fix.** The trigger was too broad, exactly as hypothesized. `set_view`'s own touch
pass (`for chunk in ring3.iter() { if store.is_cached(chunk) { store.touch(chunk) } }`) is what
already protects a genuinely-wanted chunk from LRU eviction *when the cache has room*; when it does
not (capacity 2 against a much larger retained ring), eviction inside the view is unavoidable and is
a retention-sizing fact, not a content change -- `evict_if_present` (the invalidation path
`replace_overlay`/`clear_overlay` use) is what the brief's own bug report is actually about.
Narrowed the trigger to that path alone:
- `Cache::invalidation_seq` (renamed from `eviction_seq`) now bumps **only inside
  `Cache::evict_if_present`**, not generically in `Cache::push_event`. `push_event` still records
  every `CacheEvent::Evicted` (LRU or invalidation) into the opt-in `events` queue exactly as
  before -- `client::upload`'s `Uploader::on_frame` still needs to know about *every* eviction, to
  free the GPU page slot and clear the stale indirection entry, regardless of cause. Only the
  peek `GenQueue::set_view` consults got narrower.
- `TerrainStore::cache_eviction_seq` renamed to `cache_invalidation_seq`; `GenQueue`'s
  `last_eviction_seq` field renamed to `last_invalidation_seq`. Renamed rather than left as a
  misleading name, since it no longer counts every eviction.
- New permanent regression test, `set_view_reaches_quiescence_under_lru_capacity_churn`
  (`tests/gen_queue.rs`, replacing the temporary diagnostic): same capacity-2, wide-view, 500-frame
  shape; asserts `pending == 0`, `in_flight == 0`, `requested == delivered` (no runaway
  re-requesting), and at most 2 re-sorts after warm-up. **After the fix:** `rescans over 500 frames
  = 1, materialize calls = 81, final GenStats = GenStats { requested: 81, dispatched: 81,
  delivered: 81, cancelled: 0, requeued: 0, pending: 0, in_flight: 0 }` -- quiescence reached
  essentially immediately, `requested` equals the true chunk count with no further growth.
- New permanent regression test, `lru_capacity_eviction_does_not_bump_invalidation_seq`
  (`world/cache.rs`'s own `#[cfg(test)]`): capacity 2 against 10 distinct keys, asserting eviction
  happened (`acquire` returned `Some`) but `invalidation_seq` did not move.

**Step 1's reproducer still passes, and for the same reason as before** (not a different one under
the narrower trigger): its own eviction is `replace_overlay`'s, i.e. `evict_if_present`, which is
exactly the path `invalidation_seq` still counts. `assert_cache_invisible` (capacity 1/default/
Unlimited) is unaffected -- narrowing when `invalidation_seq` bumps changes nothing about
`CacheEvent`, state, or hashing.

**Verified after the fix.** `pnpm test rust -t quiescence` (1), `pnpm test rust -t invalidation_seq`
(4), `pnpm test rust -t lru_capacity` (2), `pnpm test rust -t overlay_replace` (1, unchanged),
`pnpm test rust -t cache_invisible` (6, unchanged), `pnpm test rust -t cache_events` (4, unchanged),
`pnpm test rust -t queue` (15), `pnpm test rust -t cache` (26), `pnpm test rust -t world` (54),
`pnpm test rust -t no_alloc` (8), `pnpm lint` (biome/rustfmt/clippy/tsc all pass). The browser suite
and `gc input` were **not** re-run by this implementer -- targeted foreground native runs only, per
the coordinator's own instruction; the coordinator's own `pnpm test browser -t "evicted slot shows
new chunk"` and `pnpm gc input` are how this gets confirmed against the actual failures.

**Not done, and why (this range's own cut line).** Steps 3-5 (`overlay_tile_reaches_screen`, the
zero-GC panning window, the suite-line rung) are untouched: `packages/engine/tests/browser` and
`budgets.json` were explicitly out of scope for this range. `connected-terrain.html` (M15b) should
now be able to build the readback test the bug previously blocked -- worth the next implementer
re-reading "The bug, confirmed at M15b's gate" against this fix before starting, since that section
is now historical (fixed), not current.

## Steps 3-5 (readback, zero-GC panning window, suite-line measurement) -- done

Delegated as steps 3-5 only, continuing from steps 1-2's own fix above. Commits `80d8061` (step 3),
`888a6f5` (step 4).

**3. `overlay_tile_reaches_screen`** (`connected-terrain.ts`/`connected-terrain.spec.ts`). Added
`window.__writeFrameUniform(v: FrameUniformValues)` and `window.__renderAndRead(width, height):
Promise<{width,height,data:number[]}>` to `connected-terrain.ts`, both routed through `renderTo`/
`readPixels`'s **`Renderable` overload** (`renderer` directly), not the `Client` overload -- the
`Client` overload builds its own `RingConsumer(client.uploadRing)` internally, which would be a
*second*, independent consumer racing the page's own pre-existing background upload-drain interval
over the same ring. Camera fixed at tile `(0, 0)` throughout (`originCamera(16)`: `tilesPerPx: 1`,
"pixel index === tile index" convention, tile `(0,0)` lands on pixel `(8, 8)`); `GRASS`/`WATER`
([34,139,34,255]/[30,80,200,255]) both have `"band": 0` in `tiles.json`, so this probe needed no
dithering/boundary reasoning at all.

**Found: `fx-puts`'s tick rule paints tile `(0,0)` on tick 0, the very first simulated tick**
(`Puts::tick`: `cx.tick().0 % secs_1 == 0` is true at tick 0), not merely "once per second" starting
later -- so "pristine colour" is provable only strictly before any host tick runs, never merely
before some elapsed interval. The test drives three `__advance(0,0,8,ticks)` calls with the camera
never moving except inside `settleUploads` (below): 0 ticks (client-only pristine generation) ->
render GRASS; 1 tick (paints + downlinks a snapshot that evicts the tile, `chunkSnapshots > 0`
asserted); 0 more ticks (the M15c fix's own rescan) -> render WATER.

**Found: a second, pre-existing gap, in `Uploader::on_frame` (`client/upload.rs`), separate from
this milestone's own fix and out of its Non-scope ("do not redesign the dense cache or its LRU").**
`Uploader::on_frame`'s early return is `!changed && self.last_visible == Some(visible)`, where
`changed` comes only from drained `CacheEvent`s -- there is no event for "a chunk newly finished
generating" (`TerrainFeed::deliver`, which materializes a pristine or regenerated chunk, runs on the
client worker's own gen-result pump, not from `frame()`, so it never itself triggers a rescan).
Under a genuinely static camera, the *first* `on_frame` call (when the chunk of interest is not yet
resident) is also the *last* one to scan, until either an eviction fires or the visible rect itself
changes -- so a chunk that finishes generating asynchronously, after that first call, never gets
staged for upload at all while the camera holds still. Every existing page/test that already renders
correctly does so because its camera moves every frame; this readback's own camera deliberately does
not (the milestone's Goal: "with the camera held still"), which is exactly what exposed it. Not
fixed (Non-scope for this milestone); worked around test-locally in `connected-terrain.spec.ts`'s
`settleUploads()` -- a one-tile camera nudge and back, both across real `stepFrame` calls with zero
host ticks, forcing two more `visible`-changing `on_frame` scans. Confirmed by fault injection: with
`GenQueue::set_view`'s own `last_invalidation_seq == invalidation_seq` conjunct temporarily removed
(reverted to the pre-fix `if self.last_visible == Some(view.visible) { return false }`), `pnpm test
browser -t overlay_tile` fails at the WATER check (`expectPixel(8, 8) channel g: got 32, want 80` --
32 is `NEUTRAL`'s own `g`, i.e. the tile never came back resident); restoring the fix passes again,
with `git diff` on `gen_queue.rs` empty afterward (no stray edit left behind). This is real evidence
the browser test depends on the fix, not just on the jiggle -- the jiggle only helps the *upload*
side notice residency, never GenQueue's own re-request decision (verified by the same injection:
`GenQueue`'s rescan-on-invalidation happens in the *un-jiggled* call, step 3's leading `__advance`,
strictly before `settleUploads` ever moves the camera).

Verified: `pnpm test browser -t overlay_tile` (1 test, ~2s/25s), `pnpm test browser -t hidden_tab`
(1 test, unaffected), `pnpm test browser -t terrain` (25 tests, unaffected), `pnpm --filter engine
typecheck` (clean).

**4. The zero-GC panning window** (`gc-connected-terrain.html`/`.ts`, `gc-connected-terrain.spec.ts`,
new `budgets.json` row `connected-terrain`). A real `createClient()` local, connected
(`host.connect: true`) topology over `fx-puts`, real device/renderer, `gc-terrain.ts`'s own panning
shape (`~8 tiles/s`, `halfExtentTilesX/Y: 24`) -- the first zero-GC page combining a real `sim`
isolate, a real `RingConnection` and a real renderer/pan. `drive()` differs from `gc-terrain.ts`'s
in one way: `asHarness.stepTick()` alone never ticks `sim` for real (it never touches
`CB_SIM_STEP_REQ`, `gc-sim.ts`'s own doc comment on why real-time pacing never arms in test mode),
so `drive()` also calls `stepSimTickSync(client, 1)` (`gc-sim.ts`'s own precedent) every frame, in
addition to (not instead of) `harness.stepTick()` (kept for `gen0`'s own reliable per-frame wake,
`gc-terrain.ts`'s own reasoning) -- the redundant wake is harmless per ADR 0030's `wokenBy ===
lastWokenBy` guard. `window.__netCounters` exposes `netCounters(client)` for the drops check.

**Budget row, derived (not copied) -- measured `playwright test --project gc --grep
"connected-terrain clean" --repeat-each 8 --workers 1`:** `main` 102.09-102.29 B/frame -> ceil(102.29)
= 103, + 8 B margin = **111** (`terrain`'s own shape: a real adapter, the 110 B floor applies).
`client` 2.52 B/frame constant, `gen0` 0.8267 B/frame constant -- both far under the repo's usual
flat **8** B worker figure, kept unchanged. `sim` 6.46-8.19 B/frame across the 8 repeats
(`windowBytes.sim` [4912, 5008] on the one high repeat vs. ~[3860, 3900] on the rest -- a modest
run-to-run spread, not a fixed multi-KB lump, read as JIT/warm-up noise rather than a per-tick
allocation bug) -- **not** given the repo's usual flat 8 B worker figure, since this isolate is a
real connected-host tick (subscription admission, snapshot/downlink building, `fx-puts`'s own tick
rule) rather than a bare `stepSimTickSync` loop, and measures well above every other page's `sim`
row (all under ~4 B/frame): ceil(8.19) = 9, + 8 B margin = **17**. `software: null` (0016 caveat b;
not derived this range -- `pnpm gc software` was not run).

Verified: `pnpm test browser -t connected-terrain` (8 fast-tier tests: clean, `object` x4 isolates,
the ring-drops test below, plus the two pre-existing `connected-terrain.spec.ts` tests the same grep
also matches), `pnpm test:slow -t connected-terrain` (4 tests: `burst` x4 isolates), `pnpm --filter
engine typecheck` (clean; `__netCounters`'s global `Window` augmentation had to match
`connected.spec.ts`/`connected-terrain.spec.ts`'s own exact signature, `(conn?: number) =>
Promise<NetCounters>`, since a `declare global` is project-wide).

**"ring drops === 0"**: read as `RingStats.drops` on both `uplink` and `downlink`
(`netCounters(client)`'s own shape, `join_at_max_zoom_out_never_drops`'s established precedent in
`connected.spec.ts`) over the full 600-frame panning window, plus `chunkEntersPristine > 0` as
evidence the pan actually moved chunks through subscription inside the window (not merely that the
connection *could* survive an idle 600 frames). Both asserted `=== 0`; the test passed on first measured run.

**5. Suite-line measurement and the rung decision.** Measured twice, `pnpm test browser` (quiet
machine, `uptime` load average ~3.5, similar order to the base commit's own reported range):
**`browser pass 110 tests 21s/25s`**, then **`browser pass 110 tests 22s/25s`**. Base (this
delegation prompt): `103 tests, 21 s/25 s`. This milestone's own net addition across both
implementers is +7 fast-tier tests (`overlay_tile_reaches_screen`; `connected-terrain`'s own `clean`
+ 4 `object` negatives + the ring-drops test -- `burst` x4 stay `@slow`, excluded from this line) and
no measurable wall-clock growth (21-22 s both before and after, inside this machine's own normal
run-to-run spread). **No rung was taken, because none is needed**: 3-4 s of headroom remains against
the 25 s trip-wire, unchanged from the base commit's own margin -- unlike the gate-round-1 livelock
this same milestone found and fixed (21 s -> 32 s), nothing here pushed the line. This is a
measurement and a report only, per the delegation prompt's own instruction; taking ADR 0020 §4's
next rung, if a future milestone's own additions do push past budget, remains the orchestrator's
call.

**Context artifacts.** No new artifact beyond steps 1-2's own `world/cache.rs` module-doc update
(this range touched none of `packages/engine/crates/engine`).

**Not verified in this range.** `pnpm gc software`/a real `software` budget for `connected-terrain`
(left `null`, 0016 caveat b, sanctioned by the `gc-test` skill's own "Adding a page" step 2);
`pnpm gc reliability` (many-repeat stability check) was not run for the new page, only the
skill-recommended `--repeat-each 8` used to derive the budget row above.
