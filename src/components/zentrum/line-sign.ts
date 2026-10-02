import { createLineSign } from "../../data/line-signs";
import type { TransitLine, TransportMode } from "../../data/transit-types";

/** The sign one line is read by in this view. */
export type ZentrumLineSignReader = (lineId: string) => TransitLine;

/** How the plan signs its lines: by the mode the network observed, else the neutral sign. */
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
