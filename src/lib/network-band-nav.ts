/**
 * Where in the network page's bands the scroll stands, which is what the band navigation marks.
 *
 * The bands are read against one line — the height a band's top edge reaches before the page counts
 * as reading at that band, the same line its heading takes over at and a walked-to band comes to
 * rest at — so the marked button, the stuck heading and the landed jump are one reading, not three
 * that can disagree. It is the same reading the place bar makes of a departure board
 * (lib/boarding-place-sections.ts) with one difference a page has that a board does not: the scroll
 * can stand above the first heading with nothing pinned yet, and the page is still being read in
 * that band — its rows are what fills the screen. So the topmost band is the answer where a board
 * would say none.
 */

/** One rendered band, as the scroll reading finds it: which mode, where it stands. */
export type NetworkBandReading = {
  /** The band's own mode, the one its section is registered under. */
  id: string;
  /** The band's top edge, in the same coordinates the reading line is given in. */
  top: number;
};

/** Sub-pixel rounding of the band rectangles: arrived means arrived, not arrived minus a hair. */
const ARRIVAL_SLACK_PX = 1;

/**
 * The band the page is being read in, or `undefined` while no band has been rendered at all.
 *
 * A band is in view once its section has reached the reading line; of those, the one whose section
 * stands lowest is the one being read — the section that arrived last, whose heading is the one
 * stuck at the top. Where no section has reached the line yet, the scroll stands above the first
 * band, and the topmost band is the one being read.
 */
export function findNetworkBandIdInView(
  readings: readonly NetworkBandReading[],
  readingLine: number,
): string | undefined {
  let inViewId: string | undefined;
  let inViewTop = Number.NEGATIVE_INFINITY;
  let topmostId: string | undefined;
  let topmostTop = Number.POSITIVE_INFINITY;
  for (const reading of readings) {
    if (
      reading.top <= readingLine + ARRIVAL_SLACK_PX &&
      (inViewId === undefined || reading.top > inViewTop)
    ) {
      inViewId = reading.id;
      inViewTop = reading.top;
    }
    if (reading.top < topmostTop) {
      topmostTop = reading.top;
      topmostId = reading.id;
    }
  }
  return inViewId ?? topmostId;
}
