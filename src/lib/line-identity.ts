/**
 * Which line a row belongs to beyond its name. A name is unique only within one network (`S1` runs
 * in Karlsruhe and Stuttgart), and one line number may carry several names (DB's `ddb:90RE4` is
 * RE40 and RE45), so a row is of a line when both its name and its identity agree.
 */

/** `vvs:20015` from `vvs:20015::H:j26`: the line ref's pool and line number, without direction. */
export function getLineIdentity(lineRef: string | undefined): string | undefined {
  const [pool, number] = lineRef?.split(":") ?? [];
  return pool && number ? `${pool}:${number}` : undefined;
}

/** A line as its rows name it: the name, and the line ref of any one of them. */
export type LineNaming = { lineId: string; lineRef?: string };

/**
 * Whether `actual` is the identity asked for. A line asked for by name alone (an address) is any
 * line of that name; one asked for by identity is only that identity.
 */
export const isSameLineIdentity = (
  actual: string | undefined,
  asked: string | undefined,
): boolean => asked === undefined || actual === asked;

/** A row of the named line. */
export const isRowOfLine = (row: LineNaming, lineId: string, identity?: string): boolean =>
  row.lineId === lineId && isSameLineIdentity(getLineIdentity(row.lineRef), identity);

/** Two rows of one line. */
export const isSameLine = (a: LineNaming, b: LineNaming): boolean =>
  isRowOfLine(a, b.lineId, getLineIdentity(b.lineRef));
