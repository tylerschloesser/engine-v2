// The page-CSS helper (docs/decisions/0019-camera-input-and-overlay.md §3: "The engine documents
// and offers a helper for the page CSS that prevents pull-to-refresh structurally: a `position:
// fixed; inset: 0; overflow: hidden` root, `overscroll-behavior: none` on `html, body`, `height:
// 100dvh`, `viewport-fit=cover`."); docs/plan/11-camera-and-input.md Scope: "the helper for 0019
// §3's page CSS (`installPageStyles()`), opt-in". One-time setup, called once by a page (`device.ts`
// step 8): not a hot path, so a `<style>` element and a fresh `Uint8Array`-free string are fine here
// (`.claude/rules/hot-paths.md` exempts one-time setup).
//
// Canvas `touch-action: none; user-select: none; -webkit-touch-callout: none` (0019 §3's other half
// of "Browser gestures") is folded in here too: it is page CSS in the same sense (a stylesheet rule,
// not a per-event listener), and every page that calls this helper also has exactly one camera
// canvas to which it applies.
const STYLE_ID = 'engine-page-styles'

export function installPageStyles(doc: Document = document): () => void {
  if (doc.getElementById(STYLE_ID)) return () => {} // already installed (idempotent)
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    'html, body {',
    '  position: fixed;',
    '  inset: 0;',
    '  overflow: hidden;',
    '  overscroll-behavior: none;',
    '  height: 100dvh;',
    '  margin: 0;',
    '}',
    'canvas {',
    '  touch-action: none;',
    '  user-select: none;',
    '  -webkit-touch-callout: none;',
    '}',
  ].join('\n')
  doc.head.appendChild(style)

  let meta = doc.querySelector('meta[name="viewport"]') as HTMLMetaElement | null
  if (!meta) {
    meta = doc.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'viewport-fit=cover'
    doc.head.appendChild(meta)
  } else if (!meta.content.includes('viewport-fit')) {
    meta.content =
      meta.content.length > 0 ? `${meta.content}, viewport-fit=cover` : 'viewport-fit=cover'
  }

  return () => {
    style.remove()
  }
}
