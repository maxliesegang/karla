/**
 * The arithmetic of pulling a departure board down to ask for the feed again.
 *
 * The board is the scrollport's content, not the scrollport itself, so a pull cannot be read off a
 * scroll position: the finger's drag is turned into the distance the board follows it, with
 * resistance so the pull reads as weight rather than as a bottomless page. The distances are the
 * whole contract between the hook that reads the gesture and the strip it draws — the hook renders
 * whatever this derives, and the trigger is what "let go now means it".
 */

/** How far the board follows before letting go asks for the feed again. */
export const PULL_TO_REFRESH_TRIGGER_PX = 48;
/** The furthest the board follows the finger; past this the pull only grows heavier. */
export const PULL_TO_REFRESH_MAX_PX = 96;
/**
 * The drag length the resistance curve is scaled by: the pull that would reach two thirds of the
 * ceiling if it did not bend. Larger reads lighter, smaller reads like a stuck page.
 */
const PULL_TO_REFRESH_RESISTANCE_PX = 80;
/**
 * How long a started refresh may go unanswered before the board lets the gesture go. A refresh that
 * is answered is what settles the strip; this only keeps a lost request from holding it open.
 */
export const PULL_TO_REFRESH_SETTLE_TIMEOUT_MS = 10_000;

/**
 * The distance the board follows a downward drag of `dragY` past the scrollport's top, eased so the
 * first centimetres answer freely and the last ones barely move at all.
 */
export function getPullDistance(dragY: number): number {
  if (dragY <= 0) return 0;
  return Math.round(
    PULL_TO_REFRESH_MAX_PX * (1 - Math.exp(-dragY / PULL_TO_REFRESH_RESISTANCE_PX)),
  );
}

/** Whether a pull this far, let go, asks for the feed again. */
export function isPullTriggered(distance: number): boolean {
  return distance >= PULL_TO_REFRESH_TRIGGER_PX;
}
