import { useCallback, useMemo, useState } from "react";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransitStop,
  TripCall,
} from "../../data/transit-types";
import { getFarthestLineRun, getLineTermini } from "../../lib/stop-services";
import { findTurnarounds, type TurnaroundIndex } from "../../lib/line-turnarounds";
import { buildInterchangeIndex } from "../../lib/interchanges";
import { useLineVehicleDepartures } from "../../hooks";
import {
  getLineDiagramStatusLabel,
  getSelectedTripPositionHint,
} from "../../lib/departure-presentation";
import {
  buildLineDiagramStops,
  chooseLineDiagramTrip,
  countLineDiagramVehicles,
  extendLineDiagramCalls,
  getCurrentStopIndex,
  getLineDiagramCoordinateKey,
  getLineDiagramVehicleDepartures,
  getLineDiagramVehicles,
  getTripPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
} from "../../lib/line-diagram";
import { getJoinedTripPortionPairs } from "../../lib/joined-trip-portions";
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
import { useRetainedDiagramTrip } from "./layout";

const EMPTY_TRIP_CALLS: readonly TripCall[] = [];
const EMPTY_DEPARTURES: readonly Departure[] = [];
const EMPTY_LINES: readonly TransitLine[] = [];
const EMPTY_OFFERS: readonly LineBundleOffer[] = [];
/** Fine enough that a call turns over within a few seconds of the minute it belongs to. */
const ROW_CLOCK_STEP_MS = 5_000;
/** Beside each stop of the ride. Off until there is an option to turn it back on. */
const SHOW_INTERCHANGES = false;
/**
 * The turnaround reading. On, a vehicle at an end of its run is drawn standing there — a departure
 * waiting at its first stop from the lead before it is due away, extended back to the arrival it
 * turns back out of where the pairing found one — and the pairing draws that stand once rather
 * than twice. Off for now: the diagram draws only vehicles its calls place between stops, a
 * terminus stands empty between one run ending and the next setting out, and an arrival keeps
 * nothing but its own short grace.
 */
const SHOW_TURNAROUND_VEHICLES = false;
/** The index that hands down while the toggle above is off: a pairing with nothing in it. */
const EMPTY_TURNAROUND_INDEX: TurnaroundIndex = {
  turningDepartureKeyByArrivalKey: new Map(),
  standFromByDepartureKey: new Map(),
};

export type LineDiagramReadingInput = {
  line: TransitLine;
  bundledLines?: readonly TransitLine[];
  bundleOffers?: readonly LineBundleOffer[];
  network: TransitNetwork;
  stop: TransitStop;
  departure?: Departure;
  tripId?: string;
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
  departure: observedDeparture,
  tripId,
  preferredDestination,
  departureBoard,
  lineDepartureBoards,
  observationBoards,
  isRide,
  rideNextCall,
}: LineDiagramReadingInput) {
  // Everything below draws the addressed trip, whether or not a board can answer for it this
  // instant. The one thing that must not wait for the boards is which stop is the rider's: they
  // chose it by tapping a row of this diagram, and it is the only thing their tap changed.
  const departure = useRetainedDiagramTrip(tripId, observedDeparture);
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
  // Which board a trip was read from decides how old its mark is, and these boards are not read
  // together: the Zentrum observation runs slower than the line's own boards. Deduplication keeps the
  // departure objects themselves, so the board each one came off is still identifiable here — and
  // it is what lets a contest between two boards' copies of one vehicle be settled by age.
  const observedAtByDeparture = useMemo(() => {
    const observedAt = new Map<Departure, number>();
    for (const board of vehicleObservationBoards) {
      for (const departure of board.departures) observedAt.set(departure, board.receivedAt);
    }
    return observedAt;
  }, [vehicleObservationBoards]);
  // A departure no board contributed is one this render added beside them, so the newest reading in
  // hand is the closest honest stamp for it.
  const newestObservedAt = Math.max(
    0,
    ...vehicleObservationBoards.map((board) => board.receivedAt),
  );
  const getVehicleObservedAt = useCallback(
    (departure: Departure) => observedAtByDeparture.get(departure) ?? newestObservedAt,
    [newestObservedAt, observedAtByDeparture],
  );
  const observedVehicleDepartures = useMemo(
    () =>
      getLineDiagramVehicleDepartures(
        lineSelection,
        vehicleObservationBoards.flatMap((board) => board.departures),
        getVehicleObservedAt,
      ),
    [getVehicleObservedAt, lineSelection, vehicleObservationBoards],
  );
  const { vehicleDepartures, feedNow } = useLineVehicleDepartures(
    lineSelection.lineId,
    observedVehicleDepartures,
    getVehicleObservedAt,
    departureBoard,
    isRide,
  );
  // A retained ride may no longer occur on any departure board after a reload. It is still an
  // observed trip with a dated call sequence, so keep it eligible for its own marker; placement
  // itself drops it once that sequence says the run has ended.
  const visibleVehicleDepartures = useMemo(
    () =>
      getLineDiagramVehicleDepartures(
        lineSelection,
        departure ? [...vehicleDepartures, departure] : vehicleDepartures,
        getVehicleObservedAt,
      ),
    [departure, getVehicleObservedAt, lineSelection, vehicleDepartures],
  );
  // Without a selected trip the diagram is still drawn from one, and which one it is decides which
  // way up the line is drawn. Held rather than chosen again at every stop — see
  // `chooseLineDiagramTrip`, where the whole of that reasoning lives.
  //
  // The rider's own stop is the one the address names, and it is asked for rather than read off the
  // departure because the address is the statement of it that does not blink: the board behind the
  // row is re-keyed by every step along the line, so `observedDeparture` — and the stop point it
  // names — is absent for as long as the new stop's boards take to answer. A board row does state
  // its physical boarding stop separately, and that is what answers where a stop-complex page lists
  // a departure leaving from one of its other points; both are the rider's stop, so both are what
  // the line is held by. A ride is nobody's stop — the rider is on board, not waiting at one — but
  // the line it is drawn on is still a line whose stops the trip states.
  const boardingStopPointId = observedDeparture?.boardingStopId;
  const riderStopIds = useMemo(
    () => (boardingStopPointId ? [stop.id, boardingStopPointId] : [stop.id]),
    [boardingStopPointId, stop.id],
  );
  // This stop's own whole-trip readings: the candidates for the drawn trip, and — where a sibling
  // is being read alongside — for the trip that sibling is drawn from.
  const stopTripDepartures = useMemo(
    () =>
      lineDepartureBoards.find((board) => board.stopId === stop.id)?.departures ?? EMPTY_DEPARTURES,
    [lineDepartureBoards, stop.id],
  );
  const [heldLineTrip, setHeldLineTrip] = useState<Departure | undefined>(undefined);
  const diagramDeparture = useMemo(
    () =>
      chooseLineDiagramTrip({
        lineId: line.id,
        riderStopIds,
        pinnedDeparture: departure,
        heldDeparture: heldLineTrip,
        preferredDestination,
        stopTripDepartures,
        boardDepartures: departureBoard?.departures ?? EMPTY_DEPARTURES,
      }),
    [
      riderStopIds,
      departure,
      departureBoard,
      heldLineTrip,
      line.id,
      preferredDestination,
      stopTripDepartures,
    ],
  );
  // Recorded while rendering, for the same reason the direction itself is: the next reading of this
  // diagram has to find it already there, or it would draw one frame of the line facing another way.
  // A moment with no board to draw from is not a reason to forget the last trip — it is exactly the
  // moment the hold exists for — so nothing is ever held back to `undefined`.
  if (diagramDeparture && diagramDeparture !== heldLineTrip) setHeldLineTrip(diagramDeparture);
  const drawnCalls = diagramDeparture?.tripCalls ?? EMPTY_TRIP_CALLS;
  // The stretch a bundled reading is actually drawn over, and the legs at its ends. With no
  // sibling in the reading it is simply the drawn trip, which is the ordinary single-line diagram.
  const fork = useLineDiagramFork({
    lineId: line.id,
    bundledLines,
    drawnCalls,
    destination: diagramDeparture?.destination,
    riderStopIds,
    stopTripDepartures,
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
  // A whole-line selection names the furthest run any of its observation boards has reached — and
  // now draws it. The trip that happens to be drawn may be a short working, which is its own end
  // and not the line's, so the chain is read out to that run: the stops past its ends come onto the
  // diagram, and with them the vehicles running where the short working never went. A bundle
  // remains the shared trunk actually drawn here, whose forks name their own outer ends.
  const [seenFirstTerminus, seenLastTerminus] = getLineTermini(line);
  const farthestRun = useMemo(
    () => getFarthestLineRun(line, observedVehicleDepartures, diagramTripCalls),
    [diagramTripCalls, line, observedVehicleDepartures],
  );
  const isWholeLine = !departure && bundledLines.length === 0;
  const diagramCalls = useMemo(
    () =>
      isWholeLine ? extendLineDiagramCalls(diagramTripCalls, farthestRun.calls) : diagramTripCalls,
    [diagramTripCalls, farthestRun.calls, isWholeLine],
  );
  const drawnTermini = {
    firstTerminus: diagramCalls[0]?.stopName ?? seenFirstTerminus,
    lastTerminus: diagramCalls[diagramCalls.length - 1]?.stopName ?? seenLastTerminus,
  };
  const termini = isWholeLine
    ? { firstTerminus: farthestRun.firstTerminus, lastTerminus: farthestRun.lastTerminus }
    : drawnTermini;
  // Every board in hand contributes: the Zentrum observation sees the lines crossing the Zentrum, and
  // this line's own boards see the lines meeting it further out. Trips shared by two boards are
  // deduplicated, so the overlap costs nothing. Beside a departure board no changes are shown, so
  // the index is not built either.
  const interchangeIndex = useMemo(
    () =>
      isRide && SHOW_INTERCHANGES
        ? buildInterchangeIndex([...observationBoards, ...lineDepartureBoards])
        : null,
    [isRide, observationBoards, lineDepartureBoards],
  );
  const diagramStops = useMemo(
    () => buildLineDiagramStops(network, line, diagramCalls, interchangeIndex),
    [network, line, diagramCalls, interchangeIndex],
  );
  // Row names for the vehicle marks' debug reading; a list keeps the layer memoized across ticks.
  const diagramStopNames = useMemo(
    () => diagramStops.map(({ stopName }) => stopName),
    [diagramStops],
  );
  // Joining is route inference over complete sequences. Vehicle positions tick every second, but
  // those sequences change only with the observations that supplied them.
  const joinedTripPairs = useMemo(
    () => getJoinedTripPortionPairs(visibleVehicleDepartures),
    [visibleVehicleDepartures],
  );
  // Turnaround inference depends on observations, not the clock or the diagram shape. A bundled
  // reading places the same trips on its trunk and every leg, so build the index once and share it.
  // Off while the toggle above is: an empty index pairs nothing, so neither the trunk nor a leg
  // draws the inferred stand.
  const turnaroundIndex = useMemo(
    () =>
      SHOW_TURNAROUND_VEHICLES ? findTurnarounds(visibleVehicleDepartures) : EMPTY_TURNAROUND_INDEX,
    [visibleVehicleDepartures],
  );
  const vehicles = useMemo(
    () =>
      getLineDiagramVehicles(
        diagramStops,
        visibleVehicleDepartures,
        joinedTripPairs,
        departure,
        feedNow,
        { turnaroundIndex, showWaitingVehicles: SHOW_TURNAROUND_VEHICLES },
      ),
    [diagramStops, visibleVehicleDepartures, joinedTripPairs, departure, feedNow, turnaroundIndex],
  );
  const vehicleLabelByRowIndex = useMemo(() => getVehicleLabelsByRowIndex(vehicles), [vehicles]);
  const { vehiclesByBranchKey, transferKeysByBranchKey } = useLineBundleBranchVehicles({
    branches,
    lineById,
    network,
    vehicleDepartures: visibleVehicleDepartures,
    joinedTripPairs,
    selectedDeparture: departure,
    feedNow,
    turnaroundIndex,
    showWaitingVehicles: SHOW_TURNAROUND_VEHICLES,
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
    currentStopIndex: isRide ? -1 : getCurrentStopIndex(diagramStops, stop.id, boardingStopPointId),
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
    tripPositionStopIndex: getTripPositionAnchorIndex(diagramStops, vehicles, rideNextCall),
    rowFeedNow,
    statusLabel: getLineDiagramStatusLabel(departure, departureBoard),
    // A pinned trip the diagram carries no mark for: the run has not begun, it is over, or the calls
    // in hand do not place it. Read against the rows' coarse clock, because it states a call time
    // and never a countdown, and there is nothing in it for a tick that only moved a mark to
    // recompute.
    tripPositionHint:
      diagramStops.length > 0
        ? getSelectedTripPositionHint(
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
