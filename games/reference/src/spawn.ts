// The first-`Ui` spawn move's decision (M33e, kept apart from
// `game.ts` so a DOM-free test can call it.

/** The camera fields a player can change: position and zoom. Not the viewport size, not velocity,
 * not the frame time: `stepFrame` and a resize write those without the player moving anything. */
export type CameraPose = { centreX: number; centreY: number; tilesAcross: number }

export function poseOf(s: CameraPose): CameraPose {
  return { centreX: s.centreX, centreY: s.centreY, tilesAcross: s.tilesAcross }
}

/** Move to `Ui.spawn` only for a fresh session (nothing restored) whose camera is still where the
 * client created it: `onUi` rides the real rAF, so the player may have panned before it arrives. */
export function shouldMoveToSpawn(
  restored: boolean,
  atCreation: CameraPose,
  now: CameraPose,
): boolean {
  if (restored) return false
  return (
    now.centreX === atCreation.centreX &&
    now.centreY === atCreation.centreY &&
    now.tilesAcross === atCreation.tilesAcross
  )
}
