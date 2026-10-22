import type { StopEvent, TransitNetwork, Call } from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { findHomePlaceName, getStopPlaceQualifier } from "./stop-naming";
import { findStopByName } from "./stop-services";
import type { JoinedDatedJourneyPortionPair } from "./joined-dated-journey-portions";
import { isSameLineFamily } from "./line-families";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import {
  alignSameRouteCalls,
  collapseTurnaroundCalls,
  getCallKey,
  getCallInstant,
  runsInOrderOf,
  statesDatedJourneyEnd,
} from "./calls";
import { compareGermanNames } from "./text";
import {
  createSoonestPassageComparator,
  getDatedJourneyPlacement,
  type DatedJourneyMotions,
  type DatedJourneyPlacementMotion,
  type DatedJourneyPlacementPhase,
  type DatedJourneySegmentTrajectory,
} from "./vehicle-positioning";
import { getDistinctDatedJourneys, getDatedJourneyMarkKey, isSameDatedJourney } from "./journeys";
import { findTurnarounds, type TurnaroundIndex } from "./line-turnarounds";
import { getVehiclePositionSourceLabel } from "./vehicle-position-presentation";

export type LineDiagramStop = {
  stopName: string;
  /** The municipality, only where the stop name does not name one. */
  placeName?: string;
  /**
   * Which bays of the stop this row is, only where a neighbouring row is the same stop: the
   * drawn journey's, plus those observed dated journeys either way use there.
   */
  bayTexts?: readonly string[];
  stopId: string;
  call: Call;
};

export type LineDiagramVehicle = {
  stopEvent: StopEvent;
  /** Both separately addressed portions while they still occupy one timed link. */
  joinedStopEvents: readonly StopEvent[];
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
   * Where this journey is going, in the operator's wording; shown only for a pointed or tapped
   * mark.
   */
  destinationLabel: string;
  phase: DatedJourneyPlacementPhase;
  /** See `DatedJourneyPlacement.motion`. */
  motion: DatedJourneyPlacementMotion;
  /** See `DatedJourneyPlacement.placedAfterLinks`. */
  placedAfterLinks?: number;
  /** One stable animation to the next stop, replaced only when its timing changes. */
  trajectory?: DatedJourneySegmentTrajectory;
  /** Any other dated journey while one is followed, tinted so the ride stands out. */
  isOtherDatedJourney: boolean;
  isSelected: boolean;
};

export type LineDiagramVehicleOptions = {
  /** The record of mark motion every view shares (`hooks/dated-journey-motions.ts`). */
  motions: DatedJourneyMotions;
  /** Share this across a bundled trunk and its legs; it changes only with the observations. */
  turnaroundIndex?: TurnaroundIndex;
  /**
   * Whether a dated journey that has not begun is drawn waiting at its first stop. On by default:
   * it keeps a terminus from standing empty between dated journeys.
   */
  showWaitingVehicles?: boolean;
};

type PlacedLineDiagramVehicle = {
  stopEvent: StopEvent;
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
  phase: DatedJourneyPlacementPhase;
  motion: DatedJourneyPlacementMotion;
  placedAfterLinks?: number;
  trajectory?: DatedJourneySegmentTrajectory;
  realtimeQuality: number;
};

/** Names each end of a joined mark's portions once. */
const getDestinationLabel = (portions: readonly StopEvent[]): string =>
  [...new Set(portions.map((portion) => portion.destinationText))].join(" / ");

const getRealtimeQuality = (stopEvent: StopEvent): number =>
  (stopEvent.estimatedDepartureTime ? 1 : 0) +
  (stopEvent.calls?.filter(({ delayMinutes }) => delayMinutes !== undefined).length ?? 0);

function isOnSharedLink(
  placement: PlacedLineDiagramVehicle,
  joined: JoinedDatedJourneyPortionPair,
): boolean {
  const calls = placement.stopEvent.calls ?? [];
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
  calls: readonly Call[],
  /** The stop the diagram is read from, whose municipality needs no qualifier. */
  riderStopId?: string,
  /**
   * Every observed dated journey of the line, either way round, whose bays a repeated row names
   * too.
   */
  observedDatedJourneyCalls: readonly (readonly Call[])[] = [],
): LineDiagramStop[] {
  // A turnaround is one call reported twice; any other repeat is a stop the route reaches twice.
  const collapsedCalls = collapseTurnaroundCalls(calls);
  const homePlaceName = findHomePlaceName(collapsedCalls, riderStopId);
  const callKeys = collapsedCalls.map(getCallKey);
  // Two consecutive rows of one stop can only be told apart by bay, so it is printed there and
  // nowhere else.
  const isRepeatedStop = (index: number) =>
    callKeys[index - 1] === callKeys[index] || callKeys[index + 1] === callKeys[index];
  const bayTextsByIndex = callKeys.some((_, index) => isRepeatedStop(index))
    ? getObservedBayTexts(collapsedCalls, observedDatedJourneyCalls)
    : [];

  return collapsedCalls.map((call, index) => ({
    stopName: call.stopName,
    placeName: getStopPlaceQualifier(call, homePlaceName),
    bayTexts: isRepeatedStop(index) ? bayTextsByIndex[index] : undefined,
    stopId:
      call.localStopId ??
      findStopByName(network, call.stopName)?.id ??
      createStopSlug(call.stopName),
    call,
  }));
}

/**
 * Each row's bay, joined by the bays of the dated journeys' calls aligned with it. A dated journey
 * whose direction the rows cannot tell is left out.
 */
function getObservedBayTexts(
  rows: readonly Call[],
  observedDatedJourneyCalls: readonly (readonly Call[])[],
): (readonly string[])[] {
  const labels = rows.map(({ bayText }) => new Set(bayText ? [bayText] : []));
  for (const datedJourneyCalls of observedDatedJourneyCalls) {
    const calls = collapseTurnaroundCalls(datedJourneyCalls);
    const isInOrder = runsInOrderOf(calls, rows);
    if (isInOrder === undefined) continue;
    const oriented = isInOrder ? calls : [...calls].reverse();
    for (const [rowIndex, callIndex] of alignSameRouteCalls(rows, oriented)) {
      const label = oriented[callIndex].bayText;
      if (label) labels[rowIndex].add(label);
    }
  }
  return labels.map((rowLabels) => [...rowLabels].sort(compareGermanNames));
}

/** Bays sharing their word name it once (`Gleis 3/4`); others are listed apart. */
export function formatBayTexts(labels: readonly string[]): string {
  const parts = labels.map((label) => /^(.*\s)(\S+)$/.exec(label));
  const word = parts[0]?.[1];
  return word && parts.every((part) => part?.[1] === word)
    ? `${word}${parts.map((part) => part?.[2]).join("/")}`
    : labels.join(" / ");
}

/**
 * The drawn chain extended with the farthest observed dated journey: its stops beyond the drawn
 * ends and the ones the drawn journey skips. Chains that share no call are left as drawn.
 */
export function extendLineDiagramCalls(
  drawnCalls: readonly Call[],
  farthestCalls: readonly Call[] | undefined,
): readonly Call[] {
  if (!farthestCalls?.length || drawnCalls.length === 0) return drawnCalls;
  // Aligned call by call, not by stop: a stop reached twice would anchor both calls to the first.
  const anchors = alignSameRouteCalls(drawnCalls, farthestCalls);
  if (anchors.length === 0) return drawnCalls;

  const merged: Call[] = [];
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
 * The dated journey departures to place, selected once per board refresh so the per-second
 * placement reuses them. Copies of one dated journey from several boards are settled by the
 * freshest reading.
 */
export function getLineDiagramDatedJourneyStopEvents(
  selection: LineSelection,
  stopEvents: readonly StopEvent[],
): StopEvent[] {
  return getDistinctDatedJourneys(
    stopEvents.filter((stopEvent) => isSelectedLine(selection, stopEvent.lineId)),
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
 * Whether a dated journey the feed says ends at this stop is still due in at or before the waiting
 * journey is due away, so the bay is not free yet.
 */
function isDatedJourneyStillDueIn(
  stopEvents: readonly StopEvent[],
  waiting: PlacedLineDiagramVehicle,
  feedNow: number,
): boolean {
  const leavesAt = getCallInstant(waiting.stopEvent.calls?.[0]);
  if (leavesAt === undefined) return false;
  return stopEvents.some((stopEvent) => {
    if (isSameDatedJourney(stopEvent, waiting.stopEvent)) return false;
    const calls = stopEvent.calls ?? [];
    const finalCall = calls[calls.length - 1];
    if (!statesDatedJourneyEnd(finalCall) || finalCall.localStopId !== waiting.fromStopId)
      return false;
    const arrivesAt = getCallInstant(finalCall, "arrival");
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
  motions: DatedJourneyMotions,
  rowsByStopId: ReadonlyMap<string, readonly number[]>,
  datedJourneyStopEvents: readonly StopEvent[],
  turnarounds: TurnaroundIndex,
  feedNow: number,
): PlacedLineDiagramVehicle[] {
  // A turn is two journeys drawn as one vehicle: both halves are keyed by the outgoing dated
  // journey, so React keeps the element across the handover.
  const turningKeyByMarkKey = new Map<string, string>();
  for (const [arrivalKey, departureKey] of turnarounds.turningDepartureKeyByArrivalKey) {
    turningKeyByMarkKey.set(arrivalKey, departureKey);
    turningKeyByMarkKey.set(departureKey, departureKey);
  }
  const placed: PlacedLineDiagramVehicle[] = [];
  for (const candidate of [...datedJourneyStopEvents].sort(
    createSoonestPassageComparator(feedNow),
  )) {
    const placement = getDatedJourneyPlacement(
      motions,
      candidate,
      feedNow,
      turnarounds.standFromByDepartureKey.get(getDatedJourneyMarkKey(candidate)),
    );
    if (!placement) continue;
    const link = findDiagramLink(rowsByStopId, placement.fromStopId, placement.toStopId);
    if (!link) continue;

    const { fromIndex, toIndex } = link;
    placed.push({
      stopEvent: candidate,
      markerKey:
        turningKeyByMarkKey.get(getDatedJourneyMarkKey(candidate)) ??
        getDatedJourneyMarkKey(candidate),
      fromIndex,
      toIndex,
      progress: placement.progress,
      // A finished dated journey is drawn at the end of its last link; running marks belong to the
      // row behind.
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
 * One mark per bay, and none for a bay whose vehicle has not arrived:
 * - the arrival of a paired turnaround goes once its departure is drawn and it has stopped running;
 * - an unpaired arrival standing where a waiting departure is drawn wins over the inferred stand;
 * - a waiting mark stands down while another dated journey is still due into its stop at or before
 * it leaves (line 1 at Wolfartsweier Nord turns on the same second). None of this claims two
 * journeys are one vehicle; only the turnaround pairing does.
 */
function arbitrateBays(
  placed: readonly PlacedLineDiagramVehicle[],
  datedJourneyStopEvents: readonly StopEvent[],
  turnarounds: TurnaroundIndex,
  feedNow: number,
  showWaitingVehicles: boolean,
): PlacedLineDiagramVehicle[] {
  const placedKeys = new Set(placed.map(({ stopEvent }) => getDatedJourneyMarkKey(stopEvent)));
  const afterTurnarounds = placed.filter(({ stopEvent, phase }) => {
    const turningKey = turnarounds.turningDepartureKeyByArrivalKey.get(
      getDatedJourneyMarkKey(stopEvent),
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
    return !isDatedJourneyStillDueIn(datedJourneyStopEvents, placement, feedNow);
  });
}

/**
 * One mark for a joined working while its portions share a link. EFA may time only one portion, so
 * that one stands for both within their shared prefix.
 */
function mergeJoinedPortions(
  drawn: readonly PlacedLineDiagramVehicle[],
  joinedPortionPairs: readonly JoinedDatedJourneyPortionPair[],
  selectedStopEvent: StopEvent | undefined,
): LineDiagramVehicle[] {
  const joinedByStopEvent = new Map<StopEvent, JoinedDatedJourneyPortionPair>();
  for (const joined of joinedPortionPairs) {
    joinedByStopEvent.set(joined.terminating, joined);
    joinedByStopEvent.set(joined.continuing, joined);
  }
  const placementByStopEvent = new Map(drawn.map((placement) => [placement.stopEvent, placement]));
  const consumed = new Set<StopEvent>();
  const laneCountByLink = new Map<string, number>();
  const vehicles: LineDiagramVehicle[] = [];

  for (const candidate of drawn) {
    if (consumed.has(candidate.stopEvent)) continue;
    const joined = joinedByStopEvent.get(candidate.stopEvent);
    const otherStopEvent = joined
      ? isSameDatedJourney(candidate.stopEvent, joined.terminating)
        ? joined.continuing
        : joined.terminating
      : undefined;
    const other = otherStopEvent ? placementByStopEvent.get(otherStopEvent) : undefined;
    const isTogether = Boolean(
      joined &&
        isOnSharedLink(candidate, joined) &&
        (!other || (other.linkKey === candidate.linkKey && isOnSharedLink(other, joined))),
    );
    const portions =
      isTogether && otherStopEvent ? [candidate.stopEvent, otherStopEvent] : [candidate.stopEvent];
    if (isTogether && other) consumed.add(other.stopEvent);
    consumed.add(candidate.stopEvent);

    const representative =
      isTogether && other && other.realtimeQuality > candidate.realtimeQuality ? other : candidate;
    const laneIndex = laneCountByLink.get(representative.linkKey) ?? 0;
    laneCountByLink.set(representative.linkKey, laneIndex + 1);
    const isSelected = portions.some((stopEvent) =>
      isSameDatedJourney(stopEvent, selectedStopEvent),
    );
    vehicles.push({
      stopEvent: representative.stopEvent,
      joinedStopEvents: portions,
      // The continuing portion's identity survives the split, so it keys the joined mark too.
      markerKey:
        isTogether && joined
          ? (placementByStopEvent.get(joined.continuing)?.markerKey ??
            getDatedJourneyMarkKey(joined.continuing))
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
      isOtherDatedJourney: Boolean(selectedStopEvent) && !isSelected,
      isSelected,
    });
  }
  return vehicles;
}

export function getLineDiagramVehicles(
  diagramStops: readonly LineDiagramStop[],
  datedJourneyStopEvents: readonly StopEvent[],
  joinedPortionPairs: readonly JoinedDatedJourneyPortionPair[],
  selectedStopEvent: StopEvent | undefined,
  feedNow: number,
  { motions, turnaroundIndex, showWaitingVehicles = true }: LineDiagramVehicleOptions,
): LineDiagramVehicle[] {
  // A turning vehicle's stand is drawn once, as its departure (`lib/line-turnarounds.ts`).
  const turnarounds = turnaroundIndex ?? findTurnarounds(datedJourneyStopEvents);
  const placed = placeVehicles(
    motions,
    getRowsByStopId(diagramStops),
    datedJourneyStopEvents,
    turnarounds,
    feedNow,
  );
  const drawn = arbitrateBays(
    placed,
    datedJourneyStopEvents,
    turnarounds,
    feedNow,
    showWaitingVehicles,
  );
  return mergeJoinedPortions(drawn, joinedPortionPairs, selectedStopEvent);
}

/**
 * The vehicles shown after the rider's choice to hide other dated journeys. A joined working stays
 * whole, and only the followed dated journey's own stand is kept.
 */
export function getShownLineDiagramVehicles(
  vehicles: readonly LineDiagramVehicle[],
  areOtherDatedJourneysShown: boolean,
): readonly LineDiagramVehicle[] {
  if (areOtherDatedJourneysShown) return vehicles;
  return vehicles.filter(
    (vehicle) =>
      !vehicle.isOtherDatedJourney && (vehicle.isSelected || vehicle.phase !== "beforeStart"),
  );
}

/**
 * The row a "show position" action reveals: the row nearest a placed vehicle, else its next timed
 * call.
 */
export function getDatedJourneyPositionAnchorIndex(
  diagramStops: readonly LineDiagramStop[],
  vehicles: readonly LineDiagramVehicle[],
  nextCall: Call | undefined,
): number {
  const selectedVehicle = vehicles.find((vehicle) => vehicle.isSelected);
  if (selectedVehicle && diagramStops.length > 0) {
    const nearest = Math.round(getVehicleRowCoordinate(selectedVehicle));
    return Math.max(0, Math.min(diagramStops.length - 1, nearest));
  }
  if (!nextCall) return -1;
  return diagramStops.findIndex(({ call }) => getCallKey(call) === getCallKey(nextCall));
}

/**
 * The journey the line is drawn from. A pinned journey draws itself. Otherwise the previous journey
 * is kept while it still calls at the rider's stop, so stepping along the line does not flip its
 * direction; failing that, a new journey is chosen in the direction last read.
 */
export function chooseLineDiagramDatedJourney({
  lineId,
  riderStopIds,
  pinnedStopEvent,
  retainedStopEvent,
  preferredDestination,
  stopDatedJourneyStopEvents,
  boardStopEvents,
}: {
  lineId: string;
  /**
   * Every id naming the rider's stop: the address's, and a complex's other stop point where the row
   * leaves from one.
   */
  riderStopIds: readonly string[];
  /** The journey the address names, which needs no holding. */
  pinnedStopEvent: StopEvent | undefined;
  /** What the line was drawn from at the last reading of this diagram. */
  retainedStopEvent: StopEvent | undefined;
  /** Where the rider was last heading on this line, as the selection chain remembers it. */
  preferredDestination: string | undefined;
  /** Whole journeys read at the rider's stop: the only candidates with a chain to draw. */
  stopDatedJourneyStopEvents: readonly StopEvent[];
  /** The plain board, which answers first and can at least give a direction. */
  boardStopEvents: readonly StopEvent[];
}): StopEvent | undefined {
  if (pinnedStopEvent) return pinnedStopEvent;
  if (retainedStopEvent && callsAtStop(retainedStopEvent, lineId, riderStopIds))
    return retainedStopEvent;

  // The longest dated journey that way, not the soonest: the best chain to extend
  // (`extendLineDiagramCalls`).
  const heading = preferredDestination ?? retainedStopEvent?.destinationText;
  const ofLine = (candidates: readonly StopEvent[]) =>
    candidates.filter((candidate) => isSameLineFamily(candidate.lineId, lineId));
  const farthestRunning = (candidates: readonly StopEvent[]) =>
    candidates.reduce<StopEvent | undefined>(
      (farthest, candidate) =>
        (candidate.calls?.length ?? 0) > (farthest?.calls?.length ?? 0) ? candidate : farthest,
      candidates[0],
    );
  const preferred = (candidates: readonly StopEvent[]) => {
    const sameWay = candidates.filter((candidate) => candidate.destinationText === heading);
    return farthestRunning(sameWay.length > 0 ? sameWay : candidates);
  };
  // Any journey with calls beats a plain row with a better headsign: without calls there is no
  // diagram.
  const loadedDatedJourneys = ofLine(stopDatedJourneyStopEvents).filter(
    (candidate) => candidate.calls?.length,
  );
  return preferred(loadedDatedJourneys) ?? preferred(ofLine(boardStopEvents));
}

const callsAtStop = (stopEvent: StopEvent, lineId: string, stopIds: readonly string[]): boolean =>
  isSameLineFamily(stopEvent.lineId, lineId) &&
  Boolean(stopEvent.calls?.some((call) => call.localStopId && stopIds.includes(call.localStopId)));

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
  for (const { rowIndex, stopEvent, joinedStopEvents, phase, fromStopId, toStopId } of vehicles) {
    const destinations = [...new Set(joinedStopEvents.map((portion) => portion.destinationText))];
    const heading = `${stopEvent.lineId} Richtung ${destinations.join(" und ")}`;
    // Neither end of a dated journey is a measured position, so standing marks are not "geschätzte
    // Position".
    const label =
      phase === "beforeStart"
        ? `nächste Abfahrt von ${heading}`
        : phase === "afterEnd"
          ? `Fahrt von ${heading} endet hier`
          : `geschätzte Position von ${heading}`;
    const source =
      readingNow === undefined
        ? ""
        : ` · ${getVehiclePositionSourceLabel(stopEvent, readingNow, fromStopId, toStopId)}`;
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
      total + vehicles.reduce((count, { joinedStopEvents }) => count + joinedStopEvents.length, 0),
    0,
  );
