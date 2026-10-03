/**
 * Which band of the network page the scroll is in, read against one line (the band's scroll-margin)
 * so the marked button, stuck heading and landed jump agree. As in `boarding-place-sections.ts`,
 * except above the first heading the topmost band counts.
 */

/** One rendered band: its mode and top edge. */
export type NetworkBandReading = {
  id: string;
  /** In the reading line's coordinates. */
  top: number;
};

/** Sub-pixel slack, so arriving counts as arrived. */
const ARRIVAL_SLACK_PX = 1;

/**
 * The band being read: the lowest one whose section has reached the line, else the topmost.
 * `undefined` while no band is rendered.
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
