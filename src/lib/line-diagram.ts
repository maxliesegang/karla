import type { Departure, TransitLine, TransitNetwork, TripCall } from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { findHomePlaceName, getStopPlaceQualifier } from "./stop-naming";
import { findStopByName } from "./stop-services";
import { getInterchangesAtStop, type InterchangeIndex } from "./interchanges";
import type { JoinedTripPortionPair } from "./joined-trip-portions";
import { isSameLineFamily } from "./line-families";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import { getCallKey } from "./trip-calls";
import { createSoonestPassageComparator, getSmoothTripPlacement } from "./vehicle-positioning";
import { getDistinctVehicleTrips, getVehicleTripKey, isSameVehicleTrip } from "./trips";

const EMPTY_INTERCHANGES: readonly TransitLine[] = [];

export type LineDiagramStop = {
  stopName: string;
  /** The municipality, stated only where the stop name does not name one by itself. */
  placeName?: string;
  interchanges: readonly TransitLine[];
  stopId: string;
  tripCall: TripCall;
};

export type LineDiagramVehicle = {
  departure: Departure;
  /** Both separately addressed portions while they still occupy one timed link. */
  joinedDepartures: readonly Departure[];
  /** Render identity including every portion represented by a composite mark. */
  markerKey: string;
  /** One continuous coordinate along the visible stop rows. */
  diagramPosition: number;
  /** The call behind the vehicle, used to include its estimate in that row's spoken label. */
  rowIndex: number;
  /** A stable sideways lane among vehicles sharing this link and direction. */
  laneIndex: number;
  directionArrow: "↑" | "↓";
  /** Any other trip on the line while one is being followed — tinted so the ride stands out. */
  isOtherTrip: boolean;
  isSelected: boolean;
};

type PlacedLineDiagramVehicle = {
  departure: Departure;
  diagramPosition: number;
  rowIndex: number;
  linkKey: string;
  fromStopId: string;
  toStopId: string;
  directionArrow: "↑" | "↓";
  realtimeQuality: number;
};

const getRealtimeQuality = (departure: Departure): number =>
  (departure.predictedDepartureTime ? 1 : 0) +
  (departure.tripCalls?.filter(({ delayMinutes }) => delayMinutes !== undefined).length ?? 0);

function isOnSharedLink(
  placement: PlacedLineDiagramVehicle,
  joined: JoinedTripPortionPair,
): boolean {
  const calls = placement.departure.tripCalls ?? [];
  const sharedEndIndex = calls.findIndex(
    (call) => getCallKey(call) === getCallKey(joined.sharedUntil),
  );
  const linkIndex = calls.findIndex(
    (call, index) =>
      call.localStopId === placement.fromStopId &&
      calls[index + 1]?.localStopId === placement.toStopId,
  );
  return sharedEndIndex >= 0 && linkIndex >= 0 && linkIndex < sharedEndIndex;
}

/**
 * One row per stop of the route, where the sequence states a stop twice in a row.
 *
 * A stop complex is published as its stop points, and a trip that turns back at one is timed into
 * the platform it arrives on and out of the platform it leaves from — currently line 1 on its
 * Heide diversion, arriving at Neureut-Heide Gleis 1 and standing again at Gleis 2 two minutes
 * later. Those are one call of the route, and drawn as two they are a stop the line appears to
 * serve twice, with a final link whose two ends are the same row and which therefore carries no
 * mark at all. The call the vehicle reaches the stop at is the one kept, which is the same rule
 * `getCallsAfterStop` reads a route onwards by.
 */
const collapseRepeatedCalls = (tripCalls: readonly TripCall[]): readonly TripCall[] =>
  tripCalls.filter(
    (call, index) => index === 0 || getCallKey(tripCalls[index - 1]) !== getCallKey(call),
  );

export function buildLineDiagramStops(
  network: TransitNetwork,
  line: TransitLine,
  calls: readonly TripCall[],
  /** `null` beside a departure board, where the row has no width to state changes in. */
  interchangeIndex: InterchangeIndex | null,
): LineDiagramStop[] {
  const tripCalls = collapseRepeatedCalls(calls);
  const homePlaceName = findHomePlaceName(tripCalls);
  const stops = tripCalls.map((tripCall) => {
    const stopId =
      tripCall.localStopId ??
      findStopByName(network, tripCall.stopName)?.id ??
      createStopSlug(tripCall.stopName);

    return {
      stopName: tripCall.stopName,
      placeName: getStopPlaceQualifier(tripCall, homePlaceName),
      interchanges: interchangeIndex
        ? getInterchangesAtStop(
            interchangeIndex,
            network,
            { id: stopId, name: tripCall.stopName },
            line.id,
          )
        : EMPTY_INTERCHANGES,
      stopId,
      tripCall,
    };
  });
  return stops;
}

/**
 * Selects vehicle observations once per board refresh. Position updates can then reuse this stable
 * list each second instead of repeatedly flattening and deduplicating every board.
 */
export function getLineDiagramVehicleDepartures(
  selection: LineSelection,
  departures: readonly Departure[],
): Departure[] {
  return getDistinctVehicleTrips(
    departures.filter((departure) => isSelectedLine(selection, departure.lineId)),
  );
}

/** Places the observed vehicles whose current link exists in this diagram. */
export function getLineDiagramVehicles(
  diagramStops: readonly LineDiagramStop[],
  vehicleDepartures: readonly Departure[],
  joinedPairs: readonly JoinedTripPortionPair[],
  selectedDeparture: Departure | undefined,
  feedNow: number,
): LineDiagramVehicle[] {
  const stopIndexById = new Map(diagramStops.map((stop, index) => [stop.stopId, index]));
  const placed: PlacedLineDiagramVehicle[] = [];

  for (const candidate of [...vehicleDepartures].sort(createSoonestPassageComparator(feedNow))) {
    const placement = getSmoothTripPlacement(candidate, feedNow);
    if (!placement) continue;

    const fromIndex = stopIndexById.get(placement.fromStopId);
    const toIndex = stopIndexById.get(placement.toStopId);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) continue;

    const directionStep = toIndex > fromIndex ? 1 : -1;
    const directionArrow = directionStep > 0 ? "↓" : "↑";
    const linkKey = `${fromIndex}:${toIndex}`;
    placed.push({
      departure: candidate,
      diagramPosition: fromIndex + (toIndex - fromIndex) * placement.progress,
      rowIndex: fromIndex,
      linkKey,
      fromStopId: placement.fromStopId,
      toStopId: placement.toStopId,
      directionArrow,
      realtimeQuality: getRealtimeQuality(candidate),
    });
  }

  const joinedByDeparture = new Map<Departure, JoinedTripPortionPair>();
  for (const joined of joinedPairs) {
    joinedByDeparture.set(joined.terminating, joined);
    joinedByDeparture.set(joined.continuing, joined);
  }
  const placementByDeparture = new Map(placed.map((placement) => [placement.departure, placement]));
  const consumed = new Set<Departure>();
  const laneCountByLink = new Map<string, number>();
  const vehicles: LineDiagramVehicle[] = [];

  for (const candidate of placed) {
    if (consumed.has(candidate.departure)) continue;
    const joined = joinedByDeparture.get(candidate.departure);
    const otherDeparture = joined
      ? isSameVehicleTrip(candidate.departure, joined.terminating)
        ? joined.continuing
        : joined.terminating
      : undefined;
    const other = otherDeparture ? placementByDeparture.get(otherDeparture) : undefined;
    // EFA can monitor one portion while giving the other no valid call times at all. One placeable
    // portion therefore represents both while its current link is still inside their proven shared
    // prefix. Past the terminating trip's final call, the continuing portion stands alone.
    const isTogether = Boolean(
      joined &&
        isOnSharedLink(candidate, joined) &&
        (!other || (other.linkKey === candidate.linkKey && isOnSharedLink(other, joined))),
    );
    const portions =
      isTogether && otherDeparture ? [candidate.departure, otherDeparture] : [candidate.departure];
    if (isTogether && other) consumed.add(other.departure);
    consumed.add(candidate.departure);

    const representative =
      isTogether && other && other.realtimeQuality > candidate.realtimeQuality ? other : candidate;
    const laneIndex = laneCountByLink.get(representative.linkKey) ?? 0;
    laneCountByLink.set(representative.linkKey, laneIndex + 1);
    const isSelected = portions.some((departure) =>
      isSameVehicleTrip(departure, selectedDeparture),
    );
    vehicles.push({
      departure: representative.departure,
      joinedDepartures: portions,
      markerKey: portions.map(getVehicleTripKey).sort().join("+"),
      diagramPosition: representative.diagramPosition,
      rowIndex: representative.rowIndex,
      laneIndex,
      directionArrow: representative.directionArrow,
      isOtherTrip: Boolean(selectedDeparture) && !isSelected,
      isSelected,
    });
  }

  return vehicles;
}

/**
 * The stop row an explicit "show position" action should reveal. A placed vehicle wins; rounding
 * its continuous coordinate chooses the nearest real row without coupling scrolling to the
 * absolutely positioned mark. Before the vehicle can be placed, its next timed call is the best
 * available position reading.
 */
export function getTripPositionAnchorIndex(
  diagramStops: readonly LineDiagramStop[],
  vehicles: readonly LineDiagramVehicle[],
  nextCall: TripCall | undefined,
): number {
  const selectedVehicle = vehicles.find((vehicle) => vehicle.isSelected);
  if (selectedVehicle && diagramStops.length > 0) {
    return Math.max(
      0,
      Math.min(diagramStops.length - 1, Math.round(selectedVehicle.diagramPosition)),
    );
  }
  if (!nextCall) return -1;
  return diagramStops.findIndex(({ tripCall }) => getCallKey(tripCall) === getCallKey(nextCall));
}

/** The changes at a stop, spoken: the lines to change to, or nothing where there are none. */
export function getInterchangeLabel(interchanges: readonly TransitLine[]): string | undefined {
  return interchanges.length
    ? `Umstieg zu ${interchanges.map(({ id }) => id).join(", ")}`
    : undefined;
}

/**
 * The trip the line itself is drawn from, and why it is held rather than chosen again at every stop.
 *
 * A pinned trip draws itself. Without one the diagram is the line, and the only thing a trip
 * contributes is its stop chain — which stops, in which order, and therefore which way up the line
 * is drawn. Every stop of a line has trips running both ways past it, so choosing again at each one
 * turned the line around under a rider who had only stepped along it: the chain reversed, and with
 * it the coordinate system every mark, every scroll position and the rider's own note is measured
 * in. The step read as an arrival at a different diagram, which is exactly what it is not.
 *
 * So the trip that drew the line goes on drawing it for as long as it calls at the stop the rider
 * has walked to. The chain is then literally the same chain, the diagram does not move, and the
 * note under the stop name travelling to its new row is the whole of what the step looks like.
 * Where the held trip cannot draw the rider's stop there is nothing to hold on to and the line is
 * chosen afresh — pointed the way it was last read, so even that keeps its direction.
 */
export function chooseLineDiagramTrip({
  lineId,
  riderStopIds,
  pinnedDeparture,
  heldDeparture,
  preferredDestination,
  stopTripDepartures,
  boardDepartures,
}: {
  lineId: string;
  /**
   * The rider's own stop, as every id that names it: the stop the address states, and — where a
   * board row leaves from one of a complex's other stop points — that point as well. A held trip
   * draws the line only while it still calls at the rider's stop, and which of the two ids the
   * chain happens to use is not something the hold should turn on.
   */
  riderStopIds: readonly string[];
  /** The trip the address names, which states its own direction and needs no holding. */
  pinnedDeparture: Departure | undefined;
  /** What the line was drawn from at the last reading of this diagram. */
  heldDeparture: Departure | undefined;
  /** Where the rider was last heading on this line, as the selection chain remembers it. */
  preferredDestination: string | undefined;
  /** Whole trips read at the rider's stop: the only candidates with a chain to draw. */
  stopTripDepartures: readonly Departure[];
  /** The plain board, which answers before the trips do and can at least state a direction. */
  boardDepartures: readonly Departure[];
}): Departure | undefined {
  if (pinnedDeparture) return pinnedDeparture;
  if (heldDeparture && callsAtStop(heldDeparture, lineId, riderStopIds)) return heldDeparture;

  // Among the trips heading that way it is the one that runs furthest, not the one that leaves
  // first. Drawn from a short working the line stops short of its own ends, and every vehicle out
  // beyond them is a vehicle this view cannot place at all.
  const heading = preferredDestination ?? heldDeparture?.destination;
  const ofLine = (candidates: readonly Departure[]) =>
    candidates.filter((candidate) => isSameLineFamily(candidate.lineId, lineId));
  const furthestRunning = (candidates: readonly Departure[]) =>
    candidates.reduce<Departure | undefined>(
      (furthest, candidate) =>
        (candidate.tripCalls?.length ?? 0) > (furthest?.tripCalls?.length ?? 0)
          ? candidate
          : furthest,
      candidates[0],
    );
  const preferred = (candidates: readonly Departure[]) => {
    const sameWay = candidates.filter((candidate) => candidate.destination === heading);
    return furthestRunning(sameWay.length > 0 ? sameWay : candidates);
  };
  // A row whose whole trip has been read is taken over one from the plain board even when the plain
  // board has a better-matching headsign — without a calling sequence there is no diagram at all.
  const loadedTrips = ofLine(stopTripDepartures).filter((candidate) => candidate.tripCalls?.length);
  return preferred(loadedTrips) ?? preferred(ofLine(boardDepartures));
}

const callsAtStop = (departure: Departure, lineId: string, stopIds: readonly string[]): boolean =>
  isSameLineFamily(departure.lineId, lineId) &&
  Boolean(
    departure.tripCalls?.some((call) => call.localStopId && stopIds.includes(call.localStopId)),
  );

/**
 * Which row of the drawn line is the rider's own stop.
 *
 * The address is asked first, and it is asked because it is the one statement of the rider's stop
 * that does not blink. Walking along the line re-keys every board behind the trip, so the departure
 * the row was read from — and with it the stop point it names — is absent for as long as the new
 * stop's boards take to answer. Deciding the row from that alone let the note under the stop name
 * move twice for one step: once to the row the rider tapped, and again when a board came back
 * naming a stop point of the same complex, which is not a row of this chain at all. The rider
 * tapped a row of this diagram, so the address always names one.
 *
 * The boarding stop point answers the case the address cannot: a stop-complex page listing a
 * departure that physically leaves from one of its other points, where the chain names the point
 * and the address names the complex. That is a stop the rider arrived at rather than walked to, so
 * there is no note travelling anywhere and nothing to blink.
 */
export function getCurrentStopIndex(
  diagramStops: readonly LineDiagramStop[],
  stopId: string,
  boardingStopPointId: string | undefined,
): number {
  const addressed = diagramStops.findIndex((diagramStop) => diagramStop.stopId === stopId);
  if (addressed >= 0 || !boardingStopPointId) return addressed;
  return diagramStops.findIndex((diagramStop) => diagramStop.stopId === boardingStopPointId);
}

/**
 * The identity of a stop chain, which is what a set of drawn marks means.
 *
 * A mark's coordinate is an index into these rows, so a different chain — another line, the other
 * direction, a variant calling elsewhere — is a different coordinate system and the same number
 * points somewhere else in it. The trunk and every leg key their measurements and their marker
 * layer by this, so a chain that changes is placed afresh rather than slid across.
 */
export const getLineDiagramCoordinateKey = (
  lineId: string,
  diagramStops: readonly LineDiagramStop[],
): string => `${lineId}:${diagramStops.map(({ stopId }) => stopId).join(">")}`;

/**
 * What each row says about the vehicles standing behind it, one sentence per row.
 *
 * Spoken per row rather than handed over as marks: a sentence compares as a value, so a row whose
 * marks have not changed is not re-rendered by a tick that only moved one somewhere else.
 */
export function getVehicleLabelsByRowIndex(
  vehicles: readonly LineDiagramVehicle[],
): ReadonlyMap<number, string> {
  const labelByRowIndex = new Map<number, string>();
  for (const { rowIndex, departure, joinedDepartures } of vehicles) {
    const destinations = [...new Set(joinedDepartures.map((portion) => portion.destination))];
    const label = `geschätzte Position von ${departure.lineId} Richtung ${destinations.join(" und ")}`;
    const existing = labelByRowIndex.get(rowIndex);
    labelByRowIndex.set(rowIndex, existing ? `${existing}, ${label}` : label);
  }
  return labelByRowIndex;
}

/** Every line portion a set of diagrams currently carries a mark for. */
export const countLineDiagramVehicles = (
  vehicleLists: readonly (readonly LineDiagramVehicle[])[],
): number =>
  vehicleLists.reduce(
    (total, vehicles) =>
      total + vehicles.reduce((count, { joinedDepartures }) => count + joinedDepartures.length, 0),
    0,
  );
