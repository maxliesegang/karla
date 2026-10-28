/**
 * The line level of the selection, resolved against live data; pure, so testable without mounting.
 */
import { getLineSign, getStopEventLineSign } from "./data/line-signs";
import type { StopEvent, StopEventBoard, TransitLine, TransitNetwork } from "./data/transit-types";
import { getResolvedBundledLineIds } from "./lib/line-bundles";
import { isNetworkRow } from "./lib/network-lines";
import { getLineIdentity } from "./lib/line-identity";
import type { AppRoute } from "./routing";

/**
 * The line in view: running if this stop's board lists it, observation or not (how buses keep their
 * sign). A stop-scoped journey names no line, so its departure supplies one.
 */
export function findSelectedLine(
  route: AppRoute,
  network: TransitNetwork,
  stopEvents: readonly StopEvent[],
  stopEventBoard: StopEventBoard | null,
  observedLine: TransitLine | undefined,
  ownStopEvent: StopEvent | undefined,
): TransitLine | undefined {
  if (observedLine) return observedLine;

  // An address names the network's line; another operator's line of that name is not it.
  const lineStopEvent = route.lineId
    ? stopEvents.find((stopEvent) => stopEvent.lineId === route.lineId && isNetworkRow(stopEvent))
    : ownStopEvent;
  if (lineStopEvent) return getStopEventLineSign(network.lines, lineStopEvent);

  // A restored ride keeps its line with a neutral sign until its retained dated journey resolves.
  if (route.isRide && route.lineId) return getLineSign(network.lines, route.lineId, "other");

  // A journey past this stop is on no board here, but its ref names its line's identity; the line
  // holds as long as the journey does, so the line's readings can still find it.
  const journeyIdentity = route.lineId ? undefined : getLineIdentity(route.addressId);
  const journeyLine =
    journeyIdentity && network.lines.find(({ identity }) => identity === journeyIdentity);
  if (journeyLine) return journeyLine;

  // An asked-for line keeps a neutral sign while the board loads or fails; only a readable board
  // without it drops it.
  const isBoardReadable = stopEventBoard?.dataStatus === "live";
  return route.lineId && !isBoardReadable
    ? getLineSign(network.lines, route.lineId, "other")
    : undefined;
}

const EMPTY_LINES: readonly TransitLine[] = [];

/**
 * The addressed siblings, signed: observed, else as this stop's board runs them, else neutral. The
 * live board alone drops one (`getResolvedBundledLineIds`), so a cold link keeps its bundle.
 */
export function findBundledLines(
  bundledLineIds: readonly string[],
  selectedLine: TransitLine | undefined,
  network: TransitNetwork,
  stopEventBoard: StopEventBoard | null,
): readonly TransitLine[] {
  if (!selectedLine || bundledLineIds.length === 0) return EMPTY_LINES;
  return getResolvedBundledLineIds(bundledLineIds, stopEventBoard).flatMap((lineId) => {
    if (lineId === selectedLine.id) return [];
    const running = stopEventBoard?.stopEvents.find((stopEvent) => stopEvent.lineId === lineId);
    const observed = network.lines.find((line) => line.id === lineId);
    if (observed) return [observed];
    return running
      ? [getStopEventLineSign(network.lines, running)]
      : [getLineSign(network.lines, lineId, "other")];
  });
}
