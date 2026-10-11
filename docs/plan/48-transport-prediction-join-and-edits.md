# M48: Prediction, late join and edits under replication

Status: not started · After: 47 · Tyler-dependent: no

Later-phase brief: goal, exit criteria and open questions. Filled in at the start of its phase.

## Goal
The replication of lines is complete and robust: a predicted placement never touches a line (`Unknown` under `Predicting`, pinned by a fixture scenario), edits during flow (cut, join, extend, destroy, speed change) replicate consistently with forecasts (a structure put and the line's forecast arrive together), late join at the stated scale is measured through the chunk bucket, degrade levels and frame overflow follow 0078 §7, and a reconnect with a resume hint keeps held structures. Phase end: tag `belts-replicated`.

## Read first
1. `docs/architecture/README.md`
2. `docs/decisions/0078-transport-forecast-replication.md` (§6, §7, Consequences: the late-join cost)
3. `docs/decisions/0076-transport-lines-engine-game-split.md` (§6)
4. `docs/architecture/sync-and-netcode.md` ("Prediction and reconciliation", "Sessions": resume hint)
Rules that apply: `.claude/rules/prediction.md`, `.claude/rules/hot-paths.md`.

## Scope (sketch)
- `fixtures/predict` or `fx-belts` loopback: an action that calls `transport_mut()` under prediction is `NotPredictable` and still sent; the host applies it (as a request) and the line appears with its forecast; the predicted `Request` entity renders as `PREDICTED` and disappears at the ack.
- Edit consistency: `belts/edit_during_flow_converges` (cut, join, extend, destroy, speed change while saturated; hash-all on structures; followability of forecasts after each edit).
- Late join: `belts/join_at_scale` on M45's world: bytes and virtual seconds until every structure in a 144-chunk view is held, through the 48 KB/s chunk bucket; recorded in Deviations and in 0078's Consequences; if over 10 s, the brief gains a compact structure encoding or a smaller default view as a planning decision (Tyler is asked if the default view changes: a default quoted in `docs/architecture/README.md` is his).
- Degrade: a client at level 2 and 4 receives the latest forecast per dirty line and misses nothing (`belts/degraded_client_follows`); frame overflow keeps forecasts dirty (`belts/overflow_keeps_dirty`), the one-second resend fires (`belts/stale_forecast_resent`).
- Reconnect: `belts/reconnect_keeps_structures` (resume hint with equal versions: `ChunkKeeps`, structures not resent; forecasts resent in full on reconnect).

## Seams
**Provides:** the netcode scenarios above (M56 reuses `edit_during_flow`), the join measurement, tag `belts-replicated`.
**Consumes:** M46, M47; `fixtures/predict` patterns (`warm_up_with_noise`), the resume hint (0013).

## Exit criteria
- [ ] Every scenario above passes with an inject-fail-revert recorded.
- [ ] `belts/join_at_scale` numbers are in Deviations and 0078's Consequences; a decision is recorded if over 10 s.
- [ ] `pnpm test`, `pnpm lint` and `pnpm test:slow netcode` are green; tag `belts-replicated` on the pushed commit.

## Open questions (answered by earlier phases)
- M47: whether position-window culling exists (changes the degrade and join tests).
- M46: structure encoding size per line (the join cost).

## Deviations
(filled in during execution)
