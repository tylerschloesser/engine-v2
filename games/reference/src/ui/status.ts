// Link status (docs/plan/34-reference-multiplayer.md Scope): a small line fed by `client.onLink`.
// Nothing while the session is online; a short message when the link is down or was refused. No
// modal, no retry button (the engine redials by itself, 0013 Client policy). Framework-free.
import type { LinkReason, LinkState } from 'engine'

/** 0013 Client policy: an indicator appears after 1 s. `reconnecting` is already emitted after that
 * delay by the engine; the first `connecting` is delayed here. */
export const INDICATOR_DELAY_MS = 1000

const REJECTED: Record<LinkReason, string> = {
  BadKey: 'This invite link is not valid for the server.',
  Full: 'This world is full.',
  WorldMismatch: 'The server runs a different world.',
}

export function statusText(state: LinkState, reason?: LinkReason): string | null {
  switch (state) {
    case 'online':
      return null
    case 'connecting':
      return 'Connecting...'
    case 'reconnecting':
      return 'Connection lost, reconnecting...'
    case 'updating':
      return 'Updating...'
    case 'superseded':
      return 'This world is open in another tab.'
    case 'rejected':
      return reason ? REJECTED[reason] : 'The server refused the connection.'
  }
}

export type StatusUi = {
  onLink(e: { state: LinkState; reason?: LinkReason }): void
}

export function createStatusUi(container: HTMLElement, doc: Document = document): StatusUi {
  const line = doc.createElement('div')
  line.className = 'link-status'
  line.hidden = true
  line.style.cssText =
    'position:fixed;left:8px;bottom:8px;padding:4px 8px;border-radius:4px;font:12px sans-serif;' +
    'background:rgba(0,0,0,0.6);color:#fff;pointer-events:none'
  container.append(line)
  let timer: ReturnType<typeof setTimeout> | undefined

  function show(text: string | null, state: LinkState): void {
    line.hidden = text === null
    line.textContent = text ?? ''
    line.dataset.state = state
  }

  return {
    onLink(e) {
      clearTimeout(timer)
      const text = statusText(e.state, e.reason)
      if (e.state === 'connecting') {
        show(null, e.state)
        timer = setTimeout(() => show(text, e.state), INDICATOR_DELAY_MS)
      } else {
        show(text, e.state)
      }
    },
  }
}
