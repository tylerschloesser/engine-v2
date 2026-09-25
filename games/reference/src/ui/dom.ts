// `src/ui/dom.ts` (docs/plan/20b-reference-player-and-collect-ui.md Seams, Provides): the two
// framework-free DOM helpers every UI module in this package builds on -- `el()` and a keyed-list
// diff helper -- reused as-is by M32-M34's own crafting/roster UI (Provides).
//
// Framework-free by Requirement (`docs/spec/reference-game.md` UI: "Framework-free TypeScript. The
// engine must not care either way."): no virtual DOM, no reconciler beyond the one small keyed diff
// below.

/** A small typed wrapper over `document.createElement` plus an optional class name -- the one DOM
 * constructor every UI module here uses instead of scattering `document.createElement` calls. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className !== undefined) e.className = className
  return e
}

/** `diffKeyed`'s own handlers: `create` builds a brand-new `E` for an item that was not in `live`
 * last call; `update`, if given, is called for *every* item, new or carried over, so it is the one
 * place that writes an item's current state onto its element (optional: a caller whose own
 * per-item state needs a separate, later pass over `live` -- e.g. this milestone's own collect
 * buttons, which fold `Ui.collecting`/disabling across every button at once -- can omit it and do
 * that pass itself). `remove`, if given, runs once for every element `diffKeyed` is about to drop
 * from `live` (the caller's own teardown -- detaching from a parent, an engine `AnchorHandle.
 * remove()`, cancelling a running animation, ...). */
export type KeyedDiffHandlers<T, E> = {
  create(item: T): E
  update?(existing: E, item: T): void
  remove?(existing: E): void
}

/** Reconciles `live` (a caller-owned `key -> element` map, persisted across calls -- this is the
 * only state the helper needs) against `items`'s current members, keyed by `key(item)`: an unseen
 * key gets `create` then `update`; a key seen before only gets `update` (so a carried-over element
 * is never rebuilt); a key no longer present is `remove`d and dropped from `live`. `E` is
 * deliberately not constrained to `HTMLElement` -- the same shape reconciles anchor handles,
 * timers or any other per-key resource a later UI module needs, not only visible DOM nodes
 * (Provides: "reused by M32-M34"). */
export function diffKeyed<T, E>(
  live: Map<string, E>,
  items: readonly T[],
  key: (item: T) => string,
  handlers: KeyedDiffHandlers<T, E>,
): void {
  const seen = new Set<string>()
  for (const item of items) {
    const k = key(item)
    seen.add(k)
    let existing = live.get(k)
    if (existing === undefined) {
      existing = handlers.create(item)
      live.set(k, existing)
    }
    handlers.update?.(existing, item)
  }
  for (const [k, existing] of live) {
    if (seen.has(k)) continue
    handlers.remove?.(existing)
    live.delete(k)
  }
}
