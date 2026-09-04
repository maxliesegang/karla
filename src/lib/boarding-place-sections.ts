/**
 * Where in a board's own places the scroll stands, which is what the place bar marks.
 *
 * The board's sections are read against one line: the height a section's top edge reaches before
 * the board counts as reading at that place. It is the same line the sticky headings take over
 * at, and the same line a walked-to section comes to rest at — so the marked button, the stuck
 * heading and the landed jump are one reading, not three that can disagree.
 */

/** One rendered place's section, as the scroll reading finds it: which place, where it stands. */
export type BoardingPlaceSectionReading = {
  /** The place's own id, the one its section is registered under. */
  id: string;
  /** The section's top edge, in the same coordinates the reading line is given in. */
  top: number;
};

/** Sub-pixel rounding of the section rectangles: arrived means arrived, not arrived minus a hair. */
const ARRIVAL_SLACK_PX = 1;

/**
 * The place the board is being read at, or `undefined` while it is being read at none.
 *
 * A place is in view once its section has reached the reading line; of those, the one whose section
 * stands lowest is the one being read — the section that arrived last, whose heading is the one
 * stuck at the top. A section still below the line is further down the board than the scroll has
 * got to, and a board whose sections all sit below the line is being read at no place at all.
 */
export function findBoardingPlaceIdInView(
  readings: readonly BoardingPlaceSectionReading[],
  readingLine: number,
): string | undefined {
  let inViewId: string | undefined;
  let inViewTop = Number.NEGATIVE_INFINITY;
  for (const reading of readings) {
    if (reading.top > readingLine + ARRIVAL_SLACK_PX) continue;
    if (inViewId === undefined || reading.top > inViewTop) {
      inViewId = reading.id;
      inViewTop = reading.top;
    }
  }
  return inViewId;
}
