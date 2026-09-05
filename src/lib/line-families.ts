import type { TransitLine } from "../data/transit-types";

/**
 * Passenger-facing line identity.
 *
 * This remains a named boundary because route patterns may later share an underlying spine. That
 * is topology deduplication, not line identity: S1 and S11 keep their own signs, departures,
 * notices and addresses even where most of their stops coincide.
 */
export function getLineFamilyId(lineId: string): string {
  return lineId;
}

export const isSameLineFamily = (left: string, right: string): boolean =>
  getLineFamilyId(left) === getLineFamilyId(right);

/** One entry per passenger-facing line; retained as the common call site for line indexes. */
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
 * The trunk an S-Bahn line's number is built on: S11 and S12 read S1, S51 reads S5, S1 reads itself.
 *
 * This is how KVV numbers a branch -- a digit appended to the trunk it leaves -- and nothing more.
 * It is not a statement that two lines are one, nor that they run together: S4 and S41 share a
 * trunk and part company north of the city. A caller drawing a pair as one has to establish that
 * separately.
 */
export const getLineTrunkId = (lineId: string): string | undefined => lineId.match(/^S\d/)?.[0];

/**
 * Trams first and then by number, which is the order a rider sees them listed on a KVV sign.
 * S-Bahn branches stay beside their trunk: S1, S11, S12, S2, … and S5, S51, S52, …
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
