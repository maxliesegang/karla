import { createLineSign } from "../../data/line-signs";
import type { TransitLine, TransportMode } from "../../data/transit-types";

/** The sign one line is read by in this view. */
export type ZentrumLineSignReader = (lineId: string) => TransitLine;

const createZentrumLineSign = (lineId: string, mode: TransportMode): TransitLine => {
  const sign = createLineSign(lineId, mode);
  return lineId === "E" ? { ...sign, color: "#59635f", textColor: "#fff" } : sign;
};

/** Observed line signs, with a fixed neutral sign for E. */
export const createZentrumLineSignReader = (
  lines: readonly { id: string; transportMode: TransportMode }[],
): ZentrumLineSignReader => {
  const signByLineId = new Map(
    lines.map((line): [string, TransitLine] => [
      line.id,
      createZentrumLineSign(line.id, line.transportMode),
    ]),
  );
  return (lineId) => signByLineId.get(lineId) ?? createZentrumLineSign(lineId, "other");
};
