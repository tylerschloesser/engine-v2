// The capability screen (M35, docs/plan/35-packaging-and-adapters.md): what a player sees instead of a
// blank canvas when `checkSupport()` says this browser cannot run the game. The game branches on the
// failure `code` (the engine's `message` is developer English and is never shown); the wording here
// is the game's own. Framework-free, like the rest of `src/ui/`.
import type { SupportFailure } from 'engine'
import { el } from './dom.js'

/** Player-facing line per `SupportFailure['code']`. An unknown code (a newer engine) falls back to the
 * generic line, so the screen never renders empty. */
const TEXT: Record<string, string> = {
  'not-isolated':
    'This page was not served in a secure, isolated context. Reload it from its own address.',
  'no-sab': 'This browser does not support shared memory, which the game needs.',
  'no-wasm': 'This browser does not support WebAssembly.',
  'no-module-worker': 'This browser does not support module web workers.',
  'no-webgpu': 'This browser does not support WebGPU. Try a current Chrome, Edge or Safari.',
  'no-adapter': 'No compatible graphics adapter was found for WebGPU on this device.',
  'limits-too-low': 'This device’s graphics hardware is below what the game needs.',
}
const GENERIC = 'This browser cannot run the game.'

/** Replaces `root`'s children with the screen: a heading and one line per failure, `data-code` on
 * each (the hook tests and games key on). Returns the list element. */
export function showCapabilityScreen(root: HTMLElement, failures: SupportFailure[]): HTMLElement {
  const screen = el('div', 'capability-screen')
  screen.setAttribute('role', 'alert')
  screen.style.cssText =
    'position:fixed;inset:0;display:grid;place-content:center;padding:24px;font:16px system-ui;text-align:center;background:#111;color:#eee'
  const heading = el('h1')
  heading.textContent = 'This browser cannot run the game'
  const list = el('ul', 'capability-failures')
  list.style.cssText = 'list-style:none;padding:0'
  for (const failure of failures) {
    const item = el('li')
    item.dataset.code = failure.code
    item.textContent = TEXT[failure.code] ?? GENERIC
    list.append(item)
  }
  screen.append(heading, list)
  root.replaceChildren(screen)
  return list
}
