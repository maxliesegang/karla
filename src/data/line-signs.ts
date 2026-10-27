import { getLineIdentity, isSameLineIdentity } from "../lib/line-identity";
import { network } from "../networks/network";
import { isWithinScopePools } from "./network-scope";
import type { TransitLine, PtMode } from "./transit-types";

/** A mode's name in text; nothing is conveyed by colour alone. */
export const labelByPtMode: Record<PtMode, string> = {
  lightRail: "Stadtbahn",
  tram: "Straßenbahn",
  bus: "Bus",
  other: "Linie",
};

/**
 * Neutral colours for lines missing from the GTFS snapshot, so new lines stay readable without
 * inventing a colour.
 */
const neutralColorByPtMode: Record<PtMode, string> = {
  lightRail: "#2f4f56",
  tram: "#3f4a4a",
  bus: "#6b6257",
  other: "#59635f",
};

const hexChannel = (hex: string, offset: number): number =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
const linearChannel = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const relativeLuminance = (hex: string): number =>
  0.2126 * linearChannel(hexChannel(hex, 1)) +
  0.7152 * linearChannel(hexChannel(hex, 3)) +
  0.0722 * linearChannel(hexChannel(hex, 5));
const contrastRatio = (first: string, second: string): number => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

/** Pale line graphics need help against the plan's white separators. */
export const needsLineOutline = (color: string): boolean => contrastRatio(color, "#ffffff") < 2;

/** Darker tones for pale colours on the plan, about 2:1 on white; badges keep the official colour. */
const planToneByColor: Record<string, string> = {
  "#ffff00": "#cfc200",
  "#ffcc00": "#eba900",
  "#b3ff00": "#86c400",
  "#4dd3ff": "#1fb3ea",
  "#00d9b8": "#00b8a0",
};

export const getPlanLineTone = (color: string): string | undefined => planToneByColor[color];

/** KVV publishes white route text throughout, even on light colours. */
function getAccessibleTextColor(color: string): string {
  if (contrastRatio(color, "#ffffff") >= 4.5) return "#fff";
  if (contrastRatio(color, "#102c2c") >= 4.5) return "#102c2c";
  return "#000";
}

/**
 * A line's sign: from KVV's GTFS for a KVV line where known, else neutral by mode. Which lines run
 * comes only from the live feed.
 */
export function createLineSign(lineId: string, mode: PtMode, lineRef?: string): TransitLine {
  // A line named by an address alone is the network's until a row says otherwise.
  const verifiedColor =
    lineRef === undefined || isWithinScopePools(network.scope, lineRef)
      ? network.getLineColor(lineId, mode)
      : undefined;
  const color = verifiedColor ?? neutralColorByPtMode[mode];
  const identity = getLineIdentity(lineRef);
  return {
    id: lineId,
    ...(identity ? { identity } : {}),
    name: `${labelByPtMode[mode]} ${lineId}`,
    ptMode: mode,
    color,
    textColor: getAccessibleTextColor(color),
    destinations: [],
    zentrumCalls: [],
  };
}

/** A departure's sign, preferring the caller's line record (which has the observed ends). */
export function getLineSign(
  lines: readonly TransitLine[],
  lineId: string,
  mode: PtMode,
  lineRef?: string,
): TransitLine {
  return (
    lines.find(
      (line) => line.id === lineId && isSameLineIdentity(line.identity, getLineIdentity(lineRef)),
    ) ?? createLineSign(lineId, mode, lineRef)
  );
}
