// `engine/vite`: Node built-ins only (docs/decisions/0017 §2). M02b adds the `engine()` plugin.
export {
  type BuildGameOptions,
  type BuildGameResult,
  buildGame,
  CargoBuildError,
  type GameJson,
  type Profile,
} from './build-game.js'
