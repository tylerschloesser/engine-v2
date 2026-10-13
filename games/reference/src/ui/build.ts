// `createBuildUi` (M33 Scope; M51b the belt tools): the tool palette, construction mode, and the
// two placement flows.
//
// The palette is one fixed row (`.build-palette`, bottom centre): the Build button (the furnace
// tool, shown while the player holds a furnace item or is placing one), then the belt, spawner,
// despawner and (M54) splitter tools (free, always shown), then Rotate (shown while a belt tool is
// on; the splitter tool's direction cycles all four, its footprint 1 x 2 facing east or west and 2 x 1
// facing north or south, anchored at the tapped tile). A tool button
// turns its tool on, or off when it is already on; Escape ends construction mode; Rotate or the
// `R` key (a belt tool on) emits `LOCAL.ROTATE_TOOL`. The direction and the tool are `Ui.tool`
// (`RefClient` keeps them), so a placed belt faces the way the ghost does.
//
// Construction mode is client-local: `client.input.emit(LOCAL.PLACE_MODE, tool)` tells `RefClient`
// (which then emits the ghost); nothing is logged and `client.input.setMode` is not used, so drags
// keep panning (0019 section 4). Mouse: a `tap` while placing dispatches `PlaceFurnace` (or
// `PlaceBelt { at, dir, kind }`) at the tapped tile. Touch: a `tap` moves the engine's cursor tile
// (the ghost follows it) and shows a Confirm button anchored just below the ghost (the 2x2
// furnace's, the 1x1 belt's or the 2x1 splitter's bottom edge); Confirm dispatches. Mouse or touch is the tap's
// `pointerType`. A rejection flashes the control that sent the action with the reason as a CSS
// class (`reject-<reason>`), like a collect button.
//
// A refused placement also leaves its reason on the page until the player tries again or leaves
// construction mode: `.build-reason` (`data-reason`), for the engine's refusals (`StateBudgetFull`: the
// world cannot take another building) and the placement rule's own.
//
// DOM identity: `.build-palette`; `.build-button` (`data-build`, the furnace tool);
// `.tool-button` (`data-tool="belt|spawner|despawner|splitter"`, `.is-on` while active); `.build-rotate`
// (`data-build-rotate`, `data-dir` = the page's copy of the direction, see `dir` below); `.build-confirm` (`data-build-confirm="x,y"`);
// `.build-reason`.
import type { ActionOutcome, Client } from 'engine'
import type { BeltKind } from '../bindings/BeltKind.js'
import type { Dir } from '../bindings/Dir.js'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { el } from './dom.js'

/** `content::local` (`sim/src/content.rs`): change both together. */
export const LOCAL = {
  PLACE_MODE: 1,
  CLOSE_PANEL: 2,
  // M51: turns the construction direction clockwise; `PLACE_MODE`'s `a` is one of `TOOL`.
  ROTATE_TOOL: 3,
} as const
/** `PLACE_MODE`'s `a` values (`content::local::TOOL_*`). */
export const TOOL = { OFF: 0, FURNACE: 1, BELT: 2, SPAWNER: 3, DESPAWNER: 4, SPLITTER: 5 } as const
type ToolCode = (typeof TOOL)[keyof typeof TOOL]

/** The free belt tools, in palette order: `data-tool`, label, `PLACE_MODE` code, `BeltKind`. */
const BELT_TOOLS = [
  { key: 'belt', label: 'Belt', code: TOOL.BELT, kind: 'Belt' },
  { key: 'spawner', label: 'Spawner', code: TOOL.SPAWNER, kind: 'Spawner' },
  { key: 'despawner', label: 'Despawner', code: TOOL.DESPAWNER, kind: 'Despawner' },
  { key: 'splitter', label: 'Splitter', code: TOOL.SPLITTER, kind: 'Splitter' },
] as const satisfies ReadonlyArray<{ key: string; label: string; code: ToolCode; kind: BeltKind }>

/** Each tool's footprint in tiles by direction (`content::FURNACE_FOOTPRINT`, `belt_footprint`:
 * change together): the touch Confirm sits centred under it, at `(x + w / 2, y + h)`. Only the
 * splitter's depends on the direction (1 x 2 facing east or west, 2 x 1 facing north or south). */
const ONE = { w: 1, h: 1 } as const
const FOOTPRINT: Readonly<
  Record<Exclude<ToolCode, 0>, Readonly<Record<Dir, { w: number; h: number }>>>
> = {
  [TOOL.FURNACE]: {
    East: { w: 2, h: 2 },
    South: { w: 2, h: 2 },
    West: { w: 2, h: 2 },
    North: { w: 2, h: 2 },
  },
  [TOOL.BELT]: { East: ONE, South: ONE, West: ONE, North: ONE },
  [TOOL.SPAWNER]: { East: ONE, South: ONE, West: ONE, North: ONE },
  [TOOL.DESPAWNER]: { East: ONE, South: ONE, West: ONE, North: ONE },
  [TOOL.SPLITTER]: {
    East: { w: 1, h: 2 },
    South: { w: 2, h: 1 },
    West: { w: 1, h: 2 },
    North: { w: 2, h: 1 },
  },
}

/** `Dir::cw` (`ROTATE_TOOL`'s turn) and the arrow the Rotate button shows for each direction. */
const CW: Readonly<Record<Dir, Dir>> = {
  East: 'South',
  South: 'West',
  West: 'North',
  North: 'East',
}
const ARROW: Readonly<Record<Dir, string>> = { East: '→', South: '↓', West: '←', North: '↑' }

function beltKindOf(tool: ToolCode): BeltKind | null {
  for (const t of BELT_TOOLS) if (t.code === tool) return t.kind
  return null
}

type AnchorHandle = ReturnType<Client['overlay']['anchor']>

/** Why a placement was refused, in words; the rest of the reasons keep only the flash. */
export function placeRefusal(reason: string): string | null {
  switch (reason) {
    case 'StateBudgetFull':
      return 'The world is full: nothing more can be built.'
    case 'RateLimited':
      return 'Too many actions at once.'
    case 'NotBuildable':
      return 'Cannot build there.'
    default:
      return null
  }
}

export type BuildUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

const STYLE_ID = 'reference-build-styles'

function installBuildStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.build-palette {',
    '  position: fixed;',
    '  left: 50%;',
    '  bottom: 8px;',
    '  transform: translateX(-50%);',
    '  z-index: 5;',
    '  display: flex;',
    '  gap: 4px;',
    '}',
    '.build-button, .tool-button, .build-rotate, .build-confirm {',
    '  padding: 4px 10px;',
    '  border: 1px solid #345;',
    '  border-radius: 4px;',
    '  background: #123;',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  cursor: pointer;',
    '  white-space: nowrap;',
    '}',
    '.build-reason { position: fixed; left: 8px; bottom: 36px; z-index: 5; padding: 2px 8px;',
    '  border-radius: 4px; background: #a33; color: #fff; font: 11px sans-serif; }',
    '.build-reason[hidden] { display: none; }',
    '.build-button.is-on, .tool-button.is-on { background: #264; }',
    // A fixed width: the arrow changes, the row does not re-centre.
    '.build-rotate { min-width: 88px; text-align: center; font-variant-numeric: tabular-nums; }',
    '.build-confirm { background: #264; }',
    '.build-button[hidden], .build-rotate[hidden], .build-confirm[hidden] { display: none; }',
    '.build-button[class*="reject-"], .tool-button[class*="reject-"],',
    '.build-confirm[class*="reject-"] {',
    '  animation: build-reject-flash 300ms ease-out;',
    '}',
    '@keyframes build-reject-flash {',
    '  0% { background: #a33; }',
    '  100% { background: #123; }',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

export function createBuildUi(client: Client, doc: Document = document): BuildUi {
  installBuildStyles(doc)

  const palette = el('div', 'build-palette')
  const button = el('button', 'build-button')
  button.dataset.build = ''
  button.textContent = 'Build'
  button.hidden = true
  const toolButtons = BELT_TOOLS.map((t) => {
    const b = el('button', 'tool-button')
    b.dataset.tool = t.key
    b.textContent = t.label
    b.addEventListener('click', () => setTool(tool === t.code ? TOOL.OFF : t.code))
    return b
  })
  const rotate = el('button', 'build-rotate')
  rotate.dataset.buildRotate = ''
  rotate.hidden = true
  palette.append(button, ...toolButtons, rotate)
  doc.body.appendChild(palette)

  const reasonLine = el('div', 'build-reason')
  reasonLine.hidden = true
  doc.body.appendChild(reasonLine)

  const confirm = el('button', 'build-confirm')
  confirm.textContent = 'Confirm'
  confirm.hidden = true
  // Anchored once, hidden until a touch tap; `set` moves it to each tapped tile.
  const anchor: AnchorHandle = client.overlay.anchor(confirm, 0, 0, { align: 'top' })

  /** The tool this page last emitted (`TOOL`); `OFF` outside construction mode. */
  let tool: ToolCode = TOOL.OFF
  let canBuild = false
  /** The page's copy of the construction direction `RefClient` keeps across tools (`East` at
   * start): turned at the page's own `ROTATE_TOOL` emit and overwritten by each `Ui.tool.dir`. */
  let dir: Dir = 'East'
  /** The tile a touch tap chose; `null` until one does, and again after leaving construction mode. */
  let touchTile: { x: number; y: number } | null = null
  /** `seq -> the control that sent it`, for the rejection flash. */
  const pending = new Map<number, HTMLElement>()

  function setTool(next: ToolCode): void {
    if (next === tool) return
    tool = next
    client.input.emit(LOCAL.PLACE_MODE, next)
    // A new tool has another footprint: a touch tap chooses its tile again.
    hideConfirm()
    showReason(null)
    render()
  }

  /** The palette button of the tool that is on (a mouse placement's rejection flashes it). */
  function activeButton(): HTMLElement {
    for (let i = 0; i < BELT_TOOLS.length; i++) {
      const b = toolButtons[i]
      if (b !== undefined && tool === BELT_TOOLS[i]?.code) return b
    }
    return button
  }

  /** Emits the turn and advances the page's own copy of the direction at once (the same turn
   * `RefClient` makes), so a tap in the next frame places with the direction the ghost will show. */
  function rotateTool(): void {
    if (beltKindOf(tool) === null) return
    if (!client.input.emit(LOCAL.ROTATE_TOOL, 0)) return
    dir = CW[dir]
    // A splitter's footprint turns with the direction: its Confirm follows the ghost's bottom edge.
    if (touchTile !== null) anchorConfirm(touchTile)
    render()
  }

  /** Puts the touch Confirm centred under the tool's footprint anchored at `at` (for `dir`). */
  function anchorConfirm(at: { x: number; y: number }): void {
    if (tool === TOOL.OFF) return
    const fp = FOOTPRINT[tool][dir]
    anchor.set(at.x + fp.w / 2, at.y + fp.h)
  }

  function hideConfirm(): void {
    touchTile = null
    confirm.hidden = true
  }

  function render(): void {
    const furnace = tool === TOOL.FURNACE
    button.hidden = !(canBuild || furnace)
    button.classList.toggle('is-on', furnace)
    button.textContent = furnace ? 'Cancel' : 'Build'
    for (let i = 0; i < BELT_TOOLS.length; i++) {
      toolButtons[i]?.classList.toggle('is-on', tool === BELT_TOOLS[i]?.code)
    }
    rotate.hidden = beltKindOf(tool) === null
    rotate.dataset.dir = dir
    rotate.textContent = `Rotate ${ARROW[dir]}`
  }

  function showReason(text: string | null, reason?: string): void {
    reasonLine.hidden = text === null
    reasonLine.textContent = text ?? ''
    if (reason === undefined) delete reasonLine.dataset.reason
    else reasonLine.dataset.reason = reason
  }

  function place(origin: { x: number; y: number }, from: HTMLElement): void {
    showReason(null)
    const at = { x: origin.x, y: origin.y }
    const kind = beltKindOf(tool)
    const action: RefAction =
      kind === null ? { PlaceFurnace: { origin: at } } : { PlaceBelt: { at, dir, kind } }
    pending.set(client.dispatch(action), from)
  }

  button.addEventListener('click', () => setTool(tool === TOOL.FURNACE ? TOOL.OFF : TOOL.FURNACE))
  rotate.addEventListener('click', rotateTool)
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setTool(TOOL.OFF)
    // `R` (by `code`, so any layout) turns a belt tool; never with a modifier (Ctrl+R reloads).
    else if (e.code === 'KeyR' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) rotateTool()
  })
  confirm.addEventListener('click', () => {
    if (touchTile === null) return
    place(touchTile, confirm)
  })

  client.input.on('tap', (e) => {
    if (tool === TOOL.OFF) return
    if (e.pointerType === 'touch') {
      // The engine has already moved its cursor tile here (the ghost follows); the Confirm button
      // sits at the bottom edge of the ghost (2x2 furnace, 1x1 belt, 2x1 splitter), centred on it.
      touchTile = { x: e.tileX, y: e.tileY }
      anchorConfirm(touchTile)
      confirm.dataset.buildConfirm = `${e.tileX},${e.tileY}`
      confirm.hidden = false
    } else {
      place({ x: e.tileX, y: e.tileY }, activeButton())
    }
  })

  function onUi(ui: RefUi): void {
    canBuild = ui.can_build
    // `RefClient` keeps the direction; a turn this page just emitted is already in `dir` and shows
    // here once its record has drained (a `Ui` from before it could step it back for one `Ui`).
    if (ui.tool !== null) dir = ui.tool.dir
    // The last furnace was placed: `RefClient` has already ended the furnace tool itself, so
    // follow it without emitting (an emit from a `Ui` callback lands between frames).
    if (tool === TOOL.FURNACE && !canBuild && !ui.placing) {
      tool = TOOL.OFF
      hideConfirm()
    }
    render()
  }

  function onActionResult(seq: number, result: ActionOutcome<RefReject>): void {
    if (result === 'NotPredictable') return
    const from = pending.get(seq)
    if (from === undefined) return
    pending.delete(seq)
    if (result === 'Confirmed' || result === 'Lost') return
    const reason = 'Game' in result.Rejected ? result.Rejected.Game : result.Rejected.Engine
    showReason(placeRefusal(String(reason)), String(reason))
    const cls = `reject-${String(reason).toLowerCase()}`
    from.classList.remove(cls)
    void from.offsetWidth
    from.classList.add(cls)
    from.addEventListener('animationend', () => from.classList.remove(cls), { once: true })
  }

  return { onUi, onActionResult }
}
