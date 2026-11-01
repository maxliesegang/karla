import { createLineSign } from "../../data/line-signs";
import { getLineColors } from "../../lib/line-sign-colors";
import type { TransitLine, PtMode } from "../../data/transit-types";

/** The sign one line is read by in this view. */
export type ZentrumLineSignReader = (lineId: string) => TransitLine;

const createZentrumLineSign = (lineId: string, mode: PtMode): TransitLine => {
  const sign = createLineSign(lineId, mode);
  return lineId === "E" ? { ...sign, ...getLineColors("#59635f", "#ffffff") } : sign;
};

/** Observed line signs, with a fixed neutral sign for E. */
export const createZentrumLineSignReader = (
  lines: readonly { id: string; ptMode: PtMode }[],
): ZentrumLineSignReader => {
  const signByLineId = new Map(
    lines.map((line): [string, TransitLine] => [
      line.id,
      createZentrumLineSign(line.id, line.ptMode),
    ]),
  );
  return (lineId) => signByLineId.get(lineId) ?? createZentrumLineSign(lineId, "other");
};
