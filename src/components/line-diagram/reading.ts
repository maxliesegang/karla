import { useMemo, useState } from "react";
import type {
  StopEvent,
  StopEventBoard,
  TransitLine,
  TransitNetwork,
  StopPlace,
  Call,
} from "../../data/transit-types";
import { getFarthestLineDatedJourney, getLineTermini } from "../../lib/stop-services";
import { findTurnarounds } from "../../lib/line-turnarounds";
import { useDatedJourneyMotions } from "../../hooks/dated-journey-motions";
import { useDeviceNow } from "../../hooks/clock";
import { useStoredPreference } from "../../hooks/stored-preference";
import { appSettings } from "../../lib/app-settings";
import { useLineDatedJourneyStopEvents } from "../../hooks/line-dated-journey-stop-events";
import { useDatedJourneys } from "../../hooks/dated-journey-reading-store";
import {
  getLineDiagramStatusLabel,
  getDatedJourneyPositionHint,
} from "../../lib/stop-event-presentation";
import {
  buildLineDiagramStops,
  chooseLineDiagramDatedJourney,
  countLineDiagramVehicles,
  extendLineDiagramCalls,
  getCurrentStopIndex,
  getLineDiagramCoordinateKey,
  getLineDiagramDatedJourneyStopEvents,
  getLineDiagramVehicles,
  getShownLineDiagramVehicles,
  getDatedJourneyPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
} from "../../lib/line-diagram";
import { getJoinedDatedJourneyPortionPairs } from "../../lib/joined-dated-journey-portions";
import {
  createLineSelectionOf,
  getLineBundleControls,
  type LineBundleOffer,
} from "../../lib/line-bundles";
import {
  useDrawableLineBundleOffers,
  useLineBundleBranchVehicles,
  useLineDiagramFork,
} from "./bundle";

const EMPTY_CALLS: readonly Call[] = [];
const EMPTY_STOP_EVENTS: readonly StopEvent[] = [];
const NO_ROW_IDS: readonly string[] = [];
const EMPTY_LINES: readonly TransitLine[] = [];
const EMPTY_OFFERS: readonly LineBundleOffer[] = [];
/** Fine enough that a call turns over within seconds of its minute. */
const ROW_CLOCK_STEP_MS = 5_000;

export type LineDiagramReadingInput = {
  line: TransitLine;
  bundledLines?: readonly TransitLine[];
  bundleOffers?: readonly LineBundleOffer[];
  network: TransitNetwork;
  stop: StopPlace;
  stopEvent?: StopEvent;
  preferredDestination?: string;
  stopEventBoard: StopEventBoard | null;
  lineStopEventBoards: readonly StopEventBoard[];
  observationBoards: readonly StopEventBoard[];
  isRide: boolean;
  rideNextCall?: Call;
};

/**
 * What the diagram draws, derived from the boards: which journey, which way up, which stops, which
 * vehicles, the ends' names. Scrolling and measurement belong to `layout.ts`.
 */
export function useLineDiagramReading({
  line,
  bundledLines = EMPTY_LINES,
  bundleOffers = EMPTY_OFFERS,
  network,
  stop,
  stopEvent,
  preferredDestination,
  stopEventBoard,
  lineStopEventBoards,
  observationBoards,
  isRide,
  rideNextCall,
}: LineDiagramReadingInput) {
  const { isShowingOtherLineRuns } = useStoredPreference(appSettings);
  const vehicleObservationBoards = useMemo(
    () => [...observationBoards, ...lineStopEventBoards],
    [observationBoards, lineStopEventBoards],
  );
  // With no sibling, the selection is the line itself.
  const lineSelection = useMemo(
    () => createLineSelectionOf({ id: line.id, identity: line.identity }, bundledLines),
    [bundledLines, line.id, line.identity],
  );
  // Copies of a dated journey from different boards are ranked by their own read times.
  const observedDatedJourneyStopEvents = useMemo(
    () =>
      getLineDiagramDatedJourneyStopEvents(
        lineSelection,
        vehicleObservationBoards.flatMap((board) => board.stopEvents),
      ),
    [lineSelection, vehicleObservationBoards],
  );
  const { datedJourneyStopEvents, feedNow } = useLineDatedJourneyStopEvents(
    lineSelection.lineId,
    observedDatedJourneyStopEvents,
    stopEventBoard,
    isRide,
  );
  // A retained ride may be on no board after a reload; placement drops it once its dated journey
  // ends.
  const visibleDatedJourneyStopEvents = useMemo(
    () =>
      getLineDiagramDatedJourneyStopEvents(
        lineSelection,
        stopEvent ? [...datedJourneyStopEvents, stopEvent] : datedJourneyStopEvents,
      ),
    [stopEvent, lineSelection, datedJourneyStopEvents],
  );
  // Without a selected journey the diagram is still drawn from one, held across stops
  // (`chooseLineDiagramDatedJourney`). The rider's stop includes the stop point a stop place's row
  // leaves from.
  const boardingLocalStopId = stopEvent?.boardingLocalStopId;
  const riderStopIds = useMemo(
    () => (boardingLocalStopId ? [stop.id, boardingLocalStopId] : [stop.id]),
    [boardingLocalStopId, stop.id],
  );
  // The stop's whole-journey readings: candidates for the drawn journey and a sibling's journey.
  const stopDatedJourneyStopEvents = useMemo(
    () =>
      lineStopEventBoards.find((board) => board.stopId === stop.id)?.stopEvents ??
      EMPTY_STOP_EVENTS,
    [lineStopEventBoards, stop.id],
  );
  // Held by id and read from the store, like every followed dated journey.
  const [retainedLineDatedJourneyId, setRetainedLineDatedJourneyId] = useState<string>();
  const retainedLineDatedJourneyIds = useMemo(
    () => (retainedLineDatedJourneyId ? [retainedLineDatedJourneyId] : NO_ROW_IDS),
    [retainedLineDatedJourneyId],
  );
  const [retainedLineDatedJourney] = useDatedJourneys(retainedLineDatedJourneyIds);
  // The pinned journey as the store holds it: without calls and without a failed read, its read is
  // still out. One the store does not hold is never read.
  const pinnedRowId = stopEvent?.id;
  const pinnedRowIds = useMemo(() => (pinnedRowId ? [pinnedRowId] : NO_ROW_IDS), [pinnedRowId]);
  const [storedPinnedStopEvent] = useDatedJourneys(pinnedRowIds);
  const isPinnedDatedJourneyReading =
    !stopEvent?.calls?.length &&
    storedPinnedStopEvent !== undefined &&
    storedPinnedStopEvent.readAt?.sequenceRefreshFailedAt === undefined;
  const diagramStopEvent = useMemo(
    () =>
      chooseLineDiagramDatedJourney({
        lineId: line.id,
        identity: line.identity,
        riderStopIds,
        pinnedStopEvent: stopEvent,
        retainedStopEvent: retainedLineDatedJourney,
        preferredDestination,
        stopDatedJourneyStopEvents,
        boardStopEvents: stopEventBoard?.stopEvents ?? EMPTY_STOP_EVENTS,
      }),
    [
      riderStopIds,
      stopEvent,
      stopEventBoard,
      retainedLineDatedJourney,
      line.id,
      line.identity,
      preferredDestination,
      stopDatedJourneyStopEvents,
    ],
  );
  // Set during render, so the next reading finds it; never cleared, since an empty moment is what
  // the hold is for.
  if (diagramStopEvent && diagramStopEvent.id !== retainedLineDatedJourneyId)
    setRetainedLineDatedJourneyId(diagramStopEvent.id);
  const drawnCalls = diagramStopEvent?.calls ?? EMPTY_CALLS;
  // A whole-line reading extends the primary chain before finding the bundle trunk, so a short
  // working cannot hide the rest of the line or a sibling's leg.
  const isWholeLine = !stopEvent;
  const drawnDiagramCalls = useMemo(() => [...drawnCalls].reverse(), [drawnCalls]);
  const farthestDatedJourney = useMemo(
    () => getFarthestLineDatedJourney(line, observedDatedJourneyStopEvents, drawnDiagramCalls),
    [drawnDiagramCalls, line, observedDatedJourneyStopEvents],
  );
  const wholeLineDiagramCalls = useMemo(
    () =>
      isWholeLine
        ? extendLineDiagramCalls(drawnDiagramCalls, farthestDatedJourney.calls)
        : drawnDiagramCalls,
    [drawnDiagramCalls, farthestDatedJourney.calls, isWholeLine],
  );
  const forkDrawnCalls = useMemo(
    () => (isWholeLine ? [...wholeLineDiagramCalls].reverse() : drawnCalls),
    [drawnCalls, isWholeLine, wholeLineDiagramCalls],
  );
  const forkDestination = isWholeLine
    ? (forkDrawnCalls[forkDrawnCalls.length - 1]?.stopName ?? diagramStopEvent?.destinationText)
    : diagramStopEvent?.destinationText;
  // The bundle's shared stretch and legs; without a sibling, the drawn journey.
  const fork = useLineDiagramFork({
    lineId: line.id,
    bundledLines,
    drawnCalls: forkDrawnCalls,
    destination: forkDestination,
    riderStopIds,
    // Whole line: every board along the lines. A pinned journey pairs only with journeys at this
    // stop.
    candidateStopEvents: isWholeLine ? observedDatedJourneyStopEvents : stopDatedJourneyStopEvents,
  });
  const { branchesAhead, branchesBehind } = fork;
  const calls = fork.calls;
  const branches = useMemo(
    () => [...branchesAhead, ...branchesBehind],
    [branchesAhead, branchesBehind],
  );
  // Each leg's line, the primary included: past the junction it is a branch like any other.
  const lineById = useMemo(() => {
    const byId = new Map<string, TransitLine>(
      network.lines.map((networkLine) => [networkLine.id, networkLine]),
    );
    byId.set(line.id, line);
    for (const bundled of bundledLines) byId.set(bundled.id, bundled);
    return byId;
  }, [bundledLines, line, network.lines]);
  // Drawn toward the destination: the last call at the top. Arrows follow this order.
  const reversedCalls = useMemo(() => [...calls].reverse(), [calls]);
  // A whole line names its farthest observed dated journey; a bundle names its trunk, branches
  // their own ends.
  const [seenFirstTerminus, seenLastTerminus] = getLineTermini(line);
  const diagramCalls = reversedCalls;
  const drawnTermini = {
    firstTerminus: diagramCalls[0]?.stopName ?? seenFirstTerminus,
    lastTerminus: diagramCalls[diagramCalls.length - 1]?.stopName ?? seenLastTerminus,
  };
  const termini =
    isWholeLine && bundledLines.length === 0
      ? {
          firstTerminus: farthestDatedJourney.firstTerminus,
          lastTerminus: farthestDatedJourney.lastTerminus,
        }
      : drawnTermini;
  // A whole line is ridden both ways, so a repeated stop's rows name both directions' bays.
  const observedDatedJourneyCalls = useMemo(
    () => (isWholeLine ? observedDatedJourneyStopEvents.map(({ calls }) => calls ?? []) : []),
    [isWholeLine, observedDatedJourneyStopEvents],
  );
  const diagramStops = useMemo(
    () => buildLineDiagramStops(network, diagramCalls, stop.id, observedDatedJourneyCalls),
    [network, diagramCalls, stop.id, observedDatedJourneyCalls],
  );
  // A list, so the layer stays memoized across ticks.
  const diagramStopNames = useMemo(
    () => diagramStops.map(({ stopName }) => stopName),
    [diagramStops],
  );
  // Sequences change only with observations, not every tick.
  const joinedPortionPairs = useMemo(
    () => getJoinedDatedJourneyPortionPairs(visibleDatedJourneyStopEvents),
    [visibleDatedJourneyStopEvents],
  );
  // Built once and shared by the trunk and every leg.
  const turnaroundIndex = useMemo(
    () => findTurnarounds(visibleDatedJourneyStopEvents),
    [visibleDatedJourneyStopEvents],
  );
  const motions = useDatedJourneyMotions();
  const vehicles = useMemo(
    () =>
      getShownLineDiagramVehicles(
        getLineDiagramVehicles(
          diagramStops,
          visibleDatedJourneyStopEvents,
          joinedPortionPairs,
          stopEvent,
          feedNow,
          { motions, turnaroundIndex },
        ),
        isShowingOtherLineRuns,
      ),
    [
      diagramStops,
      visibleDatedJourneyStopEvents,
      joinedPortionPairs,
      stopEvent,
      feedNow,
      motions,
      turnaroundIndex,
      isShowingOtherLineRuns,
    ],
  );
  const readingNow = useDeviceNow();
  const vehicleLabelByRowIndex = useMemo(
    () => getVehicleLabelsByRowIndex(vehicles, readingNow),
    [vehicles, readingNow],
  );
  const { vehiclesByBranchKey, transferKeysByBranchKey } = useLineBundleBranchVehicles({
    branches,
    lineById,
    network,
    datedJourneyStopEvents: visibleDatedJourneyStopEvents,
    joinedPortionPairs,
    selectedStopEvent: stopEvent,
    feedNow,
    motions,
    turnaroundIndex,
    areOtherDatedJourneysShown: isShowingOtherLineRuns,
    trunkVehicles: vehicles,
  });
  const bundledLineIds = useMemo(() => bundledLines.map(({ id }) => id), [bundledLines]);
  // Only siblings whose shared corridor lies along the journey on screen.
  const drawableOffers = useDrawableLineBundleOffers({
    offers: bundleOffers,
    drawnCalls,
    riderStopIds,
  });
  const bundleControls = useMemo(
    () => getLineBundleControls(bundledLineIds, drawableOffers),
    [bundledLineIds, drawableOffers],
  );

  // Rows get a coarse clock, so memoized rows skip ticks that only moved a mark.
  const rowFeedNow = Math.floor(feedNow / ROW_CLOCK_STEP_MS) * ROW_CLOCK_STEP_MS;
  return {
    /** The pinned journey, held while the boards are re-keyed. */
    stopEvent,
    fork,
    branches,
    lineById,
    bundleControls,
    diagramStops,
    diagramStopNames,
    isPinnedDatedJourneyReading,
    // On a ride the rider is on board, at no stop.
    currentStopIndex: isRide ? -1 : getCurrentStopIndex(diagramStops, stop.id, boardingLocalStopId),
    // The stop chain is the coordinate system: a new chain remounts the marker layer so nothing
    // slides across. The drawn journey is not part of the key; it changes on refreshes.
    vehicleCoordinateKey: getLineDiagramCoordinateKey(line.id, diagramStops),
    vehicles,
    vehicleLabelByRowIndex,
    vehiclesByBranchKey,
    transferKeysByBranchKey,
    // A joined mark counts once per line, as the mark shows.
    totalVehicleCount: countLineDiagramVehicles([vehicles, ...vehiclesByBranchKey.values()]),
    // The pinned journey's position as a row, for the position control and initial placement: the
    // nearest row to its mark, else its next call.
    datedJourneyPositionStopIndex: getDatedJourneyPositionAnchorIndex(
      diagramStops,
      vehicles,
      rideNextCall,
    ),
    rowFeedNow,
    statusLabel: getLineDiagramStatusLabel(stopEvent, stopEventBoard),
    // The pinned journey has no mark (not begun, over, or unplaceable). Uses the rows' coarse
    // clock: it states a call time, not a countdown.
    datedJourneyPositionHint:
      diagramStops.length > 0
        ? getDatedJourneyPositionHint(
            stopEvent,
            // A mark standing at either end is not a placement; the hint still applies.
            vehicles.some((vehicle) => vehicle.isSelected && vehicle.phase === "running"),
            rowFeedNow,
          )
        : undefined,
    termini,
    // Without both termini, the line's name says more than half a heading.
    hasTermini: Boolean(termini.firstTerminus && termini.lastTerminus),
  };
}
