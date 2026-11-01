import { findOtherLineColor } from "../lib/line-colors";
import { getLineColors } from "../lib/line-sign-colors";
import { isNetworkLineIdentity } from "../lib/network-lines";
import { getLineIdentity, isSameLineIdentity } from "../lib/line-identity";
import { network } from "../networks/network";
import type { PublishedLineColor } from "../networks/network-definition";
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

/** What a row says of its line: name, mode, ref, and where its journey starts and ends. */
type LineSignRow = Pick<
  StopEvent,
  "lineId" | "ptMode" | "lineRef" | "originStopPointId" | "destinationStopPointId"
>;

/** Where a row's journey starts and ends, which tells other operators' lines of one name apart. */
const getJourneyEnds = ({ originStopPointId, destinationStopPointId }: LineSignRow): string[] =>
  [originStopPointId, destinationStopPointId].filter((id): id is string => Boolean(id));

const findLineColor = (
  lineId: string,
  mode: PtMode,
  lineRef: string | undefined,
  journeyEnds: readonly string[],
): PublishedLineColor | undefined =>
  isNetworkLineIdentity(lineRef)
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
  const published = findLineColor(lineId, mode, lineRef, journeyEnds);
  const identity = getLineIdentity(lineRef);
  return {
    id: lineId,
    ...(identity ? { identity } : {}),
    name: `${labelByPtMode[mode]} ${lineId}`,
    ptMode: mode,
    ...getLineColors(published?.color ?? neutralColorByPtMode[mode], published?.textColor),
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

export const createStopEventLineSign = (row: LineSignRow): TransitLine =>
  createLineSign(row.lineId, row.ptMode, row.lineRef, getJourneyEnds(row));

export const getStopEventLineSign = (
  lines: readonly TransitLine[],
  row: LineSignRow,
): TransitLine => getLineSign(lines, row.lineId, row.ptMode, row.lineRef, getJourneyEnds(row));
