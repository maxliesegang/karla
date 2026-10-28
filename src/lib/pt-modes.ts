import type { PtMode } from "../data/transit-types";

export const isRailMode = (mode: PtMode | undefined): boolean =>
  mode === "tram" || mode === "lightRail";

/** Trams, Stadtbahn, trains, then buses. */
export const PT_MODE_ORDER: readonly PtMode[] = [
  "tram",
  "lightRail",
  "regionalRail",
  "longDistanceRail",
  "bus",
  "other",
];

export const getModeRank = (mode: PtMode | undefined): number =>
  mode ? PT_MODE_ORDER.indexOf(mode) : PT_MODE_ORDER.length;
