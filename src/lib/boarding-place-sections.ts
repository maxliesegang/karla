/**
 * Which boarding place's section the scroll is in, read against one line (the section's
 * scroll-margin) so the marked button, stuck heading and landed jump agree.
 */

/** One rendered section: its place id and top edge. */
export type BoardingPlaceSectionReading = {
  id: string;
  /** In the reading line's coordinates. */
  top: number;
};

/** Sub-pixel slack, so arriving counts as arrived. */
const ARRIVAL_SLACK_PX = 1;

/**
 * The place being read: the lowest section that has reached the line; `undefined` if none has.
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
