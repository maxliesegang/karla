import { useMemo, useState } from "react";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransitStop,
  TripCall,
} from "../../data/transit-types";
import { getFarthestLineRun, getLineTermini } from "../../lib/stop-services";
import { findTurnarounds } from "../../lib/line-turnarounds";
import { useRunMotions } from "../../hooks/run-motions";
import { useDeviceNow } from "../../hooks/clock";
import { useStoredPreference } from "../../hooks/stored-preference";
import { appSettings } from "../../lib/app-settings";
import { useLineRunDepartures } from "../../hooks/line-run-departures";
import { useRuns } from "../../hooks/run-reading-store";
import { getLineDiagramStatusLabel, getRunPositionHint } from "../../lib/departure-presentation";
import {
  buildLineDiagramStops,
  chooseLineDiagramRun,
  countLineDiagramVehicles,
  extendLineDiagramCalls,
  getCurrentStopIndex,
  getLineDiagramCoordinateKey,
  getLineDiagramRunDepartures,
  getLineDiagramVehicles,
  getShownLineDiagramVehicles,
  getRunPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
} from "../../lib/line-diagram";
import { getJoinedRunPortionPairs } from "../../lib/joined-run-portions";
import {
  createLineSelection,
  getLineBundleControls,
  type LineBundleOffer,
} from "../../lib/line-bundles";
import {
  useDrawableLineBundleOffers,
  useLineBundleBranchVehicles,
  useLineDiagramFork,
} from "./bundle";

const EMPTY_TRIP_CALLS: readonly TripCall[] = [];
const EMPTY_DEPARTURES: readonly Departure[] = [];
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
  stop: TransitStop;
  departure?: Departure;
  preferredDestination?: string;
  departureBoard: DepartureBoard | null;
  lineDepartureBoards: readonly DepartureBoard[];
  observationBoards: readonly DepartureBoard[];
  isRide: boolean;
  rideNextCall?: TripCall;
};

/**
 * What the diagram draws, derived from the boards: which trip, which way up, which stops, which
 * vehicles, the ends' names. Scrolling and measurement belong to `layout.ts`.
 */
export function useLineDiagramReading({
  line,
  bundledLines = EMPTY_LINES,
  bundleOffers = EMPTY_OFFERS,
  network,
  stop,
  departure,
  preferredDestination,
  departureBoard,
  lineDepartureBoards,
  observationBoards,
  isRide,
  rideNextCall,
}: LineDiagramReadingInput) {
  const { isShowingOtherLineRuns } = useStoredPreference(appSettings);
  const vehicleObservationBoards = useMemo(
    () => [...observationBoards, ...lineDepartureBoards],
    [observationBoards, lineDepartureBoards],
  );
  // With no sibling, the selection is the line itself.
  const lineSelection = useMemo(
    () =>
      createLineSelection(
        line.id,
        bundledLines.map(({ id }) => id),
      ),
    [bundledLines, line.id],
  );
  // Copies of a run from different boards are ranked by their own read times.
  const observedRunDepartures = useMemo(
    () =>
      getLineDiagramRunDepartures(
        lineSelection,
        vehicleObservationBoards.flatMap((board) => board.departures),
      ),
    [lineSelection, vehicleObservationBoards],
  );
  const { runDepartures, feedNow } = useLineRunDepartures(
    lineSelection.lineId,
    observedRunDepartures,
    departureBoard,
    isRide,
  );
  // A retained ride may be on no board after a reload; placement drops it once its run ends.
  const visibleRunDepartures = useMemo(
    () =>
      getLineDiagramRunDepartures(
        lineSelection,
        departure ? [...runDepartures, departure] : runDepartures,
      ),
    [departure, lineSelection, runDepartures],
  );
  // Without a selected trip the diagram is still drawn from one, held across stops
  // (`chooseLineDiagramRun`). The rider's stop includes the stop point a complex's row leaves from.
  const boardingLocalStopId = departure?.boardingLocalStopId;
  const riderStopIds = useMemo(
    () => (boardingLocalStopId ? [stop.id, boardingLocalStopId] : [stop.id]),
    [boardingLocalStopId, stop.id],
  );
  // The stop's whole-trip readings: candidates for the drawn trip and a sibling's trip.
  const stopRunDepartures = useMemo(
    () =>
      lineDepartureBoards.find((board) => board.stopId === stop.id)?.departures ?? EMPTY_DEPARTURES,
    [lineDepartureBoards, stop.id],
  );
  // Held by id and read from the store, like every followed run.
  const [retainedLineRunId, setRetainedLineRunId] = useState<string>();
  const retainedLineRunIds = useMemo(
    () => (retainedLineRunId ? [retainedLineRunId] : NO_ROW_IDS),
    [retainedLineRunId],
  );
  const [retainedLineRun] = useRuns(retainedLineRunIds);
  const diagramDeparture = useMemo(
    () =>
      chooseLineDiagramRun({
        lineId: line.id,
        riderStopIds,
        pinnedDeparture: departure,
        retainedDeparture: retainedLineRun,
        preferredDestination,
        stopRunDepartures,
        boardDepartures: departureBoard?.departures ?? EMPTY_DEPARTURES,
      }),
    [
      riderStopIds,
      departure,
      departureBoard,
      retainedLineRun,
      line.id,
      preferredDestination,
      stopRunDepartures,
    ],
  );
  // Set during render, so the next reading finds it; never cleared, since an empty moment is what
  // the hold is for.
  if (diagramDeparture && diagramDeparture.id !== retainedLineRunId)
    setRetainedLineRunId(diagramDeparture.id);
  const drawnCalls = diagramDeparture?.tripCalls ?? EMPTY_TRIP_CALLS;
  // A whole-line reading extends the primary chain before finding the bundle trunk, so a short
  // working cannot hide the rest of the line or a sibling's leg.
  const isWholeLine = !departure;
  const drawnDiagramCalls = useMemo(() => [...drawnCalls].reverse(), [drawnCalls]);
  const farthestRun = useMemo(
    () => getFarthestLineRun(line, observedRunDepartures, drawnDiagramCalls),
    [drawnDiagramCalls, line, observedRunDepartures],
  );
  const wholeLineDiagramCalls = useMemo(
    () =>
      isWholeLine
        ? extendLineDiagramCalls(drawnDiagramCalls, farthestRun.calls)
        : drawnDiagramCalls,
    [drawnDiagramCalls, farthestRun.calls, isWholeLine],
  );
  const forkDrawnCalls = useMemo(
    () => (isWholeLine ? [...wholeLineDiagramCalls].reverse() : drawnCalls),
    [drawnCalls, isWholeLine, wholeLineDiagramCalls],
  );
  const forkDestination = isWholeLine
    ? (forkDrawnCalls[forkDrawnCalls.length - 1]?.stopName ?? diagramDeparture?.destination)
    : diagramDeparture?.destination;
  // The bundle's shared stretch and legs; without a sibling, the drawn trip.
  const fork = useLineDiagramFork({
    lineId: line.id,
    bundledLines,
    drawnCalls: forkDrawnCalls,
    destination: forkDestination,
    riderStopIds,
    // Whole line: every board along the lines. A pinned trip pairs only with trips at this stop.
    candidateDepartures: isWholeLine ? observedRunDepartures : stopRunDepartures,
  });
  const { branchesAhead, branchesBehind } = fork;
  const tripCalls = fork.calls;
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
  const diagramTripCalls = useMemo(() => [...tripCalls].reverse(), [tripCalls]);
  // A whole line names its farthest observed run; a bundle names its trunk, branches their own
  // ends.
  const [seenFirstTerminus, seenLastTerminus] = getLineTermini(line);
  const diagramCalls = diagramTripCalls;
  const drawnTermini = {
    firstTerminus: diagramCalls[0]?.stopName ?? seenFirstTerminus,
    lastTerminus: diagramCalls[diagramCalls.length - 1]?.stopName ?? seenLastTerminus,
  };
  const termini =
    isWholeLine && bundledLines.length === 0
      ? { firstTerminus: farthestRun.firstTerminus, lastTerminus: farthestRun.lastTerminus }
      : drawnTermini;
  // A whole line is ridden both ways, so a repeated stop's rows name both directions' platforms.
  const observedRunCalls = useMemo(
    () => (isWholeLine ? observedRunDepartures.map(({ tripCalls }) => tripCalls ?? []) : []),
    [isWholeLine, observedRunDepartures],
  );
  const diagramStops = useMemo(
    () => buildLineDiagramStops(network, diagramCalls, stop.id, observedRunCalls),
    [network, diagramCalls, stop.id, observedRunCalls],
  );
  // A list, so the layer stays memoized across ticks.
  const diagramStopNames = useMemo(
    () => diagramStops.map(({ stopName }) => stopName),
    [diagramStops],
  );
  // Sequences change only with observations, not every tick.
  const joinedPortionPairs = useMemo(
    () => getJoinedRunPortionPairs(visibleRunDepartures),
    [visibleRunDepartures],
  );
  // Built once and shared by the trunk and every leg.
  const turnaroundIndex = useMemo(
    () => findTurnarounds(visibleRunDepartures),
    [visibleRunDepartures],
  );
  const motions = useRunMotions();
  const vehicles = useMemo(
    () =>
      getShownLineDiagramVehicles(
        getLineDiagramVehicles(
          diagramStops,
          visibleRunDepartures,
          joinedPortionPairs,
          departure,
          feedNow,
          { motions, turnaroundIndex },
        ),
        isShowingOtherLineRuns,
      ),
    [
      diagramStops,
      visibleRunDepartures,
      joinedPortionPairs,
      departure,
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
    runDepartures: visibleRunDepartures,
    joinedPortionPairs,
    selectedDeparture: departure,
    feedNow,
    motions,
    turnaroundIndex,
    areOtherRunsShown: isShowingOtherLineRuns,
    trunkVehicles: vehicles,
  });
  const bundledLineIds = useMemo(() => bundledLines.map(({ id }) => id), [bundledLines]);
  // Only siblings whose shared corridor lies along the trip on screen.
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
    /** The pinned trip, held while the boards are re-keyed. */
    departure,
    fork,
    branches,
    lineById,
    bundleControls,
    diagramStops,
    diagramStopNames,
    // On a ride the rider is on board, at no stop.
    currentStopIndex: isRide ? -1 : getCurrentStopIndex(diagramStops, stop.id, boardingLocalStopId),
    // The stop chain is the coordinate system: a new chain remounts the marker layer so nothing
    // slides across. The drawn trip is not part of the key; it changes on refreshes.
    vehicleCoordinateKey: getLineDiagramCoordinateKey(line.id, diagramStops),
    vehicles,
    vehicleLabelByRowIndex,
    vehiclesByBranchKey,
    transferKeysByBranchKey,
    // A joined mark counts once per line, as the mark shows.
    totalVehicleCount: countLineDiagramVehicles([vehicles, ...vehiclesByBranchKey.values()]),
    // The pinned trip's position as a row, for the position control and initial placement: the
    // nearest row to its mark, else its next call.
    runPositionStopIndex: getRunPositionAnchorIndex(diagramStops, vehicles, rideNextCall),
    rowFeedNow,
    statusLabel: getLineDiagramStatusLabel(departure, departureBoard),
    // The pinned trip has no mark (not begun, over, or unplaceable). Uses the rows' coarse clock:
    // it states a call time, not a countdown.
    runPositionHint:
      diagramStops.length > 0
        ? getRunPositionHint(
            departure,
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
