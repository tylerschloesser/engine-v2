// `no_ui_change_no_main_allocation` (docs/plan/16b-ui-observation-and-clock.md Tests added): a
// real, connected `createClient()` topology (`gc-ui.ts`) whose `fx-puts` `Ui` never actually
// changes across the whole measured window, proving the Budgets claim "unchanged `Ui` adds 0 B/
// frame (main row)". No `post-message` control (production-topology page, same reasoning as
// `sim`/`topology`/`echo`/`gen`).
import { zeroGcSuite } from './gc/suite.ts'

zeroGcSuite({
  pageId: 'no_ui_change',
  path: '/gc-ui.html',
  controlKinds: ['object', 'burst'],
})
