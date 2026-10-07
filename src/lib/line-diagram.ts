import type { Departure, TransitNetwork, TripCall } from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { findHomePlaceName, getStopPlaceQualifier } from "./stop-naming";
import { findStopByName } from "./stop-services";
import type { JoinedRunPortionPair } from "./joined-run-portions";
import { isSameLineFamily } from "./line-families";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import {
  alignSameRouteCalls,
  collapseTurnaroundCalls,
  getCallKey,
  getTripCallInstant,
  runsInOrderOf,
  statesRunEnd,
} from "./trip-calls";
import { compareGermanNames } from "./text";
import {
  createSoonestPassageComparator,
  getRunPlacement,
  type RunMotions,
  type RunPlacementMotion,
  type RunPlacementPhase,
  type RunSegmentTrajectory,
} from "./vehicle-positioning";
import { getDistinctRuns, getRunMarkKey, isSameRun } from "./trips";
import { findTurnarounds, type TurnaroundIndex } from "./line-turnarounds";
import { getVehiclePositionSourceLabel } from "./vehicle-position-presentation";

export type LineDiagramStop = {
  stopName: string;
  /** The municipality, only where the stop name does not name one. */
  placeName?: string;
  /**
   * Which platforms of the stop this row is, only where a neighbouring row is the same stop: the
   * drawn trip's, plus those observed runs either way use there.
   */
  platformLabels?: readonly string[];
  stopId: string;
  tripCall: TripCall;
};

export type LineDiagramVehicle = {
  departure: Departure;
  /** Both separately addressed portions while they still occupy one timed link. */
  joinedDepartures: readonly Departure[];
  /**
   * Stable render identity for the physical mark. It survives a joined working shedding a portion
   * and an arrival turning into its departure, so React does not re-mount the mark at either.
   */
  markerKey: string;
  /**
   * The link the mark is on, as two rows of this diagram. `toIndex` is above `fromIndex` for a mark
   * running up the diagram, and the two need not be adjacent.
   */
  fromIndex: number;
  toIndex: number;
  fromStopId?: string;
  toStopId?: string;
  /** 0 at `fromIndex`, 1 at `toIndex`. */
  progress: number;
  /** The row that speaks for the mark: behind it while running, the terminus after arrival. */
  rowIndex: number;
  /** A stable sideways lane among vehicles sharing this link and direction. */
  laneIndex: number;
  directionArrow: "↑" | "↓";
  /**
   * Where this trip is going, in the operator's wording; shown only for a pointed or tapped mark.
   */
  destinationLabel: string;
  phase: RunPlacementPhase;
  /** See `RunPlacement.motion`. */
  motion: RunPlacementMotion;
  /** See `RunPlacement.placedAfterLinks`. */
  placedAfterLinks?: number;
  /** One stable animation to the next stop, replaced only when its timing changes. */
  trajectory?: RunSegmentTrajectory;
  /** Any other run while one is followed, tinted so the ride stands out. */
  isOtherRun: boolean;
  isSelected: boolean;
};

export type LineDiagramVehicleOptions = {
  /** The record of mark motion every view shares (`hooks/run-motions.ts`). */
  motions: RunMotions;
  /** Share this across a bundled trunk and its legs; it changes only with the observations. */
  turnaroundIndex?: TurnaroundIndex;
  /**
   * Whether a run that has not begun is drawn waiting at its first stop. On by default: it keeps a
   * terminus from standing empty between runs.
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
  phase: RunPlacementPhase;
  motion: RunPlacementMotion;
  placedAfterLinks?: number;
  trajectory?: RunSegmentTrajectory;
  realtimeQuality: number;
};

/** Names each end of a joined mark's portions once. */
const getDestinationLabel = (portions: readonly Departure[]): string =>
  [...new Set(portions.map((portion) => portion.destination))].join(" / ");

const getRealtimeQuality = (departure: Departure): number =>
  (departure.predictedDepartureTime ? 1 : 0) +
  (departure.tripCalls?.filter(({ delayMinutes }) => delayMinutes !== undefined).length ?? 0);

function isOnSharedLink(
  placement: PlacedLineDiagramVehicle,
  joined: JoinedRunPortionPair,
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
  calls: readonly TripCall[],
  /** The stop the diagram is read from, whose municipality needs no qualifier. */
  riderStopId?: string,
  /** Every observed run of the line, either way round, whose platforms a repeated row names too. */
  observedRunCalls: readonly (readonly TripCall[])[] = [],
): LineDiagramStop[] {
  // A turnaround is one call reported twice; any other repeat is a stop the route reaches twice.
  const tripCalls = collapseTurnaroundCalls(calls);
  const homePlaceName = findHomePlaceName(tripCalls, riderStopId);
  const callKeys = tripCalls.map(getCallKey);
  // Two consecutive rows of one stop can only be told apart by platform, so it is printed there and
  // nowhere else.
  const isRepeatedStop = (index: number) =>
    callKeys[index - 1] === callKeys[index] || callKeys[index + 1] === callKeys[index];
  const platformLabelsByIndex = callKeys.some((_, index) => isRepeatedStop(index))
    ? getObservedPlatformLabels(tripCalls, observedRunCalls)
    : [];

  return tripCalls.map((tripCall, index) => ({
    stopName: tripCall.stopName,
    placeName: getStopPlaceQualifier(tripCall, homePlaceName),
    platformLabels: isRepeatedStop(index) ? platformLabelsByIndex[index] : undefined,
    stopId:
      tripCall.localStopId ??
      findStopByName(network, tripCall.stopName)?.id ??
      createStopSlug(tripCall.stopName),
    tripCall,
  }));
}

/**
 * Each row's platform, joined by the platforms of the runs' calls aligned with it. A run whose
 * direction the rows cannot tell is left out.
 */
function getObservedPlatformLabels(
  rows: readonly TripCall[],
  observedRunCalls: readonly (readonly TripCall[])[],
): (readonly string[])[] {
  const labels = rows.map(({ platformLabel }) => new Set(platformLabel ? [platformLabel] : []));
  for (const runCalls of observedRunCalls) {
    const calls = collapseTurnaroundCalls(runCalls);
    const isInOrder = runsInOrderOf(calls, rows);
    if (isInOrder === undefined) continue;
    const oriented = isInOrder ? calls : [...calls].reverse();
    for (const [rowIndex, callIndex] of alignSameRouteCalls(rows, oriented)) {
      const label = oriented[callIndex].platformLabel;
      if (label) labels[rowIndex].add(label);
    }
  }
  return labels.map((rowLabels) => [...rowLabels].sort(compareGermanNames));
}

/** Platforms sharing their word name it once (`Gleis 3/4`); others are listed apart. */
export function formatPlatformLabels(labels: readonly string[]): string {
  const parts = labels.map((label) => /^(.*\s)(\S+)$/.exec(label));
  const word = parts[0]?.[1];
  return word && parts.every((part) => part?.[1] === word)
    ? `${word}${parts.map((part) => part?.[2]).join("/")}`
    : labels.join(" / ");
}

/**
 * The drawn chain extended with the farthest observed run: its stops beyond the drawn ends and the
 * ones the drawn trip skips. Chains that share no call are left as drawn.
 */
export function extendLineDiagramCalls(
  drawnCalls: readonly TripCall[],
  farthestCalls: readonly TripCall[] | undefined,
): readonly TripCall[] {
  if (!farthestCalls?.length || drawnCalls.length === 0) return drawnCalls;
  // Aligned call by call, not by stop: a stop reached twice would anchor both calls to the first.
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
 * The run departures to place, selected once per board refresh so the per-second placement reuses
 * them. Copies of one run from several boards are settled by the freshest reading.
 */
export function getLineDiagramRunDepartures(
  selection: LineSelection,
  departures: readonly Departure[],
): Departure[] {
  return getDistinctRuns(
    departures.filter((departure) => isSelectedLine(selection, departure.lineId)),
  );
}

/**
 * The two rows a placed link falls on, where a chain names a stop more than once: the closest pair
 * of rows for the two stops, the earlier on a tie.
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

/** A mark's link as one continuous row coordinate, derived where needed rather than stored. */
export const getVehicleRowCoordinate = ({
  fromIndex,
  toIndex,
  progress,
}: Pick<LineDiagramVehicle, "fromIndex" | "toIndex" | "progress">): number =>
  fromIndex + (toIndex - fromIndex) * progress;

/**
 * Whether a run the feed says ends at this stop is still due in at or before the waiting trip is
 * due away, so the platform is not free yet.
 */
function isRunStillDueIn(
  departures: readonly Departure[],
  waiting: PlacedLineDiagramVehicle,
  feedNow: number,
): boolean {
  const leavesAt = getTripCallInstant(waiting.departure.tripCalls?.[0]);
  if (leavesAt === undefined) return false;
  return departures.some((departure) => {
    if (isSameRun(departure, waiting.departure)) return false;
    const calls = departure.tripCalls ?? [];
    const finalCall = calls[calls.length - 1];
    if (!statesRunEnd(finalCall) || finalCall.localStopId !== waiting.fromStopId) return false;
    const arrivesAt = getTripCallInstant(finalCall, "arrival");
    return arrivesAt !== undefined && arrivesAt <= leavesAt && feedNow < arrivesAt;
  });
}

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

function placeVehicles(
  motions: RunMotions,
  rowsByStopId: ReadonlyMap<string, readonly number[]>,
  runDepartures: readonly Departure[],
  turnarounds: TurnaroundIndex,
  feedNow: number,
): PlacedLineDiagramVehicle[] {
  // A turn is two trips drawn as one vehicle: both halves are keyed by the outgoing run, so React
  // keeps the element across the handover.
  const turningKeyByMarkKey = new Map<string, string>();
  for (const [arrivalKey, departureKey] of turnarounds.turningDepartureKeyByArrivalKey) {
    turningKeyByMarkKey.set(arrivalKey, departureKey);
    turningKeyByMarkKey.set(departureKey, departureKey);
  }
  const placed: PlacedLineDiagramVehicle[] = [];
  for (const candidate of [...runDepartures].sort(createSoonestPassageComparator(feedNow))) {
    const placement = getRunPlacement(
      motions,
      candidate,
      feedNow,
      turnarounds.standFromByDepartureKey.get(getRunMarkKey(candidate)),
    );
    if (!placement) continue;
    const link = findDiagramLink(rowsByStopId, placement.fromStopId, placement.toStopId);
    if (!link) continue;

    const { fromIndex, toIndex } = link;
    placed.push({
      departure: candidate,
      markerKey: turningKeyByMarkKey.get(getRunMarkKey(candidate)) ?? getRunMarkKey(candidate),
      fromIndex,
      toIndex,
      progress: placement.progress,
      // A finished run is drawn at the end of its last link; running marks belong to the row
      // behind.
      rowIndex: placement.phase === "afterEnd" ? toIndex : fromIndex,
      linkKey: `${fromIndex}:${toIndex}`,
      fromStopId: placement.fromStopId,
      toStopId: placement.toStopId,
      directionArrow: toIndex > fromIndex ? "↓" : "↑",
      phase: placement.phase,
      motion: placement.motion,
      placedAfterLinks: placement.placedAfterLinks,
      trajectory: placement.trajectory,
      realtimeQuality: getRealtimeQuality(candidate),
    });
  }
  return placed;
}

/**
 * One mark per platform, and none for a platform whose vehicle has not arrived:
 * - the arrival of a paired turnaround goes once its departure is drawn and it has stopped running;
 * - an unpaired arrival standing where a waiting departure is drawn wins over the inferred stand;
 * - a waiting mark stands down while another run is still due into its stop at or before it leaves
 *   (line 1 at Wolfartsweier Nord turns on the same second).
 * None of this claims two trips are one vehicle; only the turnaround pairing does.
 */
function arbitratePlatforms(
  placed: readonly PlacedLineDiagramVehicle[],
  runDepartures: readonly Departure[],
  turnarounds: TurnaroundIndex,
  feedNow: number,
  showWaitingVehicles: boolean,
): PlacedLineDiagramVehicle[] {
  const placedKeys = new Set(placed.map(({ departure }) => getRunMarkKey(departure)));
  const afterTurnarounds = placed.filter(({ departure, phase }) => {
    const turningKey = turnarounds.turningDepartureKeyByArrivalKey.get(getRunMarkKey(departure));
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
    return !isRunStillDueIn(runDepartures, placement, feedNow);
  });
}

/**
 * One mark for a joined working while its portions share a link. EFA may time only one portion, so
 * that one stands for both within their shared prefix.
 */
function mergeJoinedPortions(
  drawn: readonly PlacedLineDiagramVehicle[],
  joinedPortionPairs: readonly JoinedRunPortionPair[],
  selectedDeparture: Departure | undefined,
): LineDiagramVehicle[] {
  const joinedByDeparture = new Map<Departure, JoinedRunPortionPair>();
  for (const joined of joinedPortionPairs) {
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
      ? isSameRun(candidate.departure, joined.terminating)
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
    const isSelected = portions.some((departure) => isSameRun(departure, selectedDeparture));
    vehicles.push({
      departure: representative.departure,
      joinedDepartures: portions,
      // The continuing portion's identity survives the split, so it keys the joined mark too.
      markerKey:
        isTogether && joined
          ? (placementByDeparture.get(joined.continuing)?.markerKey ??
            getRunMarkKey(joined.continuing))
          : representative.markerKey,
      fromIndex: representative.fromIndex,
      toIndex: representative.toIndex,
      fromStopId: representative.fromStopId,
      toStopId: representative.toStopId,
      progress: representative.progress,
      rowIndex: representative.rowIndex,
      laneIndex,
      directionArrow: representative.directionArrow,
      destinationLabel: getDestinationLabel(portions),
      phase: representative.phase,
      motion: representative.motion,
      placedAfterLinks: representative.placedAfterLinks,
      trajectory: representative.trajectory,
      isOtherRun: Boolean(selectedDeparture) && !isSelected,
      isSelected,
    });
  }
  return vehicles;
}

export function getLineDiagramVehicles(
  diagramStops: readonly LineDiagramStop[],
  runDepartures: readonly Departure[],
  joinedPortionPairs: readonly JoinedRunPortionPair[],
  selectedDeparture: Departure | undefined,
  feedNow: number,
  { motions, turnaroundIndex, showWaitingVehicles = true }: LineDiagramVehicleOptions,
): LineDiagramVehicle[] {
  // A turning vehicle's stand is drawn once, as its departure (`lib/line-turnarounds.ts`).
  const turnarounds = turnaroundIndex ?? findTurnarounds(runDepartures);
  const placed = placeVehicles(
    motions,
    getRowsByStopId(diagramStops),
    runDepartures,
    turnarounds,
    feedNow,
  );
  const drawn = arbitratePlatforms(
    placed,
    runDepartures,
    turnarounds,
    feedNow,
    showWaitingVehicles,
  );
  return mergeJoinedPortions(drawn, joinedPortionPairs, selectedDeparture);
}

/**
 * The vehicles shown after the rider's choice to hide other runs. A joined working stays whole, and
 * only the followed run's own stand is kept.
 */
export function getShownLineDiagramVehicles(
  vehicles: readonly LineDiagramVehicle[],
  areOtherRunsShown: boolean,
): readonly LineDiagramVehicle[] {
  if (areOtherRunsShown) return vehicles;
  return vehicles.filter(
    (vehicle) => !vehicle.isOtherRun && (vehicle.isSelected || vehicle.phase !== "beforeStart"),
  );
}

/**
 * The row a "show position" action reveals: the row nearest a placed vehicle, else its next timed
 * call.
 */
export function getRunPositionAnchorIndex(
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

/**
 * The trip the line is drawn from. A pinned trip draws itself. Otherwise the previous trip is kept
 * while it still calls at the rider's stop, so stepping along the line does not flip its direction;
 * failing that, a new trip is chosen in the direction last read.
 */
export function chooseLineDiagramRun({
  lineId,
  riderStopIds,
  pinnedDeparture,
  retainedDeparture,
  preferredDestination,
  stopRunDepartures,
  boardDepartures,
}: {
  lineId: string;
  /**
   * Every id naming the rider's stop: the address's, and a complex's other stop point where the row
   * leaves from one.
   */
  riderStopIds: readonly string[];
  /** The trip the address names, which needs no holding. */
  pinnedDeparture: Departure | undefined;
  /** What the line was drawn from at the last reading of this diagram. */
  retainedDeparture: Departure | undefined;
  /** Where the rider was last heading on this line, as the selection chain remembers it. */
  preferredDestination: string | undefined;
  /** Whole trips read at the rider's stop: the only candidates with a chain to draw. */
  stopRunDepartures: readonly Departure[];
  /** The plain board, which answers first and can at least give a direction. */
  boardDepartures: readonly Departure[];
}): Departure | undefined {
  if (pinnedDeparture) return pinnedDeparture;
  if (retainedDeparture && callsAtStop(retainedDeparture, lineId, riderStopIds))
    return retainedDeparture;

  // The longest run that way, not the soonest: the best chain to extend (`extendLineDiagramCalls`).
  const heading = preferredDestination ?? retainedDeparture?.destination;
  const ofLine = (candidates: readonly Departure[]) =>
    candidates.filter((candidate) => isSameLineFamily(candidate.lineId, lineId));
  const farthestRunning = (candidates: readonly Departure[]) =>
    candidates.reduce<Departure | undefined>(
      (farthest, candidate) =>
        (candidate.tripCalls?.length ?? 0) > (farthest?.tripCalls?.length ?? 0)
          ? candidate
          : farthest,
      candidates[0],
    );
  const preferred = (candidates: readonly Departure[]) => {
    const sameWay = candidates.filter((candidate) => candidate.destination === heading);
    return farthestRunning(sameWay.length > 0 ? sameWay : candidates);
  };
  // Any trip with calls beats a plain row with a better headsign: without calls there is no
  // diagram.
  const loadedRuns = ofLine(stopRunDepartures).filter((candidate) => candidate.tripCalls?.length);
  return preferred(loadedRuns) ?? preferred(ofLine(boardDepartures));
}

const callsAtStop = (departure: Departure, lineId: string, stopIds: readonly string[]): boolean =>
  isSameLineFamily(departure.lineId, lineId) &&
  Boolean(
    departure.tripCalls?.some((call) => call.localStopId && stopIds.includes(call.localStopId)),
  );

/**
 * Which row is the rider's stop. The address comes first because it is stable while boards re-key
 * after a step; the boarding stop covers a complex whose row leaves from another of its points.
 */
export function getCurrentStopIndex(
  diagramStops: readonly Pick<LineDiagramStop, "stopId">[],
  stopId: string,
  /** Local, because the rows are. */
  boardingLocalStopId: string | undefined,
): number {
  const addressed = diagramStops.findIndex((diagramStop) => diagramStop.stopId === stopId);
  if (addressed >= 0 || !boardingLocalStopId) return addressed;
  return diagramStops.findIndex((diagramStop) => diagramStop.stopId === boardingLocalStopId);
}

/** Whether a row is an occurrence of the open stop; a route reaching it twice has two. */
export function isCurrentLineDiagramStop(
  diagramStops: readonly Pick<LineDiagramStop, "stopId">[],
  currentStopIndex: number,
  rowIndex: number,
): boolean {
  const currentStopId = diagramStops[currentStopIndex]?.stopId;
  return currentStopId !== undefined && diagramStops[rowIndex]?.stopId === currentStopId;
}

/**
 * The identity of a stop chain. Mark coordinates index its rows, so a changed chain is placed
 * afresh rather than slid across.
 */
export const getLineDiagramCoordinateKey = (
  lineId: string,
  diagramStops: readonly LineDiagramStop[],
): string => `${lineId}:${diagramStops.map(({ stopId }) => stopId).join(">")}`;

/** One sentence per row about its vehicles; strings compare by value, so unchanged rows skip. */
export function getVehicleLabelsByRowIndex(
  vehicles: readonly LineDiagramVehicle[],
  readingNow?: number,
): ReadonlyMap<number, string> {
  const labelByRowIndex = new Map<number, string>();
  for (const { rowIndex, departure, joinedDepartures, phase, fromStopId, toStopId } of vehicles) {
    const destinations = [...new Set(joinedDepartures.map((portion) => portion.destination))];
    const heading = `${departure.lineId} Richtung ${destinations.join(" und ")}`;
    // Neither end of a run is a measured position, so standing marks are not "geschätzte Position".
    const label =
      phase === "beforeStart"
        ? `nächste Abfahrt von ${heading}`
        : phase === "afterEnd"
          ? `Fahrt von ${heading} endet hier`
          : `geschätzte Position von ${heading}`;
    const source =
      readingNow === undefined
        ? ""
        : ` · ${getVehiclePositionSourceLabel(departure, readingNow, fromStopId, toStopId)}`;
    const existing = labelByRowIndex.get(rowIndex);
    labelByRowIndex.set(
      rowIndex,
      existing ? `${existing}, ${label}${source}` : `${label}${source}`,
    );
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
