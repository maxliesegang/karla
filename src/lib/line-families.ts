import type { TransitLine } from "../data/transit-types";

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
 * The trunk an S-Bahn number is built on (S11 → S1, S51 → S5). KVV's numbering only: S4 and S41
 * part north of the city, so it does not mean they run together.
 */
export const getLineTrunkId = (lineId: string): string | undefined => lineId.match(/^S\d/)?.[0];

/**
 * Trams first, then by number, branches beside their trunk (S1, S11, S12, S2), as KVV signs list
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
