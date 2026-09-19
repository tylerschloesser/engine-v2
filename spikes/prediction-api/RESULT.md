# Spike result: one `apply` handler for authority and for client prediction

Date: 2026-09-19. Native Rust, std only, ~45 min timebox. Throwaway code.
Answers the spike defined in `docs/research/sync.md` section 5.1.

## Verdict

**Yes.** One game-written `apply(world, who, action) -> Result<(), Reject>` ran unchanged against
(1) the authoritative full world, producing deltas, and (2) a partial client replica under a
prediction overlay with Factorio-style reset-and-replay, with the client running no tick rules.
10 tests pass (run, not assumed; see "How to re-run"). The fallback in `sync.md` 5.1 (separate
`predict()` functions and game-emitted deltas) is **not needed**.

The result is stronger than what the spike asked, in one respect: **the game author writes no
delta types at all.** The design that fell out:

> Replicated state lives in a `Store` whose only mutator is `Store::apply(&Delta)`. Every
> `WorldWrite` method is a whole-value put, and a put *is* a delta. The host applies the put and
> records it; the replica applies the same value; the overlay just remembers it.

So "deltas are the only write path" holds by construction on both sides, a chunk snapshot is just
more puts (idempotent, so duplicates across chunk borders are harmless), and
`Protocol::build_deltas/apply_delta/predict` from the `simulation.md` sketch disappear for this game.

It is a partial result in the places listed under "What did not work / was not built".

## Trait signatures that worked

```rust
pub struct Unknown; // a read hit state this client does not hold

pub trait Game: Sized + 'static {
    type Config: Clone;
    type Action: Clone + Debug;
    type Reject: From<Unknown> + Clone + PartialEq + Debug;
    type Entity: Clone + PartialEq + Hash + Debug;   // whole-value replicated; keep it plain data
    type Player: Clone + PartialEq + Hash + Debug;   // private per-player state

    fn pristine(cfg: &Self::Config, pos: TilePos) -> Tile;   // worldgen; total on host AND client
    fn tile_traits(tile: Tile) -> TraitSet;                  // table lookup
    fn entity_traits(e: &Self::Entity) -> TraitSet;
    fn footprint(e: &Self::Entity) -> Footprint;             // engine derives occupancy + relevance

    fn join(w: &mut dyn WorldWrite<Self>, who: PlayerId);
    fn apply(w: &mut dyn WorldWrite<Self>, who: PlayerId, action: &Self::Action)
        -> Result<(), Self::Reject>;                         // host live, host replay, client predict
    fn tick(w: &mut Authority<Self>);                        // HOST ONLY; same recording write path
}

pub trait WorldRead<G: Game> {                               // object-safe
    fn tick(&self) -> Tick;
    fn tile(&self, pos: TilePos) -> Result<Tile, Unknown>;
    fn entity_at(&self, pos: TilePos) -> Result<Option<EntityId>, Unknown>;
    fn entity(&self, id: EntityId) -> Result<Option<&G::Entity>, Unknown>;
    fn player(&self, who: PlayerId) -> Result<&G::Player, Unknown>;
    fn traits_at(&self, pos: TilePos) -> Result<TraitSet, Unknown> { /* provided */ }
}

pub trait WorldWrite<G: Game>: WorldRead<G> {                // every method == one Delta
    fn set_tile(&mut self, pos: TilePos, tile: Tile);
    fn spawn(&mut self, e: G::Entity) -> EntityId;
    fn put_entity(&mut self, id: EntityId, e: G::Entity);
    fn despawn(&mut self, id: EntityId);
    fn put_player(&mut self, who: PlayerId, p: G::Player);
}

pub enum Delta<G: Game> {                                    // engine-defined, not game-defined
    Tile { pos: TilePos, tile: Tile },
    EntityPut { id: EntityId, entity: G::Entity },
    EntityGone { id: EntityId },
    Player { who: PlayerId, state: G::Player },
}
```

Three implementors of the traits: `Authority<G>` (reads never `Unknown`; write = apply + record +
derive `Scope` from footprint/player), `Predicting<'_, G>` (reads overlay-then-replica, writes push
to the overlay), and read-only `View<'_, G>` (what the renderer/UI reads; the game's
`can_place_furnace(&dyn WorldRead, ..)` serves both `apply` and the placement ghost).

Client loop (`Client::on_frame`), exactly the four steps in `sync.md` 3.7: apply deltas to replica;
pop pending with `seq <= ack.seq` and raise `Confirmed`/`Rejected`; `overlay.clear()`; re-run
`G::apply` for each still-pending action.

Splitting `WorldRead`/`WorldWrite` was worth it; one `WorldAccess` would work but would stop the
UI from sharing rule code through a read-only view. `dyn` (not generics) was deliberate: handlers
compile once instead of twice, and it proved the traits are object-safe. It relies on trait-object
upcasting (`&dyn WorldWrite` -> `&dyn WorldRead`), stable since Rust 1.86.

## What the tests prove (`game/tests/`)

| Test | Shows |
|---|---|
| `predicted_placement_is_immediate_...` | Ghost visible before any traffic; the renderer-visible value (tiles, occupants by value, own player) is *equal* on every frame through and after the ack; overlay ends empty; provisional->real id map arrives with the ack |
| `rejected_because_another_player_took_the_spot_...` | Two clients, different delays. Never a torn state (ghost XOR refunded item). The rival's delta arrives *before* the reject ack, so re-prediction already fails and the ghost goes early; the ack then only removes the pending entry |
| `insufficient_inventory_...` | Third placement is rejected locally because two *pending* placements spent the items; host rejects with the same reason |
| `action_touching_an_unsubscribed_chunk_...` | See decision below |
| `two_pending_actions_that_depend_on_each_other_...` | Place (spanning a chunk border) + deposit into the still-predicted furnace. Includes the frame where place is acked and deposit is re-applied onto the now-authoritative furnace with its real id: no visible change |
| `timed_collect_...`, `timer_prediction_error_...` | Timers, below |
| `host_replay_from_genesis_...` | Replay of the action log (including rejected actions) reproduces the state hash; truncated log does not; both clients converge on the authority |
| `placement_is_trait_driven_...` | Water and "another furnace" are the same `NOT_BUILDABLE` query |
| `alloc.rs` | Zero allocations, below |

A mutation check (un-freezing the predicted tick) made both timer tests fail, so they are not vacuous.

### Decision: an action that touches an unsubscribed chunk -> "treat as unknown, decline to predict"

Reads outside the subscription return `Err(Unknown)`; `?` converts it via `From<Unknown> for Reject`.
The overlay also sets a `saw_unknown` flag on any such read (and on blind writes), and the flag
wins over whatever the handler returned, so a handler cannot swallow it by accident. The engine
then truncates the overlay to the pre-action mark, marks the pending action `NotPredictable`, and
**still sends it**. No ghost, no partial inventory spend; the UI can show "pending". The host has
the full world and decides; the result arrives as ordinary deltas (a furnace that overlaps a
subscribed chunk is delivered even if its anchor is outside).

Why not the alternatives: *predict only what is visible* draws a ghost whose validity depends on
tiles nobody checked, so mispredictions at the edge become systematic, and it needs the handler to
be partially applicable. *Reject locally* (do not send) makes the client's partial knowledge
authoritative over the host's full knowledge, which is backwards. With subscribe-at-ring-1 this
only triggers within a footprint of the subscription edge, i.e. off-screen.

Note that `tile()` is `Unknown` outside the subscription even though pristine terrain is total on
the client: the *overlay* of that chunk (a mined-out resource) is not held.

## Answers to the report-on items

**What the author writes; how much is boilerplate.** `game/src/lib.rs`, ~200 lines: data model and
tile packing (~75), four handlers plus the shared ghost check (~60 non-blank lines), the tick rule
(~18), `impl Game` glue (~45, mostly trait tables and worldgen). Prediction-specific code the author
writes: **5 lines** (`impl From<Unknown> for Reject`) plus a `?` on each read (11 in total). No
delta types, no `apply_delta`, no `predict`, no client code. The recurring idiom is
copy-modify-put: `let mut p = *w.player(who)?; ...; w.put_player(who, p);`. Two rules the author
must follow: (1) validate first, write after (the host `assert!`s that a rejecting handler recorded
no change; the client enforces it for free by truncating); (2) address things that may be predicted
by a stable key (tile), not `EntityId` (see problems).

**Can deltas be derived mechanically from writes?** Yes, completely, *if writes are whole-value
puts*. Scope (which chunks / which player) is derived from the footprint at write time; occupancy is
derived from footprints on both sides; chunk snapshots are puts. The cost is bandwidth: changing one
furnace field re-sends the furnace (12 bytes here). For plain-data entities the engine could later
byte-diff old vs new value at frame-build time without changing the game-facing API. Field-level
game-authored deltas (`ResourceChanged`, `InventoryChanged` in the `reference-game.md` sketch) are
an optimization, not a requirement.

**Timers on a client that runs no tick rules.** The handler writes
`Collect { started_at: w.tick(), done_at: w.tick() + 20 }`. Findings:
1. `w.tick()` under prediction must be **frozen per pending action** at submit time
   (`Pending::predicted_tick`). Otherwise every reset-and-replay rewrites the timer with a newer
   estimate and the bar crawls backwards. Easy to get wrong; now a test.
2. The client has **two clocks**: the authoritative one (`View::tick()`, latest frame) and the
   predicted one (`Client::predicted_tick()` = latest frame + lead, where lead ~ RTT). Own-player
   timers are written in the predicted clock and must be *rendered* in it, before and after the
   ack; then the bar advances 1/tick with no jump at the ack (tested). Everything not predicted
   (other players, machines) renders against the authoritative clock.
3. If the lead estimate is off by k ticks, the ack causes exactly one correction of k ticks (tested
   with k=2 of 20). That is the easing case in `sync.md` 3.10.
4. **Open UX problem, made concrete:** the bar reaches 100% at step 20 but the ore arrives at step
   27 (delay 3 => RTT 7 ticks): completion is a host tick rule, so its delta trails the predicted
   clock by one RTT. Options for Phase 2: accept a full bar for one RTT; render own timers over
   `duration + lead`; or allow an opt-in, game-declared "predicted expiry" (a tiny client-side rule,
   which is the first step toward client tick rules, so be careful).

**Allocation.** `Overlay` is three `Vec`s (tiles, entities incl. tombstones, players) that keep
capacity across `clear()`; last write wins via a backwards linear scan (entries are single digits);
rollback of a failed action is `truncate` to a mark. Measured with a counting global allocator:
**0 allocations over 190 reset-and-replay frames x 4 pending actions**, including frames that carry
puts for existing replica keys. So yes: reusable arena, zero steady-state allocation, provided
`G::Entity`/`G::Player`/`G::Action` are plain data (a `Vec` inside an entity would allocate on every
copy-modify-put). Allocation that remains, none of it per-frame-steady-state: replica map inserts
for *new* keys, the `Confirmed` event's remap `Vec`, frame `Vec`s (decode buffers in the real thing).

**Awkward across the WASM boundary later.**
- Nothing in these traits crosses the boundary: game + engine are one module, `dyn WorldWrite` and
  `&G::Entity` borrows stay inside it. `export_game!` must monomorphize `Host<G>`/`Client<G>`.
- `Delta<G>` embeds `G::Entity`/`G::Player`, so both need the `Codec` bound; whole-value puts make
  that codec trivial. The spike's state hash uses std `Hash` (native-endian); the real one must hash
  canonical bytes.
- **The renderer does not get a flat buffer.** The visible world is replica + overlay, and the
  overlay is rebuilt every frame even when its content is identical. To upload chunk slabs the
  engine must diff the overlay before/after each replay (small, cheap) and emit dirty tiles/entities
  plus a "predicted" flag. Not built.
- `ClientEvent::Confirmed { remap: Vec<..> }` should become fixed-size records in a ring buffer.
- A panic in `apply` under prediction traps the client instance; the host survives only if it is a
  different instance (it is, per `sync.md` 3.8).
- `Tick` is `u32`, ids are `u32`: nothing needs `BigInt` except the 64-bit state hash.

## What did not work / was not built

- **Entity ids under prediction.** The host allocates ids, so a predicted spawn gets a provisional
  id (`1<<31 | seq<<4 | n`, stable across replays). A follow-up action cannot name it. The spike
  addresses the furnace **by tile** (`Deposit { at }`), which differs from the
  `FurnaceDeposit { furnace: EntityId }` sketch in `reference-game.md`. The alternative is the engine
  rewriting ids inside pending game actions, which needs to see inside `G::Action`. What *did* work
  mechanically: the ack carries real ids in spawn order, and because the same handler ran on both
  sides the nth provisional id maps to the nth real id, with no game code.
- **`entity(id)` cannot tell "does not exist" from "outside my subscription"** on the client; both
  are `Unknown`. Fine for prediction, but a UI holding a stale id gets `Unknown`, not `None`.
- **A `NotPredictable` action poisons what follows it.** A later pending action that depends on it
  is predicted against a world missing its effects and can report `Rejected` locally while the host
  accepts. Local `Rejected` is therefore a hint, never a verdict (the client always sends). Probably
  right: once one pending action is `NotPredictable`, mark all later ones `NotPredictable` too.
- **Host atomicity is asserted, not enforced.** The client gets rollback for free; the host panics
  if a handler writes and then rejects. Enforcing it needs an undo journal on the host.
- Not built: chunk *leave*, `Global` scope, per-action `PREDICT = false`, `admit` hook, RNG in
  handlers (a predicted handler cannot share `SimRng`; such actions should opt out), iterating reads
  (`entities_in(rect)`; for `dyn` this needs a callback shape and a merge over the overlay), save/load,
  any byte encoding. `Store` uses `BTreeMap`s, not the per-chunk layout from `world.md`.
- The harness gives the client the *exact* lead (2*delay+1); clock estimation itself is untested
  beyond the fixed-skew test.

## Open problems for Phase 2

1. Decide: actions address predicted things by stable key (tile) vs engine-side id rewriting.
2. Own-timer completion gap of one RTT (options above).
3. Overlay -> renderer dirty list and "predicted" styling flag.
4. Taint rule after a `NotPredictable` pending action.
5. Whole-value puts vs engine-side byte diffing: measure on a busy furnace field before optimizing.
6. Iterating/range reads through an object-safe trait over replica + overlay.
7. Whether `tick` should take `&mut Authority<G>` (spike) or a narrower `TickCx` with iteration
   helpers; the point that matters is that tick rules use the same recording write path.
8. Fold into `simulation.md` 3.1: `Protocol::{build_deltas, apply_delta, predict}` become
   engine-provided; `SimState::save/load` becomes "serialize the `Store`".

## How to re-run

```sh
cd spikes/prediction-api
cargo test                                  # 9 scenario tests + 1 allocation test
cargo test --test alloc -- --nocapture      # prints the allocation counts
```

On this machine plain `cargo test` failed at link time ("You have not agreed to the Xcode license
agreements"). I did not accept the license; I ran with the separately installed Command Line Tools
instead, which changes nothing on the system:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo test
```

Layout: `engine/src/lib.rs` (traits, `Store`, `Authority`, `Host`, `Overlay`, `Client`),
`engine/src/harness.rs` (in-process loop, per-client delay in ticks), `game/src/lib.rs` (the cut-down
reference game), `game/tests/{prediction,alloc}.rs`.
