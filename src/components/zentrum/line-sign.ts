import { createLineSign } from "../../data/line-signs";
import type { TransitLine, TransportMode } from "../../data/transit-types";

/** The sign one line is read by in this view. */
export type ZentrumLineSignReader = (lineId: string) => TransitLine;

/**
 * How the plan signs its lines: the network's own reading where the observation has placed a line
 * in a mode, and the neutral sign where it has not.
 *
 * One reader for the whole drawing rather than a lookup passed down and defaulted at each use — the
 * plan asks for a sign at every lane, every mark and every badge, and each of them wants the same
 * answer.
 */
export const createZentrumLineSignReader = (
  lines: readonly { id: string; transportMode: TransportMode }[],
): ZentrumLineSignReader => {
  const signByLineId = new Map(
    lines.map((line): [string, TransitLine] => [
      line.id,
      createLineSign(line.id, line.transportMode),
    ]),
  );
  return (lineId) => signByLineId.get(lineId) ?? createLineSign(lineId, "other");
};
