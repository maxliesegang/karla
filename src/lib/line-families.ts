import { isWithinScopePools } from "../data/network-scope";
import { network } from "../networks/network";
import type { PtMode, TransitLine } from "../data/transit-types";

/**
 * Passenger-facing line identity. S1 and S11 keep their own signs, departures, notices and
 * addresses even where their stops coincide.
 */
export function getLineFamilyId(lineId: string): string {
  return lineId;
}

export const isSameLineFamily = (left: string, right: string): boolean =>
  getLineFamilyId(left) === getLineFamilyId(right);

/** One entry per passenger-facing line. */
export function getGroupedLines(lines: readonly TransitLine[]): readonly TransitLine[] {
  return lines;
}

export function findLineForRoute(
  lines: readonly TransitLine[],
  requestedId: string,
): TransitLine | undefined {
  return lines.find((line) => isSameLineFamily(line.id, requestedId));
}

/**
 * The network's own line, or one named by an address alone: its numbering, line pages and observation
 * apply only to these. Other operators' lines show on boards.
 */
export const isNetworkLineIdentity = (identity: string | undefined): boolean =>
  identity === undefined || isWithinScopePools(network.scope, identity);

/** A row of the network's own lines; a row stating no ref counts as one. */
export const isNetworkRow = ({ lineRef }: { lineRef?: string }): boolean =>
  isNetworkLineIdentity(lineRef);

/** The trunk a branch's name is built on (S11 → S1); none for another network's line. */
export const getLineTrunkId = (lineId: string, identity?: string): string | undefined =>
  isNetworkLineIdentity(identity) ? network.getLineTrunkId(lineId) : undefined;

/**
 * Trams first, then by number, branches beside their trunk (S1, S11, S12, S2), as KVV's signs list
 * them.
 */
export function compareLineIds(a: string, b: string): number {
  const rank = (id: string) => (id.startsWith("S") ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const number = (id: string) => Number.parseInt(id.replace(/^\D+/, ""), 10) || 0;
  if (a.startsWith("S") && b.startsWith("S")) {
    const trunk = (id: string) => Number.parseInt(getLineTrunkId(id)?.slice(1) ?? "0", 10);
    return trunk(a) - trunk(b) || number(a) - number(b) || a.localeCompare(b);
  }
  return number(a) - number(b) || a.localeCompare(b);
}

const compareNaturally = new Intl.Collator("de", { numeric: true }).compare;

const MODE_ORDER: readonly PtMode[] = [
  "tram",
  "lightRail",
  "regionalRail",
  "longDistanceRail",
  "bus",
  "other",
];
const getModeRank = (mode: PtMode | undefined): number =>
  mode ? MODE_ORDER.indexOf(mode) : MODE_ORDER.length;

type ComparedLine = Pick<TransitLine, "id" | "identity"> & { ptMode?: PtMode };

/** The network's own lines in its order, then other networks' lines by mode and name. */
export function compareLines(a: ComparedLine, b: ComparedLine): number {
  const isOwnA = isNetworkLineIdentity(a.identity);
  const isOwnB = isNetworkLineIdentity(b.identity);
  if (isOwnA && isOwnB) return compareLineIds(a.id, b.id);
  if (isOwnA !== isOwnB) return isOwnA ? -1 : 1;
  return (
    getModeRank(a.ptMode) - getModeRank(b.ptMode) ||
    compareNaturally(a.id, b.id) ||
    (a.identity ?? "").localeCompare(b.identity ?? "")
  );
}
