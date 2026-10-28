/** Which lines are the network's own, and the order lines are listed in. */
import { isWithinScopePools } from "../data/network-scope";
import { network } from "../networks/network";
import type { PtMode, TransitLine } from "../data/transit-types";
import { getModeRank, isRailMode } from "./pt-modes";

/**
 * The network's own line, or one named by an address alone: its numbering, line pages and observation
 * apply only to these. Other operators' lines show on boards.
 */
export const isNetworkLineIdentity = (identity: string | undefined): boolean =>
  identity === undefined || isWithinScopePools(network.scope, identity);

/** A row of the network's own lines. */
export const isNetworkRow = ({ lineRef }: { lineRef: string }): boolean =>
  isWithinScopePools(network.scope, lineRef);

/** The network's trams and Stadtbahn: what the plans draw and discovery follows. */
export const isNetworkRailRow = (row: { ptMode: PtMode; lineRef: string }): boolean =>
  isRailMode(row.ptMode) && isNetworkRow(row);

/** The trunk a branch's name is built on (S11 → S1); none for another network's line. */
export const getLineTrunkId = (lineId: string, identity?: string): string | undefined =>
  isNetworkLineIdentity(identity) ? network.getLineTrunkId(lineId) : undefined;

const compareNaturally = new Intl.Collator("de", { numeric: true }).compare;

type ComparedLine = Pick<TransitLine, "id" | "identity"> & { ptMode?: PtMode };

/** The network's own lines in its order, then other networks' lines by mode and name. */
export function compareLines(a: ComparedLine, b: ComparedLine): number {
  const isOwnA = isNetworkLineIdentity(a.identity);
  const isOwnB = isNetworkLineIdentity(b.identity);
  if (isOwnA && isOwnB) return network.compareLineIds(a.id, b.id);
  if (isOwnA !== isOwnB) return isOwnA ? -1 : 1;
  return (
    getModeRank(a.ptMode) - getModeRank(b.ptMode) ||
    compareNaturally(a.id, b.id) ||
    (a.identity ?? "").localeCompare(b.identity ?? "")
  );
}
