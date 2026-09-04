import type { Departure, TransitLine, TransitNetwork, TripCall } from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { findHomePlaceName, getStopPlaceQualifier } from "./stop-naming";
import { findStopByName } from "./stop-services";
import { getInterchangesAtStop, type InterchangeIndex } from "./interchanges";
import type { JoinedTripPortionPair } from "./joined-trip-portions";
import { isSameLineFamily } from "./line-families";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import {
  alignSameRouteCalls,
  collapseTurnaroundCalls,
  getCallKey,
  getTripCallInstant,
  statesRunEnd,
} from "./trip-calls";
import {
  createSoonestPassageComparator,
  getTripPlacement,
  type TripPlacementMotion,
  type TripPlacementPhase,
  type TripSegmentTrajectory,
} from "./vehicle-positioning";
import { getDistinctVehicleTrips, getVehicleTripKey, isSameVehicleTrip } from "./trips";
import { findTurnarounds, type TurnaroundIndex } from "./line-turnarounds";

const EMPTY_INTERCHANGES: readonly TransitLine[] = [];

export type LineDiagramStop = {
  stopName: string;
  /** The municipality, stated only where the stop name does not name one by itself. */
  placeName?: string;
  /**
   * Which platform of the stop this row is, stated only where the row above or below it is the
   * same stop — a route that reaches one stop twice, where the name alone says nothing about which
   * of the two a rider is looking at.
   */
  platformLabel?: string;
  interchanges: readonly TransitLine[];
  stopId: string;
  tripCall: TripCall;
};

export type LineDiagramVehicle = {
  departure: Departure;
  /** Both separately addressed portions while they still occupy one timed link. */
  joinedDepartures: readonly Departure[];
  /**
   * Stable render identity for the physical mark.
   *
   * It deliberately survives a joined working shedding one of its published portions and an
   * arriving run handing the terminus over to the departure it turns into. The passenger-facing
   * portions still live in `joinedDepartures`; putting all of them in this key made React remove
   * and re-enter a mark at exactly those continuous handovers, which looked like a vehicle blink.
   */
  markerKey: string;
  /**
   * The link the mark is on, as two rows of *this* diagram, and how far along it the mark stands.
   *
   * Named rather than folded into one continuous coordinate. The two are the same number where a
   * link joins adjacent rows, but the coordinate has to be taken apart again by everything that
   * reads it — the layer floors it to find the rows to interpolate between, the position control
   * rounds it to find the row to scroll to — and each of those is a second place that has to agree
   * about what the encoding meant. The link is the fact the placement actually states, so it is
   * what is carried.
   *
   * `toIndex` is above `fromIndex` for a mark running up the diagram, and the two need not be
   * adjacent: a working that skips stops this diagram draws is on a link that spans them.
   */
  fromIndex: number;
  toIndex: number;
  /** 0 at `fromIndex`, 1 at `toIndex`. */
  progress: number;
  /** The row that speaks for the mark: behind it while running, at the terminus after arrival. */
  rowIndex: number;
  /** A stable sideways lane among vehicles sharing this link and direction. */
  laneIndex: number;
  directionArrow: "↑" | "↓";
  /**
   * Where this trip is going, in the operator's own wording.
   *
   * Every mark carries one, and the diagram shows it only while the rider is pointing at that mark
   * or has tapped it: a line with Zwischenendstellen runs some of its trips over part of itself,
   * and which of the marks does that is a question only the mark can answer — but answering it on
   * twelve marks at once would make a line diagram into a column of destinations.
   */
  destinationLabel: string;
  /** What the mark is doing: running between two calls, or standing at an end of its run. */
  phase: TripPlacementPhase;
  /** Whether the mark travelled to this position or was put here — see `TripPlacement.motion`. */
  motion: TripPlacementMotion;
  /** One stable animation to the next stop, replaced only when its timing changes. */
  trajectory?: TripSegmentTrajectory;
  /** Any other trip on the line while one is being followed — tinted so the ride stands out. */
  isOtherTrip: boolean;
  isSelected: boolean;
};

export type LineDiagramVehicleOptions = {
  /** Share this across a bundled trunk and its legs; it changes only with the observations. */
  turnaroundIndex?: TurnaroundIndex;
  /**
   * Whether a trip that has not begun is drawn waiting at the stop it is due out of — the stand
   * read from the lead before its first departure, and from the arrival it turns out of where a
   * turnaround was found for it. On by default: it is the one thing that keeps a terminus from
   * standing empty between one run ending and the next setting out. Off, the diagram draws only
   * vehicles its calls place between stops, and the platform arbitration below has nothing left
   * to arbitrate.
   */
  showWaitingVehicles?: boolean;
};

type PlacedLineDiagramVehicle = {
  departure: Departure;
  /** Render identity after continuity across a paired turnaround has been resolved. */
  markerKey: string;
  fromIndex: number;
  toIndex: number;
  progress: number;
  rowIndex: number;
  linkKey: string;
  fromStopId: string;
  toStopId: string;
  directionArrow: "↑" | "↓";
  phase: TripPlacementPhase;
  motion: TripPlacementMotion;
  trajectory?: TripSegmentTrajectory;
  realtimeQuality: number;
};

/** Both portions of a joined mark are going somewhere; the mark names each end once. */
const getDestinationLabel = (portions: readonly Departure[]): string =>
  [...new Set(portions.map((portion) => portion.destination))].join(" / ");

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

export function buildLineDiagramStops(
  network: TransitNetwork,
  line: TransitLine,
  calls: readonly TripCall[],
  /** `null` beside a departure board, where the row has no width to state changes in. */
  interchangeIndex: InterchangeIndex | null,
): LineDiagramStop[] {
  // A turnaround is one call reported twice; every other repeat is a stop the route really does
  // reach twice, and drawing it once would take a link a rider rides off the diagram.
  const tripCalls = collapseTurnaroundCalls(calls);
  const homePlaceName = findHomePlaceName(tripCalls);
  const callKeys = tripCalls.map(getCallKey);
  const stops = tripCalls.map((tripCall, index) => {
    const stopId =
      tripCall.localStopId ??
      findStopByName(network, tripCall.stopName)?.id ??
      createStopSlug(tripCall.stopName);
    // Two rows of one stop, one under the other, are the diagram's least readable moment: at
    // Marktplatz the two names part them, at Europaplatz nothing does — the same name, the same
    // stop point, and a hundred metres of Kaiserstraße between them. The platform is what parts
    // them on the ground, so it is what parts them here, and only here: printed on every row it
    // would be a column of noise down a line that calls at each of its stops once.
    const isRepeatedStop =
      callKeys[index - 1] === callKeys[index] || callKeys[index + 1] === callKeys[index];

    return {
      stopName: tripCall.stopName,
      placeName: getStopPlaceQualifier(tripCall, homePlaceName),
      platformLabel: isRepeatedStop ? tripCall.platformLabel : undefined,
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
 * The whole line drawn out to the furthest run observed for it.
 *
 * The drawn chain stays what it is — the reading in hand, the one held so the rows do not move
 * under a rider walking along the line — and the run observed furthest is read into it around it:
 * the stops the drawn trip never reached go in past its ends, and the stops the drawn trip skipped
 * that the run calls at go in between its own. Both chains are in the diagram's own order, so
 * everything is read in where the two agree it belongs — a drawn-only call after the shared call it
 * was read behind, a run-only one into the gap it lies in. Nothing is lost, nothing doubled, and
 * where the two chains share nothing at all there is nothing that says how the one continues into
 * the other, so the drawn chain is left exactly as it was.
 */
export function extendLineDiagramCalls(
  drawnCalls: readonly TripCall[],
  farthestCalls: readonly TripCall[] | undefined,
): readonly TripCall[] {
  if (!farthestCalls?.length || drawnCalls.length === 0) return drawnCalls;
  // The two readings are aligned call by call rather than matched through their stops: a stop the
  // route reaches twice would otherwise anchor both of its calls to whichever came first.
  const anchors = alignSameRouteCalls(drawnCalls, farthestCalls);
  if (anchors.length === 0) return drawnCalls;

  const merged: TripCall[] = [];
  let drawnCursor = 0;
  let farthestCursor = 0;
  for (const [drawnAnchor, farthestAnchor] of anchors) {
    merged.push(
      ...farthestCalls.slice(farthestCursor, farthestAnchor),
      ...drawnCalls.slice(drawnCursor, drawnAnchor),
      drawnCalls[drawnAnchor],
    );
    drawnCursor = drawnAnchor + 1;
    farthestCursor = farthestAnchor + 1;
  }
  return [...merged, ...drawnCalls.slice(drawnCursor), ...farthestCalls.slice(farthestCursor)];
}

/**
 * Selects vehicle observations once per board refresh. Position updates can then reuse this stable
 * list each second instead of repeatedly flattening and deduplicating every board.
 *
 * `readAt` is what decides a contest between two boards' copies of one vehicle: the freshest board
 * wins, so a mark is drawn from the newest reading of its trip rather than from whichever board the
 * caller happens to hold first — the observation posts along a line answer far more slowly than the
 * boards on the line itself, and the same trip is usually on both.
 */
export function getLineDiagramVehicleDepartures(
  selection: LineSelection,
  departures: readonly Departure[],
  readAt?: (departure: Departure) => number,
): Departure[] {
  return getDistinctVehicleTrips(
    departures.filter((departure) => isSelectedLine(selection, departure.lineId)),
    readAt,
  );
}

/**
 * The two rows a placed link falls on, where a chain names the same stop more than once.
 *
 * A `Map` of stop to row answers with whichever occurrence it happened to keep, and on a chain that
 * passes a stop twice — a working that runs through its own loop, a variant timed into a complex at
 * two of its points — that is a mark placed half a diagram away from the link it is on, and slid
 * there from wherever it stood. The link is the fact in hand, so both ends are resolved together:
 * of every pair of rows those two stops occur at, the closest one is the link the vehicle is on.
 * A chain naming each stop once — every ordinary one — has exactly one pair and this is the answer
 * it already gave.
 *
 * Where two pairs are equally close the feed has not said which of them it means, and this does not
 * pretend to know: the earlier link is taken. Both name the two stops the vehicle is between, which
 * is as much as the reading supports, and the mark stays on a link it could be on either way.
 */
function findDiagramLink(
  rowsByStopId: ReadonlyMap<string, readonly number[]>,
  fromStopId: string,
  toStopId: string,
): { fromIndex: number; toIndex: number } | undefined {
  let link: { fromIndex: number; toIndex: number } | undefined;
  for (const fromIndex of rowsByStopId.get(fromStopId) ?? []) {
    for (const toIndex of rowsByStopId.get(toStopId) ?? []) {
      if (fromIndex === toIndex) continue;
      const isCloser =
        !link || Math.abs(toIndex - fromIndex) < Math.abs(link.toIndex - link.fromIndex);
      if (isCloser) link = { fromIndex, toIndex };
    }
  }
  return link;
}

/**
 * A mark's link read back as one continuous row coordinate: whole numbers on rows, fractions
 * between them. What draws the mark needs a number, and so does anything asking how far down the
 * diagram it has got — but it is derived where it is needed rather than stored, so there is one
 * statement of what the encoding means instead of one per reader.
 */
export const getVehicleRowCoordinate = ({
  fromIndex,
  toIndex,
  progress,
}: Pick<LineDiagramVehicle, "fromIndex" | "toIndex" | "progress">): number =>
  fromIndex + (toIndex - fromIndex) * progress;

/**
 * Whether the platform this trip is waiting to leave from still belongs to a vehicle on its way in.
 *
 * A waiting mark is the one placement drawn from a timetable rather than from a position, so it is
 * the one that can put a vehicle where none is. The check is deliberately narrow: only a run the
 * feed itself says *ends* at that stop counts, only while it is still due in, and only where it is
 * due in at or before the waiting trip is due away — a run arriving after this one has left is the
 * next hour's business and says nothing about the platform now.
 */
function isRunStillDueIn(
  departures: readonly Departure[],
  waiting: PlacedLineDiagramVehicle,
  feedNow: number,
): boolean {
  const leavesAt = getTripCallInstant(waiting.departure.tripCalls?.[0]);
  if (leavesAt === undefined) return false;
  return departures.some((departure) => {
    if (isSameVehicleTrip(departure, waiting.departure)) return false;
    const calls = departure.tripCalls ?? [];
    const finalCall = calls[calls.length - 1];
    if (!statesRunEnd(finalCall) || finalCall.localStopId !== waiting.fromStopId) return false;
    const arrivesAt = getTripCallInstant(finalCall, "arrival");
    return arrivesAt !== undefined && arrivesAt <= leavesAt && feedNow < arrivesAt;
  });
}

/** Every row each stop occupies, since a chain may name one stop more than once. */
function getRowsByStopId(
  diagramStops: readonly LineDiagramStop[],
): ReadonlyMap<string, readonly number[]> {
  const rowsByStopId = new Map<string, number[]>();
  for (const [index, stop] of diagramStops.entries()) {
    const rows = rowsByStopId.get(stop.stopId);
    if (rows) rows.push(index);
    else rowsByStopId.set(stop.stopId, [index]);
  }
  return rowsByStopId;
}

/** Every observed vehicle whose current link exists in this diagram, on the rows it falls on. */
function placeVehicles(
  rowsByStopId: ReadonlyMap<string, readonly number[]>,
  vehicleDepartures: readonly Departure[],
  turnarounds: TurnaroundIndex,
  feedNow: number,
): PlacedLineDiagramVehicle[] {
  // A turn is published as two trips but is drawn as one vehicle. Key both halves by the outgoing
  // run: before the arrival reaches the terminus that key belongs to its approaching mark; after
  // the handover it belongs to the standing/outgoing mark. React therefore keeps the same element
  // and the marker neither fades out nor fades back in at the platform.
  const turningKeyByTripKey = new Map<string, string>();
  for (const [arrivalKey, departureKey] of turnarounds.turningDepartureKeyByArrivalKey) {
    turningKeyByTripKey.set(arrivalKey, departureKey);
    turningKeyByTripKey.set(departureKey, departureKey);
  }
  const placed: PlacedLineDiagramVehicle[] = [];
  for (const candidate of [...vehicleDepartures].sort(createSoonestPassageComparator(feedNow))) {
    const placement = getTripPlacement(
      candidate,
      feedNow,
      turnarounds.standFromByDepartureKey.get(getVehicleTripKey(candidate)),
    );
    if (!placement) continue;
    const link = findDiagramLink(rowsByStopId, placement.fromStopId, placement.toStopId);
    if (!link) continue;

    const { fromIndex, toIndex } = link;
    placed.push({
      departure: candidate,
      markerKey:
        turningKeyByTripKey.get(getVehicleTripKey(candidate)) ?? getVehicleTripKey(candidate),
      fromIndex,
      toIndex,
      progress: placement.progress,
      // A finished run is drawn at the far end of its last link, so its "ends here" label belongs
      // to that stop. Running marks remain attached to the link's preceding row as before.
      rowIndex: placement.phase === "afterEnd" ? toIndex : fromIndex,
      linkKey: `${fromIndex}:${toIndex}`,
      fromStopId: placement.fromStopId,
      toStopId: placement.toStopId,
      directionArrow: toIndex > fromIndex ? "↓" : "↑",
      phase: placement.phase,
      motion: placement.motion,
      trajectory: placement.trajectory,
      realtimeQuality: getRealtimeQuality(candidate),
    });
  }
  return placed;
}

/**
 * The marks left once one platform holds one mark, and none holds a vehicle that is not on it yet.
 *
 * The arriving half of a stand the diagram is already drawing as the departure that turns out of it
 * goes first — but only once that departure is really on the diagram, and only once the arrival has
 * stopped running: until then it is a vehicle of its own, wherever it is.
 *
 * A trip waiting to set out is drawn for the lead before it is due away (`vehicle-positioning.ts`)
 * whether or not the arrival it turns out of was ever found, and that lead is long enough to reach
 * back over the run before it. Two things follow, and the platform answers both:
 *
 *   - a run that has just ended standing at the stop a run that has not begun is drawn at, which is
 *     two marks where a rider sees one tram. The arrival is the half somebody watched pull in, so
 *     the inference gives way to it. Where the two were paired the arrival is already gone above and
 *     the departure carries the whole stand, which is the better reading of the same platform;
 *   - a lead that starts before the vehicle is even due in. A terminus that turns on the instant —
 *     line 1's diversion at Wolfartsweier Nord, a tram in and a tram out at the same second — has
 *     nothing standing on it for the nine minutes before that second, and the outgoing trip's own
 *     calls do not say otherwise. So a waiting mark stands down while another run is still due into
 *     that stop at or before it is due away: the vehicle the platform is waiting for is out on the
 *     line, and the stand begins when it arrives.
 *
 * Both are read from the ends of runs the diagram already has in hand, and neither claims the two
 * trips are one vehicle — that claim is the turnaround pairing's alone, and it is made above.
 */
function arbitratePlatforms(
  placed: readonly PlacedLineDiagramVehicle[],
  vehicleDepartures: readonly Departure[],
  turnarounds: TurnaroundIndex,
  feedNow: number,
  showWaitingVehicles: boolean,
): PlacedLineDiagramVehicle[] {
  const placedKeys = new Set(placed.map(({ departure }) => getVehicleTripKey(departure)));
  const afterTurnarounds = placed.filter(({ departure, phase }) => {
    const turningKey = turnarounds.turningDepartureKeyByArrivalKey.get(
      getVehicleTripKey(departure),
    );
    return !(phase === "afterEnd" && turningKey !== undefined && placedKeys.has(turningKey));
  });
  if (!showWaitingVehicles) {
    return afterTurnarounds.filter(({ phase }) => phase !== "beforeStart");
  }

  const endedStopIds = new Set(
    afterTurnarounds.flatMap(({ phase, toStopId }) => (phase === "afterEnd" ? [toStopId] : [])),
  );
  return afterTurnarounds.filter((placement) => {
    if (placement.phase !== "beforeStart") return true;
    if (endedStopIds.has(placement.fromStopId)) return false;
    return !isRunStillDueIn(vehicleDepartures, placement, feedNow);
  });
}

/**
 * One mark per vehicle: both portions of a joined working share theirs while they share a link.
 *
 * EFA can monitor one portion while giving the other no valid call times at all. One placeable
 * portion therefore represents both while its current link is still inside their proven shared
 * prefix. Past the terminating trip's final call, the continuing portion stands alone.
 */
function mergeJoinedPortions(
  drawn: readonly PlacedLineDiagramVehicle[],
  joinedPairs: readonly JoinedTripPortionPair[],
  selectedDeparture: Departure | undefined,
): LineDiagramVehicle[] {
  const joinedByDeparture = new Map<Departure, JoinedTripPortionPair>();
  for (const joined of joinedPairs) {
    joinedByDeparture.set(joined.terminating, joined);
    joinedByDeparture.set(joined.continuing, joined);
  }
  const placementByDeparture = new Map(drawn.map((placement) => [placement.departure, placement]));
  const consumed = new Set<Departure>();
  const laneCountByLink = new Map<string, number>();
  const vehicles: LineDiagramVehicle[] = [];

  for (const candidate of drawn) {
    if (consumed.has(candidate.departure)) continue;
    const joined = joinedByDeparture.get(candidate.departure);
    const otherDeparture = joined
      ? isSameVehicleTrip(candidate.departure, joined.terminating)
        ? joined.continuing
        : joined.terminating
      : undefined;
    const other = otherDeparture ? placementByDeparture.get(otherDeparture) : undefined;
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
      // A joined working is one mark while its portions share the train. Its continuing portion is
      // the identity that survives their split, so keep that identity while they are together as
      // well. At the split React retains the continuing mark and only the genuinely new second
      // mark enters; the old composite no longer vanishes and reappears under another key.
      markerKey:
        isTogether && joined
          ? (placementByDeparture.get(joined.continuing)?.markerKey ??
            getVehicleTripKey(joined.continuing))
          : representative.markerKey,
      fromIndex: representative.fromIndex,
      toIndex: representative.toIndex,
      progress: representative.progress,
      rowIndex: representative.rowIndex,
      laneIndex,
      directionArrow: representative.directionArrow,
      destinationLabel: getDestinationLabel(portions),
      phase: representative.phase,
      motion: representative.motion,
      trajectory: representative.trajectory,
      isOtherTrip: Boolean(selectedDeparture) && !isSelected,
      isSelected,
    });
  }
  return vehicles;
}

/** Places the observed vehicles whose current link exists in this diagram. */
export function getLineDiagramVehicles(
  diagramStops: readonly LineDiagramStop[],
  vehicleDepartures: readonly Departure[],
  joinedPairs: readonly JoinedTripPortionPair[],
  selectedDeparture: Departure | undefined,
  feedNow: number,
  { turnaroundIndex, showWaitingVehicles = true }: LineDiagramVehicleOptions = {},
): LineDiagramVehicle[] {
  // A vehicle turning at a terminus is two trips in the feed and one thing on the platform. The
  // stand is drawn once, as the departure that leaves it — see `lib/line-turnarounds.ts` for what
  // that pairing does and does not claim.
  const turnarounds = turnaroundIndex ?? findTurnarounds(vehicleDepartures);
  const placed = placeVehicles(
    getRowsByStopId(diagramStops),
    vehicleDepartures,
    turnarounds,
    feedNow,
  );
  const drawn = arbitratePlatforms(
    placed,
    vehicleDepartures,
    turnarounds,
    feedNow,
    showWaitingVehicles,
  );
  return mergeJoinedPortions(drawn, joinedPairs, selectedDeparture);
}

/**
 * The stop row an explicit "show position" action should reveal. A placed vehicle wins, rounded to
 * the row its coordinate is nearest — a real row, so scrolling is never coupled to the absolutely
 * positioned mark, and any row the mark's link spans rather than only the two it ends at. Before the
 * vehicle can be placed, its next timed call is the best available position reading.
 */
export function getTripPositionAnchorIndex(
  diagramStops: readonly LineDiagramStop[],
  vehicles: readonly LineDiagramVehicle[],
  nextCall: TripCall | undefined,
): number {
  const selectedVehicle = vehicles.find((vehicle) => vehicle.isSelected);
  if (selectedVehicle && diagramStops.length > 0) {
    const nearest = Math.round(getVehicleRowCoordinate(selectedVehicle));
    return Math.max(0, Math.min(diagramStops.length - 1, nearest));
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
  // first: it is the best chain to start from, and the one a whole-line view is extended around to
  // the furthest observed run (`extendLineDiagramCalls`).
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
 * The boarding stop answers the case the address cannot: a stop-complex page listing a
 * departure that physically leaves from one of its other points, where the chain names that point's
 * own local stop and the address names the complex. That is a stop the rider arrived at rather than walked to, so
 * there is no note travelling anywhere and nothing to blink.
 */
export function getCurrentStopIndex(
  diagramStops: readonly LineDiagramStop[],
  stopId: string,
  /** Local, because the rows are: a provider stop point id matches no `stopId` of this chain. */
  boardingLocalStopId: string | undefined,
): number {
  const addressed = diagramStops.findIndex((diagramStop) => diagramStop.stopId === stopId);
  if (addressed >= 0 || !boardingLocalStopId) return addressed;
  return diagramStops.findIndex((diagramStop) => diagramStop.stopId === boardingLocalStopId);
}

/**
 * Whether one diagram row is an occurrence of the stop the rider has open.
 *
 * The address names a unified stop rather than one occurrence in a particular trip. If the route
 * reaches that stop twice, both rows are therefore current. The first occurrence remains the
 * placement anchor returned above; this only answers how every row is presented.
 */
export function isCurrentLineDiagramStop(
  diagramStops: readonly LineDiagramStop[],
  currentStopIndex: number,
  rowIndex: number,
): boolean {
  const currentStopId = diagramStops[currentStopIndex]?.stopId;
  return currentStopId !== undefined && diagramStops[rowIndex]?.stopId === currentStopId;
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
  for (const { rowIndex, departure, joinedDepartures, phase } of vehicles) {
    const destinations = [...new Set(joinedDepartures.map((portion) => portion.destination))];
    const heading = `${departure.lineId} Richtung ${destinations.join(" und ")}`;
    // A standing mark is spoken as what it is. Neither end of a run is a measured position, and
    // saying "geschätzte Position" of a trip that has not begun would claim a vehicle is here.
    const label =
      phase === "beforeStart"
        ? `nächste Abfahrt von ${heading}`
        : phase === "afterEnd"
          ? `Fahrt von ${heading} endet hier`
          : `geschätzte Position von ${heading}`;
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
