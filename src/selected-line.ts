/**
 * The line level of the selection chain, resolved against live data.
 *
 * Kept apart from `selection.ts` because it is pure: which line an address stands for is a fact
 * about the address and the boards in hand, testable without mounting anything.
 */
import { getLineSign } from "./data/line-signs";
import type { Departure, DepartureBoard, TransitLine, TransitNetwork } from "./data/transit-types";
import { isSameLineFamily } from "./lib/line-families";
import { getTripLineId, type AppRoute } from "./routing";

/**
 * The line in view. A line is running here if this stop's own board says so, whether or not the
 * Zentrum observation covers it — that is how a bus keeps its sign. A stop-scoped trip address
 * names no line at all, so the departure it resolves to supplies one.
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

  // A ride can restore its saved run after a reload even when the current observation no longer
  // sees that line. The retained departure supplies the run below; this neutral sign only keeps
  // the line level available long enough for that honest observation to resolve.
  if (route.isRide && route.lineId) return getLineSign(network.lines, route.lineId, "other");

  // A stop-scoped trip that has left this stop is on no board here, but it is still running and is
  // read along its line — which it names in its own identity. The line holds for as long as the
  // address names the trip, so it is the trip level that decides when both go; dropping the line
  // with the row would stop the very readings that still find the trip, and land on the bare stop.
  const tripLineId = route.addressId && !route.lineId ? getTripLineId(route.addressId) : "";
  if (tripLineId) {
    const sameLine = departures.find((departure) => isSameLineFamily(departure.lineId, tripLineId));
    return getLineSign(network.lines, tripLineId, sameLine?.transportMode ?? "other");
  }

  // While the board is loading or the feed is down, an asked-for line keeps a neutral sign rather
  // than collapsing the view. Only a readable board that does not list it drops it.
  const isBoardReadable = departureBoard?.dataStatus === "live";
  return route.lineId && !isBoardReadable
    ? getLineSign(network.lines, route.lineId, "other")
    : undefined;
}
