# Transport lines

`engine::transport` moves items along lines: the engine half of conveyor belts. A line is one lane of items moving toward its front at a fixed speed; the engine owns the store, the per-tick rule, the surgery API, geometry, replication and item drawing, and knows nothing about belts, tiles or what an item is. A game owns the topology: which lines exist, how they link, where they lie, what feeds them ([0076](../decisions/0076-transport-lines-engine-game-split.md) §1, §3, §9). "Transport" here is this module; the network transport (sockets, adapters) is [sync-and-netcode](sync-and-netcode.md) and [runtime-and-hosting](runtime-and-hosting.md).

Where it lives:

- Rust (`packages/engine/crates/engine/src/transport/`): `mod.rs` (the API, `TransportRead`/`TransportWrite`, `TransportError`; its module doc lists each milestone's part), `line.rs` (the run store), `advance.rs` (the per-tick rule), `order.rs` (update order), `items.rs` (`insert_at`/`remove_at`/`take_front`), `surgery.rs`, `geometry.rs` (segments, chunk sets, the tile index), `codec.rs` (canonical bytes), `replicate.rs` (structure versions, the change list, the replica side), `forecast.rs` (the host's tracker), `follow.rs` (the replica's follower), `draw.rs` (`draw_items`; client-role code, exempt in `tests/main/module_layering.rs`). Each module doc holds the exact rule; this page is the map.
- Around it: `host/lines.rs` (which structures and forecasts a connection's frame carries), `wire/lines.rs` and `wire/forecast.rs` (sections 12 and 13; `wire/CLAUDE.md` owns the bytes), `world_access.rs` (`transport()`/`transport_mut()`), `client/frame_view.rs` (`item_time`, `transport_follow`).
- The fixture `packages/engine/fixtures/belts` (`fx-belts`, own `CLAUDE.md`) exercises every primitive without a game's rules; the reference game is the consumer (below).

## The model

- A line has `len` positions (1/256 tile), a `speed` in positions per tick (`1 <= speed < len`), an `Output` and its items front to back; position 0 is the front, items move toward it. `SPACING = 64` is the engine's constant minimum distance between items. `LineId` is host-allocated and never reused; `Item(u16)` is opaque, `0` reserved ([0076](../decisions/0076-transport-lines-engine-game-split.md) §1).
- `Output::{DeadEnd, Next, Merge { line, at }, Fork { a, b, partner }, Sink}`: what the front feeds. `Next` is a plain hand-off (a target at least the feeder's speed long, [0079](../decisions/0079-transport-core-decisions.md) §8); `Merge` a side-load into the middle of another line; `Fork` alternates between two targets on a one-bit toggle, and two inputs sharing its targets that name each other as `partner` (a splitter's lane; a mutual link `set_out` keeps and decode checks) take turns on a one-bit turn and share one toggle (M61: one that delivered last waits while the other's front item is also due, unless the other already advanced this tick, or when its landing leaves the partner room as the target stands); a fork lands like `Next`, right behind the target's rearmost item, so an output fed in turn stays compressed; `Sink` deletes and counts (`sunk`).
- Items are stored as gap-encoded runs `Run { item, count, gap }` in one arena, a doubly linked list per line; positions are prefix sums and never stored ([0077](../decisions/0077-transport-item-representation.md) A6, A6b). The encoded distance is `gap + SPACING` so decode can reject a spacing violation ([0079](../decisions/0079-transport-core-decisions.md) §2); a squashed pair (a reshape that cannot keep spacing) is a negative gap (§12). The bytes are `codec.rs`'s module doc.
- The store lives in `Store<G>` beside entities: encoded, hashed and snapshotted, and the one part of `Store` not mutated through `Delta` ([0076](../decisions/0076-transport-lines-engine-game-split.md) §7). The state hash covers it once a line has ever existed ([0079](../decisions/0079-transport-core-decisions.md) §1).

## Writes and the tick

- Writes are host-tick only, so a placement is predicted as an entity and mapped onto lines by the game's `tick` ([0076](../decisions/0076-transport-lines-engine-game-split.md) §6; the phases: [0079](../decisions/0079-transport-core-decisions.md) §4). Reads under prediction: [client-api](client-api.md) "Rust side".
- `advance` runs in `Sim::step` after `G::tick` ([simulation](simulation.md)), every line once in update order (`order.rs`; [0076](../decisions/0076-transport-lines-engine-game-split.md) §2), after the spawner schedules ([0079](../decisions/0079-transport-core-decisions.md) §21).
- The rule per line is `advance.rs`'s doc; its decisions: the jam cursor ([0079](../decisions/0079-transport-core-decisions.md) §3), `insert_back`'s landing (§10), cycles and their cut (§11), `Merge` and `Fork` (§15, §16), and what the scenarios measured (§23).
- `advance` returns whether anything changed and the host marks the world dirty on it ([0079](../decisions/0079-transport-core-decisions.md) §9).

## Surgery and primitives

The API is `TransportWrite` in `mod.rs` (each method's doc has its refusals): `create`, `destroy`, `split`, `join`, `extend_*`, `shrink_*`, `rescale`, `set_out`, `set_speed`, `set_segments`, `insert_back`, `insert_at`, `remove_at`, `take_front`, `set_spawner`, `declare_spawner` ([0076](../decisions/0076-transport-lines-engine-game-split.md) §3, [0079](../decisions/0079-transport-core-decisions.md) §7, §12). Redirects (what happens to a line whose output names a destroyed, split or joined line) are `surgery.rs`'s doc; how surgery carries a spawner schedule, and when `join` refuses one, is [0079](../decisions/0079-transport-core-decisions.md) §21. Rules that live only in code:

- A surgery that changes a line's `len` clears its segments and their tile-index entries; the game registers the new path with `set_segments` in the same tick.
- `join`'s refusal of a scheduled front is `Unsupported`, per lane: a game joining a belt's two lanes one at a time checks both before the first, or it leaves a pair half-joined.
- `set_caps` reserves the arenas once; a second call with other caps is `CapsFixed` ([0079](../decisions/0079-transport-core-decisions.md) §5).
- Every structure change stamps the line's `structure_version` and queues its id in a change list of `max_lines / 4` entries, drained by `Host::seal`; past it the list is marked overflowed and the host reconciles every line once (`replicate.rs`, `host/lines.rs`).
- A replica's store holds structures only and answers `sunk`, `toggle` and `fork_yield` (M61) `Unknown`.

## Geometry and the tile index

- The game registers each line's path as at most `MAX_SEGMENTS` segments (`Straight` or `Arc`, Q24.8, exact integer code with a table instead of transcendentals); the engine derives the chunk set, the anchor chunk (the chunk of position 0) and the tile index, never encoded ([0076](../decisions/0076-transport-lines-engine-game-split.md) §4, [0079](../decisions/0079-transport-core-decisions.md) §13, §14; `geometry.rs`'s doc).
- `lines_at(tile)` reads the index back: every `(line, offset)` entering the tile, ascending by line then offset. The index is sorted by `(y, x, line, offset)`, the order the per-chunk hash covers anchored structures in ([0079](../decisions/0079-transport-core-decisions.md) §17 (b)). A game stores no line id in an entity.
- `Transport::for_each_tile_in(rect, f)`: every indexed tile of a rectangle once, by row then `x`, with the lowest line id entering it (a belt's two lanes are one tile), no allocation: a renderer's read for one sprite per belt tile (M50).
- A line without segments has no chunk set and no anchor: it is never routed to a client, hashed per chunk or drawn, but it is sim state ([0079](../decisions/0079-transport-core-decisions.md) §22: an underground's hidden line).

## Caps and arenas

`max_lines` and `max_items` are world params (`WorldConfig.params.maxLines`/`maxItems`), default 0: a game without belts reserves nothing. Their arena is reserved once when the params arrive, never per tick, and counted by the init memory-split check ([world-and-worldgen](world-and-worldgen.md) "Cap and budgets"); actions never create lines, so `Growth` is unchanged; `create` and `insert_*` return `Full` at the caps ([0076](../decisions/0076-transport-lines-engine-game-split.md) §8, [0079](../decisions/0079-transport-core-decisions.md) §5). The recommended caps a belt game declares, and the phone pair, are [0079](../decisions/0079-transport-core-decisions.md) §21. A host reserves the run store and the forecast tracker, a replica the structures and the follower; the arena sizes at the recommended caps and at the phone pair are [0079](../decisions/0079-transport-core-decisions.md) §21 and the ledger in [0080](../decisions/0080-belts-budgets-as-measured.md) §1 (Memory). The transport arena sits inside the sim and client arenas ([threads-and-boundary](threads-and-boundary.md)).

## Replication

A line's **structure** (`len`, `speed`, `Output`, segments) is replicated whole-value in section 12 (`LineStructs`: `Put`, `Gone`) to every connection holding a chunk of the line's set; its **items** are never sent per tick, only corrected in section 13 (`Forecasts`) when the client's model of the line is wrong ([0078](../decisions/0078-transport-forecast-replication.md) §1, A3, A8; [0079](../decisions/0079-transport-core-decisions.md) §17, §18). Routing, the put budget, the per-tick frame for a line holder and degrade: [sync-and-netcode](sync-and-netcode.md).

- **The host's tracker** (`forecast.rs`, derived, never encoded or hashed) decides each line's `State`, `RunList` or `Arrival` ([0078](../decisions/0078-transport-forecast-replication.md) A3, A8; the detection is the module doc). Its spawner pool holds half the line cap (past it `set_spawner` is `Full` and a declaration is counted, not held).
- **The follower** (`follow.rs`, client only, never hashed) steps every held line's items by the forecast alone ([0078](../decisions/0078-transport-forecast-replication.md) §2, A8; the order of a frame's records is the module doc).
- **The item clock**: items are drawn at `FrameView::item_time()`, the follower's tick plus a fraction ([0078](../decisions/0078-transport-forecast-replication.md) A12). The alternative, a lagged follower, waits on Tyler's verdict ([0081](../decisions/0081-belts-fold-reference-decisions-questions-and-rules.md) §C).
- **Joins and reconnects**: a late join gets each held line's put with its list; the snapshot dedupe and the join at scale are [0078](../decisions/0078-transport-forecast-replication.md) A10, A11. A reconnect re-puts every held line (the resume hint keeps chunks, not lines).
- **Segment-less lines** cost only `Arrival`s at their exits ([0078](../decisions/0078-transport-forecast-replication.md) A14).
- **Hashes**: the per-chunk desync hash covers the structures anchored in the chunk and no item; the full state hash and snapshots cover everything ([0078](../decisions/0078-transport-forecast-replication.md) §6).
- **Counters**: on the client `ForecastCounters` (`forecasts_applied`, `state_messages_applied`, `arrivals_applied`, `forecast_seen_late`, `corrections`, `lists_unknown`, `records_unheld`; `forecastCounters(client)` in `engine/test`) and `transport.structsDropped`; on the host `HostCounters` (`halts`, `releases`, `dues`, `invalidations`, `states`, `run_lists`, `spawner_mismatches`, `spawner_declarations_dropped`, `pauses`, `resumes`, `log_overflows`). Byte budgets are the `counters.transport.*` rows of `packages/engine/budgets.json`.

## Spawner schedules

`set_spawner` gives a line a `Schedule` that is sim state and whose inserts the engine makes ([0079](../decisions/0079-transport-core-decisions.md) §21; the rule is `advance.rs`'s doc). A game that inserts through its own tick rule declares the rule instead (`declare_spawner`, derived) and re-declares it after every restore from `Game::declare_spawners` ([0079](../decisions/0079-transport-core-decisions.md) §19, §20; [persistence](persistence.md)).

## Drawing

A game's `ClientSide::extract` calls `transport::draw::draw_items(view, style, out)`: one sprite per visible item of every held line at the item clock, through the line's integer geometry, culled to `FrameView::visible()`; the game's `ItemStyle` picks sprite, layer and colour and a `min_px_per_tile` below which nothing is drawn (the atlas sizes a sprite). Belt tiles are the game's own sprites from `for_each_tile_in`; a predicted belt has no tile there until the host acks it. `fx-belts` draws items from 20 px a tile; why that cut, and the dense-view measurement, are [0076](../decisions/0076-transport-lines-engine-game-split.md) Consequences (milestone 50). The frame bench is `bench.frame_belts` ([renderer](renderer.md)).

## The reference game as the consumer

`games/reference` maps belt entities onto lines in its tick (`sim/src/rules/belts/topology.rs`): one line per lane per straight run, a curve its own arc pair, side-loads as `Merge`, runs at most `MAX_LINE_TILES` long; `apply` never writes transport and reads only the edited tile's shape, except an underground rotation (M60), which also reads the pairing scan of up to five tiles along the axis so both ends flip in one action. The rules (R1-R8, C1-C4, the edge rule, spawners, despawners, splitters, undergrounds) are that module's doc; why they are so is [0081](../decisions/0081-belts-fold-reference-decisions-questions-and-rules.md) §A (splitters §A.5), [0079](../decisions/0079-transport-core-decisions.md) §22 (undergrounds) and §21 (spawners); the player-facing rules are `games/reference/README.md` "Belts". Layouts for tests are text maps built by `sim/tests/common/layout.rs` and `tests/helpers/layout.ts` (one hash per layout on both sides), run with the conservation ledger (`common/census.rs`) in `sim/tests/scenarios.rs`; commands and helpers: `games/reference/CLAUDE.md`.

## Benches and budgets

The figures are [0080](../decisions/0080-belts-budgets-as-measured.md); the gate mechanism is [testing-and-tooling](testing-and-tooling.md).

- `slow_tick_belts_large` (`fixtures/belts/tests/bench_belts.rs`, release through `engine::testing::bench`): the bench world's whole tick, gated by `packages/engine/baselines/belts-tick.json` (its record: [testing-and-tooling](testing-and-tooling.md) "Benchmarks and baselines"). `slow_snapshot_belts_large` is recorded; `tick-belts-large node` (netcode, slow) is the `.wasm` twin, warn-only.
- `bench.frame_belts` (`frame-bench-belts.spec.ts`, page `belts-bench.html`): two scenes against `baselines/frame-belts.json`; the zoom-out scene's record count is `counters.render.beltsViewRecords`.
- `belts/saturated_view_bytes` (netcode): sections 12 and 13 against `counters.transport.downBytesPerSec`.
- The reference game's `?bench=belts` field (`bench-belts.spec.ts @slow`, `bench_belts.rs`) and the phone rows of the device-check skill (`M57-belts-*`).

## Tests

- `rust`: `crates/engine/tests/main/transport_{rules,surgery,outputs,geometry,access}.rs`, `forecasts.rs`, `line_replication.rs`; `tests/no_alloc_transport.rs`; unit tests beside each module. `fx-belts`: `tests/golden_scenarios.rs` (the `fx-belts` goldens, written by `pnpm golden belts`, replayed under Node and Bun by the `wasm` suite and in Chromium, WebKit and Firefox by `determinism.spec.ts`), `tests/props.rs` (conservation, spacing, throughput, ring lap time), `tests/bench_belts.rs` (the bench world, `belts_restore_keeps_spawner_schedules`, replication over `Loopback`), `tests/drawlist_belts.rs` (`drawlist_belts_hash_golden`, `no_alloc_drawlist_belts_2000_items`).
- `netcode` (`packages/engine/tests/netcode/belts*.test.ts`): structures, forecasts and bytes, edits, degrade, joins and the item clock; the arbiter (`support.ts`'s `arbitrate`: items equal on every held line every tick) and `measure()`; the harness names are in that directory's `CLAUDE.md`.
- `browser`: `gc-belts` (zero-GC page, [gc-test](../../.claude/skills/gc-test/SKILL.md)); `frame-bench`: `bench.frame_belts`.
- Reference game: `sim/tests/{topology,belt,belt_predict,spawner,splitter,underground,scenarios,bench_belts}.rs`; `topology_items.rs` runs only under the `test-hooks` feature, in the `rust` suite's slow-tier `test-hooks` leg; netcode `belt-*.test.ts` and browser `belt-*.spec.ts`, `splitter.spec.ts`, `underground.spec.ts`.

## Gotchas

- Caps 0 map nothing: a world without caps creates no line, so its hash differs from the same play with caps. A replay or a test host passes the world's caps.
- A restore must pass the world's caps: [persistence](persistence.md) "Gotchas".
- A predicted belt has no tile in the replica's index (and no items) until the host's put arrives.
- A `stepFrame` draws before it applies what arrived: a frame's draws are of the previous frame's follower.
- The client's `Tx` region is 4 KiB, so a test reading `lineItems` sees about 500 items of a line at most.
- Chunk sets and every chunk sort are `(cy, cx)`, the wire order, never `ChunkCoord`'s derived `(x, y)`.
- `Merge` and `Fork` crossings and segment-less exits are `Arrival`s and a merge landing resends its target's list: a side-load or splitter costs bytes per item, measured in [0078](../decisions/0078-transport-forecast-replication.md) A8, A15.
- Per-tick and per-frame code here allocates nothing ([hot-paths](../../.claude/rules/hot-paths.md)); `no_alloc_transport.rs` and `no_alloc_drawlist_belts_2000_items` police it.
