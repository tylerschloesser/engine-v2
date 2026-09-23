---
name: add-action-type
description: Add a new game action end to end -- the Rust variant, its handling, the regenerated TypeScript binding, and a page that dispatches it. Use whenever a game needs a new player-triggered action (a new Action enum variant) wired from the sim rules through to a browser page's dispatch call.
---

# Add an action type

An **action** is a serialized message expressing player intent (`docs/spec/overview.md`
glossary) -- the only way a page changes the sim. This skill adds one, end to end, for a game
crate under `packages/engine/fixtures/<game>/` (e.g. `puts`) whose `Game` implementation you are
extending. It assumes the round trip itself already exists (`client.dispatch` -> the sim -> the
result callback); you are only ever adding one new *kind* of message to it.

Worked example throughout: adding `SetMotd` to `fixtures/puts` and dispatching it from
`tests/browser/pages/src/puts-dispatch.ts` -- `SetMotd` already existed in that fixture's `Action`
enum when this was written, so the worked example below only needed steps 4-5; a genuinely new
variant needs steps 1-3 first, in order.

## 1. Define the variant (Rust)

In `packages/engine/fixtures/<game>/src/lib.rs`, add a variant to the game's `Action` enum:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub enum Action {
    // ...existing variants...
    YourNewAction { field: u32 },
}
```

Add fields only with types that are themselves `Codec` + `TS` (plain data: `u8`/`u16`/`u32`/`i32`,
or a struct like this fixture's own `Pos { x: i32, y: i32 }` that also derives `TS` with its own
`#[ts(export)]` -- ts-rs writes a file only for a type that opts in, even one only ever referenced
from inside another type). No `#[ts(export)]` on the *fields* -- it goes once on the enum itself,
already there from the first action this fixture ever added.

If this action can be rejected for a reason the game itself defines (not the engine's own
`EngineReject`), add or reuse a variant on the game's `Reject` enum the same way -- it carries the
same two derive lines and lives beside `Action` in the same file.

## 2. Handle it (Rust)

**What it does**, in `impl Game for <Game>`'s `apply` match (`fn apply(w: &mut dyn WorldWrite<Self>,
who: PlayerId, a: &Action) -> Result<(), Reject>`): add the match arm. Remember 0003's two rules --
validate first, write after (a rejecting `apply` must record no writes: `Sim::step` asserts this
at runtime and panics if it is violated); and every `WorldWrite` **put is infallible** (`set_tile`,
`put_global`, `spawn`, ... never return `Result`) -- so a "pure put" action (this fixture's own
`Paint`/`SetMotd`) can *never* reject inside `apply`. If you need it to be rejectable, it either
reads something first (`w.entity_at(...)?`, propagating `Unknown` via the fixture's own `impl
From<Unknown> for Reject`, this fixture's own `Bump`/`Remove` shape) or it needs the next step.

**Whether it can be rejected before `apply` even runs** (0004 Pipeline step 2, "Admit"): a plain
put action's *only* path to a `Reject::Game(...)` outcome is `Game::admit`, since `apply` itself
can never fail for one. Add or extend the override:

```rust
fn admit(
    _w: &dyn WorldRead<Self>,
    _p: &PresenceTable<Self>,
    _who: PlayerId,
    a: &Action,
) -> Result<(), Reject> {
    if let Action::YourNewAction { field } = a {
        if /* whatever makes this one invalid */ {
            return Err(Reject::YourReason);
        }
    }
    Ok(())
}
```

The default `Game::admit` is `Ok` for every action; extend the existing `if let` chain if the game
already overrides it (match on `a` once, not once per action). An admission-time reject is **never
logged** (0004: "Admission-time reject... not logged") and never touches `sim_hash()` -- it is safe
to add without disturbing any existing golden, *provided* no existing golden's own script actually
drives a case that would now reject differently than before (check `fixtures/<game>/golden/
scenario*.json` for this variant before assuming that).

Skip this step entirely if the action needs no rejection at all (many don't).

## 3. Regenerate the TypeScript binding

```
node packages/engine/scripts/build-fixtures.mjs
pnpm format
```

(Any suite that runs the fixtures build step works too -- `pnpm test unit`, `pnpm test wasm`,
`pnpm test browser` all rebuild every fixture first.) This writes `fixtures/<game>/bindings/
Action.ts` (and `Reject.ts` if you touched it) with your new variant.

**Never regenerate with a bare `cargo test`.** The root `.cargo/config.toml` points
`TS_RS_EXPORT_DIR` at a gitignored scratch directory specifically so a plain `cargo test`/`cargo
nextest run` cannot dirty the committed `bindings/` -- only `buildGame()`/the Vite plugin (what the
commands above actually invoke) sets `TS_RS_EXPORT_DIR`/`TS_RS_IMPORT_EXTENSION` to the real
directory in the child process. `pnpm format` afterward matches ts-rs's own raw quote/semicolon
style to this repo's committed biome formatting (`golden.mjs` does the same reformat-in-place for
the goldens it writes, for the same reason).

Check the diff: `git diff fixtures/<game>/bindings/`. Your new variant (and any new struct type it
referenced) should be the only change.

## 4. Dispatch it from a page

```ts
import type { Action } from '../../../../fixtures/<game>/bindings/Action.ts'
// import type { Reject } from '../../../../fixtures/<game>/bindings/Reject.ts' -- only if you
// want onActionResult's reject reason fully typed too.

window.__dispatchYourNewAction = (field: number) => {
  const action: Action = { YourNewAction: { field } }
  return client.dispatch(action) // returns the action's `seq: number`
}
```

A fieldless variant (`Roll`, say) serialises as a bare string, not an object: `const action: Action
= 'YourNewAction'`. The regenerated `bindings/Action.ts` shows which shape each variant takes.

`client.dispatch(action: unknown): number` JSON-encodes `action` and returns its `seq` immediately
(0003 "Actions across the boundary"); it throws `Error("engine: dispatch before ready")` if called
before the session is live, and `Error("engine: action queue full")` if the outbox/ring is full.
Neither is specific to a new action -- every dispatch call already has to handle them.

To observe the outcome:

```ts
client.onActionResult<Reject>((seq, result) => {
  // result: 'Confirmed' | { Rejected: { Game: Reject } } | { Rejected: { Engine: EngineRejectReason } }
})
```

The `Game`/`Engine` tag is never flattened (0004's `Rejected<G> { Game(G::Reject), Engine
(EngineReject) }` is exactly two variants) -- match on `result === 'Confirmed'` first, then on
`result.Rejected.Game` vs `result.Rejected.Engine`.

## 5. Prove it type-checks and runs

```
cargo nextest run -p fx-<game>
pnpm --filter engine typecheck
```

The first runs the game's Rust tests, its golden checks included; run it before regenerating
bindings so a compile error surfaces in Rust, not as a missing binding.

(`pnpm lint` runs this too.) This is what actually catches a mismatch between your dispatch call
and the regenerated `Action` union -- a wrong field name or type fails here, at build time, not at
runtime inside a browser.

## 6. Surface the outcome in `Ui` (optional)

If a page needs to *show* the effect of this action -- a counter, a message, a progress bar --
rather than only react once to its own `onActionResult`, mirror the changed state into `G::Ui`
(docs/plan/16b-ui-observation-and-clock.md; `fixtures/puts`'s own `PutsUi`/`PutsClient::ui` is the
worked example: `SetMotd`/`Puts::tick`'s `Global.day` bump both surface through `motd`/
`global_ticks`, and `SetNote` surfaces through `note`/`note_until`). Skip this step for an action
whose only observer is the player who dispatched it and who only needs a one-shot confirm/reject
(`onActionResult` alone is enough for that).

In `PutsClient::ui(&self, view: &FrameView<'_, Puts>, out: &mut PutsUi)`, read whatever replicated
state this action wrote (through `view.world()`, a `WorldRead` -- `global()`, or `player(view.me())`
for the caller's own player-scoped state) and write it into `out`'s matching field:

```rust
fn ui(&self, view: &FrameView<'_, Puts>, out: &mut PutsUi) {
    let g = view.world().global();
    out.motd = g.motd; // whatever field this action's own apply/tick rule wrote
}
```

The engine calls this every frame the replica changed, but only actually writes a UI-ring record
when the value differs from the last one it emitted (`PartialEq`, `UiObserver`'s own policy) -- a
plain `WorldRead` in wins, no extra bookkeeping on the game's part. A page observes it with
`client.onUi<PutsUi>((ui) => { ... })`, coalesced to the newest value per drain (never one call per
action, unlike `onActionResult`) and always delivered before that same drain's own
`onActionResult` calls.

`type Ui = PutsUi` and `PutsClient` already exist once any action in the fixture surfaces through
`Ui` -- a later action just adds its own field and reads it here, the same as adding a match arm to
`apply`.

## 7. If an existing golden exercises this action

Only if a committed `fixtures/<game>/golden/scenario*.json` (a `"script"`-kind scenario) already
dispatches this exact action, or a native scenario test drives it directly: re-run `pnpm golden
<game>` and **review the diff** before committing -- `pnpm golden` is the only writer of a golden
hash, and a changed golden is a changed sim (`packages/engine/CLAUDE.md`). A brand-new variant
nothing existing scripts yet needs no golden re-bless.

**New state is different.** A variant that adds a field to a replicated type (`Global`, a player
or entity struct) changes the encoded state, so *every* golden hash moves, even `*_idle_*`
scenarios that never dispatch it (`cargo nextest run -p fx-<game>` fails the golden checks at
once). That is a changed sim: re-bless with `pnpm golden <game>` only as a deliberate, reviewed
decision, never to make the new variant pass.

## What you do not need to touch

The wire format, the action ring, `on_action`, the outbox, `poll_uplink`, `Host::on_uplink`'s
decode/dedup, `build_frame`'s `ActionResults` section, and the UI ring's result records are all
generic over `G::Action`/`G::Reject` already -- a new variant flows through every one of them
without any change outside the game crate and the page that dispatches it.
