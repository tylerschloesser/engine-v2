# Questions for Tyler

One batch, asked once at the end of Phase 2 (2026-09-19). Planning proceeds on the **default** until answered; `PLAN.md` marks dependent milestones with **T**. When an answer arrives: record it in the spec Requirements if it changes them, fill the Answer column, and edit any brief the answer changes. Later phases append rows here rather than asking one at a time.

Detail for Q1–Q6 is in `PRE-PLAN.md` §11 (item numbers in brackets). Detail for R1–R4 is in `docs/plan/reference-coverage.md`.

## Scope, cost, and Requirement wording

| # | Question | Default assumed | Depends on it | Answer |
|---|---|---|---|---|
| Q1 | [1] Approve `serde_json` in the engine crate (UI action JSON + one-time config inside WASM), `ts-rs` as a normal dependency that LTO removes, and `libm` pinned only if a transcendental is ever needed? | Approved | M02, M16, M16b; M35's size test watches `ts-rs` | |
| Q2 | [2] Amend the zero-GC Requirement in `docs/spec/testing.md`: net worker budgeted at ≤ 1 KB per message with zero major GCs instead of "approximately zero"; main-thread figure replaced by the measured floor? | Amend as proposed; ADR 0016 is the operative reading meanwhile | wording only (M04, M29 build to 0016 either way) | |
| Q3 | [4] Amend the deltas/prediction Requirement wording in `docs/spec/sync.md` and `docs/spec/overview.md` to the text proposed in `PRE-PLAN.md` §11 item 4 (engine derives deltas and prediction; the game defines data, rules, presence, opt-outs)? | Amend as proposed; ADRs 0003, 0011, 0012 are the operative reading meanwhile | wording only (M12, M25) | |
| Q5 | [6] Is there a mid-range 4 GB Android phone for the manual checks, or is Android checked on desktop Chrome only? (An iPhone 12-class or newer on iOS 26+ is assumed.) | iPhone + desktop Chrome only | `docs/plan/device-checks.md`, M39 | |
| Q6 | [7] Spend: Cloudflare Workers paid plan ($5/month) for the Durable Objects check; a free Cloudflare Pages deploy for the COOP/COEP check; a Fly machine to verify the hosting cost target rather than compute it? | All three approved, used only in M38. If declined: M38 still produces the local DO run, the `fly.toml`/Dockerfile and both recipes, and skips the deployed measurements | M38 | |
| Q7 | Reaching dev pages from the phone needs a secure context (`crossOriginIsolated`), so a LAN `http://` URL cannot work. OK to use a Cloudflare quick tunnel (`cloudflared` install, a temporary public URL while a check runs)? Alternative: `mkcert` local CA installed on the phone. | cloudflared quick tunnel; mkcert as fallback | M03 and every **D** milestone | |
| Q8 | CI trigger policy and Actions minutes: run on every push and pull request, both tiers, superseded runs cancelled? | Yes | M10 | |

## Reference game (taste and scope)

| # | Question | Default assumed | Depends on it | Answer |
|---|---|---|---|---|
| Q4 | [5] Collect range: 3 tiles, centre of player to centre of tile? | 3 tiles | M20, M20b | |
| R1 | May a furnace be placed over a resource tile? | No | M33 | |
| R2 | `FurnaceTake` is the one action that opts out of prediction (so `predict()` is exercised). OK? | Yes | M33b | |
| R3 | Add a small "pick up an empty furnace" action? Nothing in the reference game removes an entity, so `despawn`, `EntityGone` and prediction tombstones are otherwise covered by fixture tests only. It would be an addition to the Requirements in `docs/spec/reference-game.md`. | Not added (fixture-only coverage). Recommended: add it | M33b if added | |
| R4 | Offer "Export world" always, or only on the status screen shown for a save that cannot be loaded? | Status screen only | M34b | |
| Q9 | A save that cannot be loaded (`SaveIncompatible`): the engine leaves the files untouched, `client.ready` rejects, and `exportWorld` / `deleteWorld` still work; the reference game shows both buttons. OK? | Yes | M23, M24b | |
| Q10 | Own-timer progress bars under latency: stretch the bar over `duration + lead` so it ends when the result arrives, or fill on time and wait? | Stretch; M26 measures the gap and M34's device check is the feel test | M26 | |
| Q11 | Code style: 2-space indent, single quotes, semicolons as needed, line width 100 (Biome); rustfmt defaults? | Yes | M01 | |

## Resolved without asking

- [3] The Xcode license: native linking works on this machine without `DEVELOPER_DIR` (checked 2026-09-19 with `cc`), so native `cargo test` and the `ts-rs` step will link.

## Heads-up, no action yet

- [8] The 128-chunk subscription cap at maximum zoom-out (`PRE-PLAN.md` risk 3) is measured in M31. If the churn trigger fires, the recommended change is raising the cap to 144, which changes a number in `docs/spec/client.md` and will come back as a question.
- M39 needs Tyler's full device re-run on the final build and a play-test sign-off.
