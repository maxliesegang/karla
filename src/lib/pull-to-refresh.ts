/**
 * Pull-to-refresh arithmetic: the drag becomes the distance the board follows, with resistance. The
 * hook draws whatever this derives.
 */

/** How far the board follows before release triggers a refresh. */
export const PULL_TO_REFRESH_TRIGGER_PX = 48;
/** The farthest the board follows the finger; past this the pull only grows heavier. */
export const PULL_TO_REFRESH_MAX_PX = 96;
/** The resistance scale: larger feels lighter. */
const PULL_TO_REFRESH_RESISTANCE_PX = 80;
/** How long an unanswered refresh may hold the strip open. */
export const PULL_TO_REFRESH_SETTLE_TIMEOUT_MS = 10_000;

/** The distance the board follows a drag of `dragY`, eased so it gets heavier. */
export function getPullDistance(dragY: number): number {
  if (dragY <= 0) return 0;
  return Math.round(
    PULL_TO_REFRESH_MAX_PX * (1 - Math.exp(-dragY / PULL_TO_REFRESH_RESISTANCE_PX)),
  );
}

/** Whether releasing at this distance refreshes. */
export function isPullTriggered(distance: number): boolean {
  return distance >= PULL_TO_REFRESH_TRIGGER_PX;
}
