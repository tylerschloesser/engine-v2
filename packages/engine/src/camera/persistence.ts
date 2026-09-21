// `localStorage` save/restore (docs/decisions/0019-camera-input-and-overlay.md §1: "The camera is
// saved to `localStorage` when motion ends and on `visibilitychange`, and restored at start.";
// docs/plan/11-camera-and-input.md Scope: "localStorage save/restore under `engine.camera.
// <ClientOptions.cameraKey ?? 'default'>`"; Planning decisions "Persistence key": "`engine:camera:
// v1:<'local' | remote URL>`; world identity (M23) can refine the suffix later without migration").
//
// This range reconciles the two: the brief's Scope names the exact suffix rule (`cameraKey ??
// 'default'`, which is exactly "world identity... refining the suffix" a game's world id already
// gives, per Scope's own parenthetical "a game passes its world id, so each world keeps its own
// camera"), while Planning decisions names the versioned, colon-separated prefix. `cameraStorageKey`
// below is `engine:camera:v1:<cameraKey ?? 'default'>` -- Planning decisions' own prefix/versioning,
// Scope's own suffix rule. Recorded here since the brief's own text disagreed on the separator/
// version and neither an accepted ADR nor a Seams line pins one over the other (Deviations).
//
// Not a hot path (`camera.ts`'s own `onMotionEnd` fires at most once per "motion ends" transition,
// never per frame; `restoreCameraState` runs once at `createClient` time): `JSON.stringify`/`parse`
// and a `try/catch` (Safari private-mode `setItem` throws) are fine here (`.claude/rules/
// hot-paths.md` exempts one-time setup and rare discontinuities).
import type { CameraState } from './state.js'

export type PersistedCamera = { centreX: number; centreY: number; tilesAcross: number }

export function cameraStorageKey(cameraKey?: string): string {
  return `engine:camera:v1:${cameraKey ?? 'default'}`
}

/** Best-effort: a full `localStorage` quota, Safari private-mode `setItem`, or `localStorage` being
 * entirely absent (SSR-shaped test harnesses) must never throw out of the camera's own rAF path. */
export function saveCameraState(key: string, state: CameraState): void {
  try {
    const payload: PersistedCamera = {
      centreX: state.centreX,
      centreY: state.centreY,
      tilesAcross: state.tilesAcross,
    }
    localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Best-effort only (see doc comment above): a missing key next launch just means the default
    // camera (Planning decisions), never a crash.
  }
}

/** Returns whether a valid camera was actually restored (`client.camera.restored`, Seams): `false`
 * on a fresh key, a malformed value, or when `localStorage` throws/is absent -- `state` is left
 * untouched in every `false` case. */
export function restoreCameraState(key: string, state: CameraState): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return false
    const parsed = JSON.parse(raw) as Partial<PersistedCamera>
    if (
      typeof parsed.centreX !== 'number' ||
      typeof parsed.centreY !== 'number' ||
      typeof parsed.tilesAcross !== 'number' ||
      !Number.isFinite(parsed.centreX) ||
      !Number.isFinite(parsed.centreY) ||
      !Number.isFinite(parsed.tilesAcross)
    ) {
      return false
    }
    state.centreX = parsed.centreX
    state.centreY = parsed.centreY
    state.tilesAcross = parsed.tilesAcross
    return true
  } catch {
    return false
  }
}
