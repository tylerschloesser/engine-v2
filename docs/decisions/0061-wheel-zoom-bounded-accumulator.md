# 0061: wheel zoom is bounded, and the wheel works over the game's overlay

Status: Accepted (2026-10-10). Amends [0019](0019-camera-input-and-overlay.md) §3 (the wheel
constants and the listener's target; the per-pixel form stands). Implemented by M39aj.

## Context

On 2026-10-10 Tyler reported that the deployed game "zooms in super close instantly and then is
stuck". A diagnosis found three causes. Two touch 0019 §3. First, `recordWheel` added
`deltaY x 0.002 x mode x (ctrl ? 10 : 1)` to an unbounded accumulator eased in at tau = 22 ms, while
the whole 12-256 range is only ln 21.3 = 3.06: 20 ctrl+wheel events of `deltaY` 4 took the zoom from
14.7 to 72.6 tiles (x5), and a real flick or pinch sums far more. Second, the wheel listener sat on
the canvas only, so any `pointer-events: auto` overlay element (collect, craft, build buttons)
swallowed the event and the wheel did nothing over it. (The third cause, a default of 12 tiles equal
to the zoom-in limit, is a default, not a decision: the fresh camera now opens at 32.)

## Decision

**1. The outstanding accumulator saturates at ln 2.** `|pendingDeltaLog| <= ln 2`
(`WHEEL_MAX_PENDING_LOG`, `input/wheel.ts`): at most one doubling or halving is ever queued, so one
gesture cannot cross more than the clamped range's worth in a burst, and the easing then drains it
at the same tau. The per-pixel constant `k = 0.002`, the line (x25) and page (x500) multipliers and
the ctrl multiplier (x10) are unchanged: with the cap, a 20-event `deltaY` 4 ctrl stream changes the
zoom by at most x2. No per-frame rate cap: the cap bounds the queue, and the queue is what the easing
spends.

**2. Wheel events anywhere over the game's surface zoom about the cursor.** The listener moves from
the canvas to the overlay root (`ClientOptions.overlay.root`, default the canvas's parent), where
events from the canvas and from every anchored element bubble. The cursor position is
`clientX/clientY` minus a canvas rect cached on resize, scroll and window resize (no
`getBoundingClientRect` per event). `preventDefault` is called as before (non-passive).

**3. A scrollable panel opts out.** An element marked `data-wheel-own` (or inside one) keeps its own
scroll: the listener returns before `preventDefault` and records nothing.

## Alternatives rejected

- **A per-frame rate cap only.** It does not bound the queue, so a burst still drains as a long run
  of capped frames and the zoom keeps going after the fingers stop.
- **`pointer-events: none` on overlay elements.** It breaks their clicks.
- **A `window`-level listener.** Passive by default in Chrome (0019 §3), and it would zoom over any
  page content, not the game.

## Consequences

- A hard flick zooms by at most one doubling per burst; reaching a limit from mid-range takes
  several gestures. Tyler may want `ln 2` tuned after a device round.
- A game that puts a scrollable panel in the overlay root marks it `data-wheel-own`
  (`games/reference`'s link log does).

## Sources

- M39aj diagnosis, 2026-10-10; 0019 §3.
