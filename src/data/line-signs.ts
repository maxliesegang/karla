import { findOtherLineColor } from "../lib/line-colors";
import { getLineIdentity, isSameLineIdentity } from "../lib/line-identity";
import { network } from "../networks/network";
import { isWithinScopePools } from "./network-scope";
import type { TransitLine, PtMode, StopEvent } from "./transit-types";

/** A mode's name in text; nothing is conveyed by colour alone. */
export const labelByPtMode: Record<PtMode, string> = {
  lightRail: "Stadtbahn",
  tram: "Straßenbahn",
  regionalRail: "Zug",
  longDistanceRail: "Fernzug",
  bus: "Bus",
  other: "Linie",
};

/** Neutral colours for lines no source colours, so they stay readable without inventing one. */
const neutralColorByPtMode: Record<PtMode, string> = {
  lightRail: "#2f4f56",
  tram: "#3f4a4a",
  regionalRail: "#4a4f57",
  longDistanceRail: "#3a3a3a",
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

const darken = (hex: string, factor: number): string =>
  `#${[1, 3, 5]
    .map((offset) =>
      Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * factor)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** A pale colour darkened to about 2:1 on white for the plan; badges keep the official colour. */
export function getPlanLineTone(color: string): string | undefined {
  if (!needsLineOutline(color)) return undefined;
  let factor = 1;
  while (factor > 0.5 && contrastRatio(darken(color, factor), "#ffffff") < 2) factor -= 0.02;
  return darken(color, factor);
}

/** Text by contrast: operators publish white text even on light colours. */
function getAccessibleTextColor(color: string): string {
  if (contrastRatio(color, "#ffffff") >= 4.5) return "#fff";
  if (contrastRatio(color, "#102c2c") >= 4.5) return "#102c2c";
  return "#000";
}

/** Where a row's journey starts and ends, which tells other operators' lines of one name apart. */
export const getJourneyEnds = ({
  originStopPointId,
  destinationStopPointId,
}: Pick<StopEvent, "originStopPointId" | "destinationStopPointId">): string[] =>
  [originStopPointId, destinationStopPointId].filter((id): id is string => Boolean(id));

const findLineColor = (
  lineId: string,
  mode: PtMode,
  lineRef: string | undefined,
  journeyEnds: readonly string[],
): string | undefined =>
  // A line named by an address alone is the network's until a row says otherwise.
  lineRef === undefined || isWithinScopePools(network.scope, lineRef)
    ? network.getLineColor(lineId, mode)
    : findOtherLineColor(lineId, journeyEnds, {
        areas: network.operatorAreas,
        colors: network.otherLineColors,
        getHomeColor: (name) => network.getLineColor(name, mode),
        homeDistrict: network.catalogSource.stopIdPrefix.replace(/:$/, ""),
      });

/**
 * A line's sign: the network's colour for its own lines, another operator's by the journey's ends,
 * else neutral by mode. Which lines run comes only from the live feed.
 */
export function createLineSign(
  lineId: string,
  mode: PtMode,
  lineRef?: string,
  journeyEnds: readonly string[] = [],
): TransitLine {
  const color = findLineColor(lineId, mode, lineRef, journeyEnds) ?? neutralColorByPtMode[mode];
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
  journeyEnds: readonly string[] = [],
): TransitLine {
  return (
    lines.find(
      (line) => line.id === lineId && isSameLineIdentity(line.identity, getLineIdentity(lineRef)),
    ) ?? createLineSign(lineId, mode, lineRef, journeyEnds)
  );
}
