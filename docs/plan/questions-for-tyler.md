# Questions for Tyler

One batch, asked once at the end of Phase 2 (2026-09-19). Rows with an empty Answer were not put to Tyler interactively (low stakes; the default stands until he says otherwise). Work proceeds on the **default** until answered; `PLAN.md` marks dependent milestones with **T**. When an answer arrives: record it in the spec Requirements if it changes them, fill the Answer column, and edit any brief the answer changes. Later phases append rows here rather than asking one at a time.

Detail for Q1–Q6 is in `PRE-PLAN.md` §11 (item numbers in brackets). Detail for R1–R4 is in `docs/plan/reference-coverage.md`.

## Scope, cost, and Requirement wording

| # | Question | Default assumed | Depends on it | Answer |
|---|---|---|---|---|
| Q1 | [1] Approve `serde_json` in the engine crate (UI action JSON + one-time config inside WASM), `ts-rs` as a normal dependency that LTO removes, and `libm` pinned only if a transcendental is ever needed? | Approved | M02, M16, M16b; M35's size test watches `ts-rs` | **Approved** (2026-09-19); recorded in `docs/spec/runtime-and-packaging.md` |
| Q2 | [2] Amend the zero-GC Requirement in `docs/spec/testing.md`: net worker budgeted at ≤ 1 KB per message with zero major GCs instead of "approximately zero"; main-thread figure replaced by the measured floor? | Amend as proposed; ADR 0016 is the operative reading meanwhile | wording only (M04, M29 build to 0016 either way) | **Amended** (2026-09-19) in `docs/spec/testing.md` |
| Q3 | [4] Amend the deltas/prediction Requirement wording in `docs/spec/sync.md` and `docs/spec/overview.md` to the text proposed in `PRE-PLAN.md` §11 item 4 (engine derives deltas and prediction; the game defines data, rules, presence, opt-outs)? | Amend as proposed; ADRs 0003, 0011, 0012 are the operative reading meanwhile | wording only (M12, M25) | **Amended** (2026-09-19) in `docs/spec/sync.md` and `docs/spec/overview.md` |
| Q5 | [6] Is there a mid-range 4 GB Android phone for the manual checks, or is Android checked on desktop Chrome only? (An iPhone 12-class or newer on iOS 26+ is assumed.) | iPhone + desktop Chrome only | `docs/plan/device-checks.md`, M39 | **iPhone only** (2026-09-19); Android rows in the checklist are marked "not run: no device" |
| Q6 | [7] Spend: Cloudflare Workers paid plan ($5/month) for the Durable Objects check; a free Cloudflare Pages deploy for the COOP/COEP check; a Fly machine to verify the hosting cost target rather than compute it? | All three approved, used only in M38. If declined: M38 still produces the local DO run, the `fly.toml`/Dockerfile and both recipes, and skips the deployed measurements | M38 | **Cloudflare Workers plan and Fly machine approved; the Pages deploy was not** (2026-09-19). M38 serves the client from the Fly machine for its phone check; the static-host COOP/COEP verification stays unverified and is carried to `39b` as an open item |
| Q7 | Reaching dev pages from the phone needs a secure context (`crossOriginIsolated`), so a LAN `http://` URL cannot work. OK to use a Cloudflare quick tunnel (`cloudflared` install, a temporary public URL while a check runs)? Alternative: `mkcert` local CA installed on the phone. | cloudflared quick tunnel; mkcert as fallback | M03 and every **D** milestone | **Tunnel OK** (2026-09-19) |
| Q8 | CI trigger policy and Actions minutes: run on every push to `main` (only `M<NN> done` commits are pushed, ADR 0025 §4) and every pull request, both tiers, superseded runs cancelled? | Yes | M10 | **Built on the default (M10, 2026-09-21) and now live** — `.github/workflows/ci.yml`. Still yours to confirm or change; nothing depends on the answer any more, it is a cost question. A full two-tier cold run is **~5.5 min** of Actions time (6 runs during M10's own bring-up). Say the word and the trigger set or the tiers change in one edit. |
| Q12 | `docs/spec/client.md` names the current **and previous** major version of each Tier 1 browser. Nothing can pin or automate a previous major (Playwright ships one build per engine; phones run what they run). OK to meet it by policy: `checkSupport` feature-detects, tests run on current engine versions only, and a report from an older version is handled as a bug? | Yes; recorded in M35's build-profile ADR, listed again in M39's audit | M35, M39 | |
| Q13 | Should `client.ts`'s `now()` allocation get a small milestone of its own, in the shape M13b took for the sim worker's equivalent cost? Evidence: `gc-sim-paced`'s `main` budget of 30 doesn't cover `now()` interpreted (~11.96 B/frame, raw `main` to ~33.5), failing 1 run in 6 locally under `--load 10`; pre-existing (same rate on M15's base commit `ebea2a3` as on M15's head, so not M15's); the same defect class M13b already fixed once on the sim worker; the only alternative is widening the `main` budget, which ADR 0029 forbids (a budget that stops a control tripping the exact failure mode it exists to avoid). See `docs/plan/deferred-ledger.md`, "Added during Phase 3". | **Yes, as a small milestone scheduled after M15b and before M16** | nothing currently blocks on it | | **Proceeding on the default as of M15b's gate: written as `docs/plan/15d-client-clock-allocation.md` and scheduled before M15c, because the failure reached 7 runs in 15 with no injected load once M15b grew the browser suite to 103 tests. Tyler can still redirect it; nothing is irreversible.** **RESOLVED by action, M15d done.** Built on the recommended default and landed; the browser suite went from 7 failures in 15 runs to 15/15, and no budget was raised (one was lowered, 14 -> 9). No answer needed unless you disagree with having spent a milestone on it.

## Reference game (taste and scope)

| # | Question | Default assumed | Depends on it | Answer |
|---|---|---|---|---|
| Q4 | [5] Collect range: 3 tiles, centre of player to centre of tile? | 3 tiles | M20, M20b | **3 tiles** (2026-09-19); recorded in `docs/spec/reference-game.md` |
| R1 | May a furnace be placed over a resource tile? | No | M33 | |
| R2 | `FurnaceTake` is the one action that opts out of prediction (so `predict()` is exercised). OK? | Yes | M33b | |
| R3 | Add a small "pick up an empty furnace" action? Nothing in the reference game removes an entity, so `despawn`, `EntityGone` and prediction tombstones are otherwise covered by fixture tests only. It would be an addition to the Requirements in `docs/spec/reference-game.md`. | Not added (fixture-only coverage). Recommended: add it | M33b if added | **Add it** (2026-09-19); recorded in `docs/spec/reference-game.md`; built in M33b |
| R4 | Offer "Export world" always, or only on the status screen shown for a save that cannot be loaded? | Status screen only | M34b | |
| Q9 | A save that cannot be loaded (`SaveIncompatible`): the engine leaves the files untouched, `client.ready` rejects, and `exportWorld` / `deleteWorld` still work; the reference game shows both buttons. OK? | Yes | M23, M24b | |
| Q10 | Own-timer progress bars under latency: stretch the bar over `duration + lead` so it ends when the result arrives, or fill on time and wait? | Stretch; M26 measures the gap and M34's device check is the feel test | M26 | **Stretch** (2026-09-19) |
| Q11 | Code style: 2-space indent, single quotes, semicolons as needed, line width 100 (Biome); rustfmt defaults? | Yes | M01 | **Yes** (2026-09-19) |

## Criteria awaiting Tyler

Exit criteria that only Tyler can verify and that no command could stand in for (`PROMPT.md` loop step 5). They do not block the next milestone; the box in the brief stays unticked until Tyler confirms. One line each: milestone, the criterion, how to check it.

(none)

## Resolved without asking

- [3] The Xcode license: native linking works on this machine without `DEVELOPER_DIR` (checked 2026-09-19 with `cc`), so native `cargo test` and the `ts-rs` step will link.

## Heads-up, no action yet

- [8] The 128-chunk subscription cap at maximum zoom-out (`PRE-PLAN.md` risk 3) is measured in M31. If the churn trigger fires, the recommended change is raising the cap to 144, which changes a number in `docs/spec/client.md` and will come back as a question.
- M39 needs Tyler's full device re-run on the final build and a play-test sign-off.
