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
import { createRunMotions } from "../../lib/vehicle-positioning";
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
/** Fine enough that a call turns over within a few seconds of the minute it belongs to. */
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
 * What the diagram draws, derived once from the boards in hand.
 *
 * Every answer here is a fact about the line and the trip on it — which trip is drawn, which way
 * up, which stops it runs through, where the vehicles are, what the ends are called. None of it is
 * about the element it is drawn into: scrolling, measurement and placement are `layout.ts`'s, and
 * the panel is left holding a reading and a shape rather than deriving both at once.
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
  // The rider's own choice about the line's other vehicles, read where the drawing is derived.
  const { isShowingOtherLineRuns } = useStoredPreference(appSettings);
  const vehicleObservationBoards = useMemo(
    () => [...observationBoards, ...lineDepartureBoards],
    [observationBoards, lineDepartureBoards],
  );
  // Every line being read, as one value: the marks, the drawn trip and the rows all answer to it,
  // and with no sibling it is exactly the line — the ordinary reading is the bundle of one.
  const lineSelection = useMemo(
    () =>
      createLineSelection(
        line.id,
        bundledLines.map(({ id }) => id),
      ),
    [bundledLines, line.id],
  );
  // Which board a copy of a run was read from decides how old its mark is, and these boards are not
  // read together: the Zentrum observation runs slower than the line's own boards. Every departure
  // states when it was read (`Departure.readAt`), so the contest between two boards' copies of one
  // run is settled without the boards having to be carried alongside their rows to settle it.
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
  // A retained ride may no longer occur on any departure board after a reload. It is still an
  // observed trip with a dated call sequence, so keep it eligible for its own marker; placement
  // itself drops it once that sequence says the run has ended.
  const visibleRunDepartures = useMemo(
    () =>
      getLineDiagramRunDepartures(
        lineSelection,
        departure ? [...runDepartures, departure] : runDepartures,
      ),
    [departure, lineSelection, runDepartures],
  );
  // Without a selected trip the diagram is still drawn from one, and which one it is decides which
  // way up the line is drawn. Held rather than chosen again at every stop — see
  // `chooseLineDiagramRun`, where the whole of that reasoning lives.
  //
  // The rider's stop is the addressed stop, plus the stop point the row actually leaves from where a
  // stop-complex page lists a departure from one of its other points.
  const boardingLocalStopId = departure?.boardingLocalStopId;
  const riderStopIds = useMemo(
    () => (boardingLocalStopId ? [stop.id, boardingLocalStopId] : [stop.id]),
    [boardingLocalStopId, stop.id],
  );
  // This stop's own whole-trip readings: the candidates for the drawn trip, and — where a sibling
  // is being read alongside — for the trip that sibling is drawn from.
  const stopRunDepartures = useMemo(
    () =>
      lineDepartureBoards.find((board) => board.stopId === stop.id)?.departures ?? EMPTY_DEPARTURES,
    [lineDepartureBoards, stop.id],
  );
  // Held by id and read back from the store, like every run a view follows.
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
  // Recorded while rendering, for the same reason the direction itself is: the next reading of this
  // diagram has to find it already there, or it would draw one frame of the line facing another way.
  // A moment with no board to draw from is not a reason to forget the last trip — it is exactly the
  // moment the hold exists for — so nothing is ever held back to `undefined`.
  if (diagramDeparture && diagramDeparture.id !== retainedLineRunId)
    setRetainedLineRunId(diagramDeparture.id);
  const drawnCalls = diagramDeparture?.tripCalls ?? EMPTY_TRIP_CALLS;
  // A line selection with no pinned trip describes the whole observed line, whether it is being
  // read alone or beside a sibling. Extend the primary chain before finding the shared trunk: if
  // the next trip at this stop is a short working, using it as the bundle's outer bound would hide
  // both the rest of this line and the sibling leg that only becomes visible beyond it.
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
  // The stretch a bundled reading is actually drawn over, and the legs at its ends. With no
  // sibling in the reading it is simply the drawn trip, which is the ordinary single-line diagram.
  const fork = useLineDiagramFork({
    lineId: line.id,
    bundledLines,
    drawnCalls: forkDrawnCalls,
    destination: forkDestination,
    riderStopIds,
    // At the line level, every board discovered along the selected lines gets to state their
    // dimensions. A pinned trip remains exact and is paired only with trips read at this stop.
    candidateDepartures: isWholeLine ? observedRunDepartures : stopRunDepartures,
  });
  const { branchesAhead, branchesBehind } = fork;
  const tripCalls = fork.calls;
  const branches = useMemo(
    () => [...branchesAhead, ...branchesBehind],
    [branchesAhead, branchesBehind],
  );
  // Which line each leg belongs to, for its sign and its colour. The primary is one of them: past
  // the junction it is a branch like any other, and drawing it as the continuation of the trunk
  // would say the corridor is really its line and the sibling merely joins it.
  const lineById = useMemo(() => {
    const byId = new Map<string, TransitLine>(
      network.lines.map((networkLine) => [networkLine.id, networkLine]),
    );
    byId.set(line.id, line);
    for (const bundled of bundledLines) byId.set(bundled.id, bundled);
    return byId;
  }, [bundledLines, line, network.lines]);
  // Trips arrive in travel order. Read the line diagram toward the destination by placing its last
  // call at the top; vehicle placement derives its arrows from this visible order as well.
  const diagramTripCalls = useMemo(() => [...tripCalls].reverse(), [tripCalls]);
  // A single whole-line selection names the farthest run any of its observation boards has reached.
  // A bundle names its shared trunk here; its branches carry their own observed outer ends.
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
  const diagramStops = useMemo(
    () => buildLineDiagramStops(network, diagramCalls),
    [network, diagramCalls],
  );
  // Row names for the vehicle marks' debug reading; a list keeps the layer memoized across ticks.
  const diagramStopNames = useMemo(
    () => diagramStops.map(({ stopName }) => stopName),
    [diagramStops],
  );
  // Joining is route inference over complete sequences. Vehicle positions tick every second, but
  // those sequences change only with the observations that supplied them.
  const joinedPortionPairs = useMemo(
    () => getJoinedRunPortionPairs(visibleRunDepartures),
    [visibleRunDepartures],
  );
  // Turnaround inference depends on observations, not the clock or the diagram shape. A bundled
  // reading places the same trips on its trunk and every leg, so build the index once and share it.
  const turnaroundIndex = useMemo(
    () => findTurnarounds(visibleRunDepartures),
    [visibleRunDepartures],
  );
  // The diagram's own memory of how its marks are moving, kept for as long as it is mounted.
  const [motions] = useState(createRunMotions);
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
  const vehicleLabelByRowIndex = useMemo(() => getVehicleLabelsByRowIndex(vehicles), [vehicles]);
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
  // Only the offers that would change the diagram: a sibling is offered where the corridor it
  // shares with this line lies along the trip actually on screen, and not merely where the stop has
  // seen the two run together at some other hour, in some other direction.
  const drawableOffers = useDrawableLineBundleOffers({
    offers: bundleOffers,
    drawnCalls,
    riderStopIds,
  });
  const bundleControls = useMemo(
    () => getLineBundleControls(bundledLineIds, drawableOffers),
    [bundledLineIds, drawableOffers],
  );

  // Rows are told the time in coarse steps: their readings are minutes, and holding the value still
  // between them is what lets a memoized row sit out the ticks that only moved a mark.
  const rowFeedNow = Math.floor(feedNow / ROW_CLOCK_STEP_MS) * ROW_CLOCK_STEP_MS;
  return {
    /** The trip the diagram is pinned on, held across the boards being re-keyed beneath it. */
    departure,
    fork,
    branches,
    lineById,
    bundleControls,
    diagramStops,
    diagramStopNames,
    // A ride is nobody's stop — the rider is on board, not waiting at one.
    currentStopIndex: isRide ? -1 : getCurrentStopIndex(diagramStops, stop.id, boardingLocalStopId),
    // The stop chain *is* the coordinate system, and a different one — another line, the other
    // direction, a variant calling elsewhere — has nothing to do with where a mark stood in the
    // last. Remounting only the marker layer places every vehicle directly in the new system, so no
    // mark slides across a diagram it was never travelling. Live ticks within one system keep the
    // same layer, and therefore keep their motion. The trip the diagram happens to be drawn from is
    // not part of this: it changes whenever a board refresh finds a nearer one, and remounting for
    // that took every mark off the screen and put it straight back.
    vehicleCoordinateKey: getLineDiagramCoordinateKey(line.id, diagramStops),
    vehicles,
    vehicleLabelByRowIndex,
    vehiclesByBranchKey,
    transferKeysByBranchKey,
    // A joined mark still contributes once for each line it represents, matching the number shown
    // on the mark itself.
    totalVehicleCount: countLineDiagramVehicles([vehicles, ...vehiclesByBranchKey.values()]),
    // Where the pinned trip is on the line, as a real row rather than as the absolutely positioned
    // mark: the ride's position control scrolls to it, and so does the placement that answers
    // picking the trip off the board in the first place. The nearest row is stable under
    // remeasurement; before a mark can be placed, the next call is the best available statement of
    // where this trip is heading. Without a pinned trip no vehicle is the rider's, and the row is
    // simply absent.
    runPositionStopIndex: getRunPositionAnchorIndex(diagramStops, vehicles, rideNextCall),
    rowFeedNow,
    statusLabel: getLineDiagramStatusLabel(departure, departureBoard),
    // A pinned trip the diagram carries no mark for: the run has not begun, it is over, or the calls
    // in hand do not place it. Read against the rows' coarse clock, because it states a call time
    // and never a countdown, and there is nothing in it for a tick that only moved a mark to
    // recompute.
    runPositionHint:
      diagramStops.length > 0
        ? getRunPositionHint(
            departure,
            // A mark standing at either end of the run is not the diagram placing the trip: the
            // sentence that says the run has not begun, or is over, is still the one to read.
            vehicles.some((vehicle) => vehicle.isSelected && vehicle.phase === "running"),
            rowFeedNow,
          )
        : undefined,
    termini,
    // A line outside the core network knows no termini until a trip loads, and half a heading around
    // a bare arrow says less than the line's own name.
    hasTermini: Boolean(termini.firstTerminus && termini.lastTerminus),
  };
}
