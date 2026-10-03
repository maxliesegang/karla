/**
 * The line level of the selection, resolved against live data; pure, so testable without mounting.
 */
import { getLineSign } from "./data/line-signs";
import type { Departure, DepartureBoard, TransitLine, TransitNetwork } from "./data/transit-types";
import { getResolvedBundledLineIds } from "./lib/line-bundles";
import { findLineForRoute, isSameLineFamily } from "./lib/line-families";
import { getTripLineId, type AppRoute } from "./routing";

/**
 * The line in view: running if this stop's board lists it, observation or not (how buses keep their
 * sign). A stop-scoped trip names no line, so its departure supplies one.
 */
export function findSelectedLine(
  route: AppRoute,
  network: TransitNetwork,
  departures: readonly Departure[],
  departureBoard: DepartureBoard | null,
  observedLine: TransitLine | undefined,
  stopDeparture: Departure | undefined,
): TransitLine | undefined {
  if (observedLine) return observedLine;

  const lineDeparture = route.lineId
    ? departures.find((departure) => isSameLineFamily(departure.lineId, route.lineId))
    : stopDeparture;
  if (lineDeparture)
    return getLineSign(network.lines, lineDeparture.lineId, lineDeparture.transportMode);

  // A restored ride keeps its line with a neutral sign until its retained run resolves.
  if (route.isRide && route.lineId) return getLineSign(network.lines, route.lineId, "other");

  // A stop-scoped trip past this stop is on no board here but names its line in its id; the line
  // holds as long as the trip does, so the line's readings can still find it.
  const tripLineId = route.addressId && !route.lineId ? getTripLineId(route.addressId) : "";
  if (tripLineId) {
    const sameLine = departures.find((departure) => isSameLineFamily(departure.lineId, tripLineId));
    return getLineSign(network.lines, tripLineId, sameLine?.transportMode ?? "other");
  }

  // An asked-for line keeps a neutral sign while the board loads or fails; only a readable board
  // without it drops it.
  const isBoardReadable = departureBoard?.dataStatus === "live";
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
  departureBoard: DepartureBoard | null,
): readonly TransitLine[] {
  if (!selectedLine || bundledLineIds.length === 0) return EMPTY_LINES;
  return getResolvedBundledLineIds(bundledLineIds, departureBoard).flatMap((lineId) => {
    if (isSameLineFamily(lineId, selectedLine.id)) return [];
    const running = departureBoard?.departures.find((departure) =>
      isSameLineFamily(departure.lineId, lineId),
    );
    const observed = findLineForRoute(network.lines, lineId);
    if (observed) return [observed];
    return running
      ? [getLineSign(network.lines, running.lineId, running.transportMode)]
      : [getLineSign(network.lines, lineId, "other")];
  });
}
