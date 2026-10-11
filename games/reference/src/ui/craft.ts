// `createCraftUi` (M32 Scope): the crafting menu. Hidden until
// `Ui.recipes` is non-empty (the unlock is sim state, `rules::craft::update_unlocks`); one button
// per listed recipe; a button is disabled while a craft runs or the recipe is unaffordable; while
// `Ui.crafting` names a button's recipe it fills over the remaining time -- one CSS animation,
// started once from `done_at` and `client.clock()` over `duration + lead` (`own-timer.ts`, 0064 §2; 0003
// "How the UI observes state"). A rejected `StartCraft` flashes its button with `reject-<reason>`.
//
// DOM identity: a button carries `data-craft-recipe="<id>"`; the menu root is `.craft-menu`.
import type { ActionOutcome, Client } from 'engine'
import type { RefAction } from '../bindings/RefAction.js'
import type { RefReject } from '../bindings/RefReject.js'
import type { RefUi } from '../bindings/RefUi.js'
import { diffKeyed, el } from './dom.js'
import { ITEM_LABELS } from './inventory.js'
import { ownTimerMs } from './own-timer.js'

type RecipeEntry = RefUi['recipes'][number]

/** Recipe id (index into `content::RECIPES`) -> display name. */
const RECIPE_NAMES = ['Furnace']

type ButtonEntry = {
  button: HTMLButtonElement
  fill: HTMLSpanElement
  label: HTMLSpanElement
  recipe: number
  filling: boolean
}

export type CraftUi = {
  /** Wired to `client.onUi<RefUi>`. */
  onUi(ui: RefUi): void
  /** Wired to `client.onActionResult<RefReject>`; only `StartCraft`s this controller sent count. */
  onActionResult(seq: number, result: ActionOutcome<RefReject>): void
}

const STYLE_ID = 'reference-craft-styles'

function installCraftStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '.craft-menu {',
    '  position: fixed;',
    '  left: 8px;',
    '  bottom: 8px;',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 4px;',
    '}',
    '.craft-menu[hidden] { display: none; }',
    '.craft-button {',
    '  position: relative;',
    '  overflow: hidden;',
    '  padding: 4px 10px;',
    '  border: 1px solid #345;',
    '  border-radius: 4px;',
    '  background: #123;',
    '  color: #fff;',
    '  font: 11px sans-serif;',
    '  cursor: pointer;',
    '  white-space: nowrap;',
    '}',
    '.craft-button:disabled { cursor: default; opacity: 0.55; }',
    '.craft-button .craft-fill {',
    '  position: absolute;',
    '  inset: 0;',
    '  background: rgba(255, 255, 255, 0.35);',
    '  transform: scaleX(0);',
    '  transform-origin: left center;',
    '  pointer-events: none;',
    '}',
    '.craft-button.is-filling .craft-fill {',
    '  animation: craft-fill-anim var(--craft-duration, 0ms) linear forwards;',
    '}',
    '@keyframes craft-fill-anim {',
    '  from { transform: scaleX(0); }',
    '  to { transform: scaleX(1); }',
    '}',
    '.craft-button .craft-label { position: relative; }',
    '.craft-button[class*="reject-"] { animation: craft-reject-flash 300ms ease-out; }',
    '@keyframes craft-reject-flash {',
    '  0% { background: #a33; }',
    '  100% { background: #123; }',
    '}',
  ].join('\n')
  doc.head.appendChild(style)
}

function labelText(r: RecipeEntry): string {
  const name = RECIPE_NAMES[r.recipe] ?? `Recipe ${r.recipe}`
  const cost = r.cost
    .map((n, i) => (n > 0 ? `${n} ${ITEM_LABELS[i]}` : ''))
    .filter((s) => s !== '')
    .join(', ')
  return `Craft ${name} (${cost}, ${r.secs}s)`
}

export function createCraftUi(client: Client, doc: Document = document): CraftUi {
  installCraftStyles(doc)
  const root = el('div', 'craft-menu')
  root.hidden = true
  doc.body.appendChild(root)

  const buttons = new Map<string, ButtonEntry>()
  /** `seq -> recipe key` of still-pending `StartCraft`s, for the rejection flash. */
  const pendingSeq = new Map<number, string>()

  function create(r: RecipeEntry): ButtonEntry {
    const button = el('button', 'craft-button')
    button.dataset.craftRecipe = String(r.recipe)
    const fill = el('span', 'craft-fill')
    const label = el('span', 'craft-label')
    button.appendChild(fill)
    button.appendChild(label)
    root.appendChild(button)
    const entry: ButtonEntry = { button, fill, label, recipe: r.recipe, filling: false }
    button.addEventListener('click', () => {
      if (button.disabled) return
      const action: RefAction = { StartCraft: { recipe: entry.recipe } }
      pendingSeq.set(client.dispatch(action), String(entry.recipe))
    })
    return entry
  }

  function startFilling(entry: ButtonEntry, durationMs: number): void {
    entry.button.style.setProperty('--craft-duration', `${Math.max(0, durationMs)}ms`)
    entry.button.classList.remove('is-filling')
    void entry.button.offsetWidth // restart the animation
    entry.button.classList.add('is-filling')
    entry.filling = true
  }

  function stopFilling(entry: ButtonEntry): void {
    if (!entry.filling) return
    entry.button.classList.remove('is-filling')
    entry.filling = false
  }

  function onUi(ui: RefUi): void {
    root.hidden = ui.recipes.length === 0
    diffKeyed(buttons, ui.recipes, (r) => String(r.recipe), {
      create,
      remove: (e) => e.button.remove(),
      update: (e, r) => {
        e.label.textContent = labelText(r)
        const crafting = ui.crafting !== null
        e.button.disabled = crafting || !r.affordable
        if (ui.crafting !== null && ui.crafting.recipe === r.recipe) {
          if (!e.filling) {
            startFilling(e, ownTimerMs(ui.crafting.done_at, client.clock()))
          }
        } else {
          stopFilling(e)
        }
      },
    })
  }

  function onActionResult(seq: number, result: ActionOutcome<RefReject>): void {
    if (result === 'NotPredictable') return // a hint; the host's verdict for this seq follows
    const key = pendingSeq.get(seq)
    if (key === undefined) return
    pendingSeq.delete(seq)
    if (result === 'Confirmed' || result === 'Lost') return
    const entry = buttons.get(key)
    if (entry === undefined) return
    const reason = 'Game' in result.Rejected ? result.Rejected.Game : result.Rejected.Engine
    const cls = `reject-${String(reason).toLowerCase()}`
    entry.button.classList.remove(cls)
    void entry.button.offsetWidth
    entry.button.classList.add(cls)
    entry.button.addEventListener('animationend', () => entry.button.classList.remove(cls), {
      once: true,
    })
  }

  return { onUi, onActionResult }
}
