import { useCallback, useMemo, useRef, useState } from "react";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransitStop,
  TripCall,
} from "../data/transit-types";
import { getLineTermini } from "../lib/stop-services";
import { buildInterchangeIndex } from "../lib/interchanges";
import { getDepartureRouteId, getSelectionPath, navigateTo, routePaths } from "../routing";
import { useLineVehicleDepartures, useTransientScrollbar } from "../hooks";
import {
  getLineDiagramStatusLabel,
  getSelectedTripPositionHint,
} from "../lib/departure-presentation";
import { classNames } from "../lib/class-names";
import {
  buildLineDiagramStops,
  chooseLineDiagramTrip,
  countLineDiagramVehicles,
  getCurrentStopIndex,
  getLineDiagramCoordinateKey,
  getLineDiagramVehicleDepartures,
  getLineDiagramVehicles,
  getTripPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
} from "../lib/line-diagram";
import { getJoinedTripPortionPairs } from "../lib/joined-trip-portions";
import {
  createLineSelection,
  getLineBundleBranchKey,
  getLineBundleControls,
  type LineBundleBranch,
  type LineBundleOffer,
} from "../lib/line-bundles";
import { isSameLineFamily } from "../lib/line-families";
import { LineDiagramStopRow } from "./line-diagram/LineDiagramStopRow";
import { LineDiagramVehicleLayer } from "./line-diagram/LineDiagramVehicleLayer";
import { LineDiagramBranch } from "./line-diagram/LineDiagramBranch";
import { LineDiagramBundleControls } from "./line-diagram/LineDiagramBundleControls";
import {
  EMPTY_BRANCH_VEHICLES,
  useDrawableLineBundleOffers,
  useLineBundleBranchVehicles,
  useLineDiagramFork,
} from "./line-diagram/bundle";
import {
  EMPTY_VEHICLE_LAYER_GEOMETRY,
  useCoveredStopState,
  useCurrentStopMove,
  useRetainedDiagramTrip,
  useStopPlacement,
  useRequestedTripPosition,
  useVehicleLayerGeometry,
} from "./line-diagram/layout";

const EMPTY_TRIP_CALLS: readonly TripCall[] = [];
const EMPTY_DEPARTURES: readonly Departure[] = [];
const EMPTY_LINES: readonly TransitLine[] = [];
const EMPTY_OFFERS: readonly LineBundleOffer[] = [];
/** Fine enough that a call turns over within a few seconds of the minute it belongs to. */
const ROW_CLOCK_STEP_MS = 5_000;
/** Beside each stop of the ride. Off until there is an option to turn it back on. */
const SHOW_INTERCHANGES = false;

type LineDiagramPanelProps = {
  line: TransitLine;
  /**
   * The sibling lines being read together with it. They are drawn only over the stretch every one
   * of them has been observed running, and the diagram states where they part rather than carrying
   * one line's branch under both their names.
   */
  bundledLines?: readonly TransitLine[];
  /** The siblings this stop's corridor could be read with, as the visit has already observed it. */
  bundleOffers?: readonly LineBundleOffer[];
  /**
   * Adding or dropping a sibling. The bundle lives in the address like every other level of the
   * chain, so this navigates rather than sets: a bundled reading is a link a rider can share.
   */
  onChangeBundle?: (bundledLineIds: readonly string[]) => void;
  network: TransitNetwork;
  /** The stop this line was selected at: the level this view steps back up to. */
  stop: TransitStop;
  departure?: Departure;
  /**
   * The trip the address names, which is not the same thing as the trip the boards can currently
   * answer for. Walking along the line re-keys every board behind the trip, so the departure above
   * drops out for as long as they take; this does not, and it is therefore what both the hold on
   * the drawn trip and the diagram's own placement are keyed by.
   */
  tripId?: string;
  /**
   * Where the rider was last heading on this line. A selected trip states its own direction; once
   * it has departed, this keeps the diagram pointing the same way instead of turning around.
   */
  preferredDestination?: string;
  departureBoard: DepartureBoard | null;
  /** The selected stop's board plus the samples taken along the line, its ends included. */
  lineDepartureBoards: readonly DepartureBoard[];
  /**
   * The core observation boards. Their trips are what the changes beside each stop are read from:
   * a trip states every stop its line calls at, so boards taken elsewhere still describe the line
   * that meets this one further out.
   */
  observationBoards: readonly DepartureBoard[];
  /**
   * The ride: the diagram read on its own, with the departure board set aside. The rider is on the
   * trip rather than choosing one, so the whole width is the diagram's — which is what makes room
   * to state the changes at every stop. Beside a board there is no such room, and a half-list of
   * changes would be worse than none.
   */
  isRide: boolean;
  /** The stop the rider marked to get off at, drawn as the end of the part of the ride still ahead. */
  alightingStopId?: string;
  /**
   * Marking an Ausstieg. A rider already on board has no use for another stop's departure board, so
   * in the ride the row's tap is reused for the one choice they do have.
   */
  onToggleAlighting?: (stopId: string) => void;
  /** A stacked layout scrolls the document, so the diagram cannot scroll itself into position. */
  isStacked?: boolean;
  /** Incremented by the ride status when the rider asks to see the trip on the line. */
  tripPositionRequest?: number;
  /**
   * The stop the ride is running towards, as the ride card reads it. Handed down rather than read
   * again here, so the row the position control scrolls to is the same stop the card names — the
   * card's reading is the rider's own position where they have granted one, and this diagram has no
   * business deciding that question a second way. The vehicle marks are untouched by it: they stand
   * for every vehicle on the line, and the device can only speak for the one the rider is in.
   */
  rideNextCall?: TripCall;
};

export function LineDiagramPanel({
  line,
  bundledLines = EMPTY_LINES,
  bundleOffers = EMPTY_OFFERS,
  onChangeBundle,
  network,
  stop,
  departure: observedDeparture,
  tripId,
  preferredDestination,
  departureBoard,
  lineDepartureBoards,
  observationBoards,
  isRide,
  alightingStopId,
  onToggleAlighting,
  isStacked = false,
  tripPositionRequest = 0,
  rideNextCall,
}: LineDiagramPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stopListRef = useRef<HTMLDivElement>(null);
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
  const observedVehicleDepartures = useMemo(
    () =>
      getLineDiagramVehicleDepartures(
        lineSelection,
        vehicleObservationBoards.flatMap((board) => board.departures),
      ),
    [lineSelection, vehicleObservationBoards],
  );
  // Which board a trip was read from decides how old its mark is, and these boards are not read
  // together: the core observation runs slower than the line's own boards. Deduplication keeps the
  // departure objects themselves, so the board each one came off is still identifiable here.
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
      ),
    [departure, lineSelection, vehicleDepartures],
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
  const { branchesAhead, branchesBehind, junctionAhead, junctionBehind, hasFork } = fork;
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
  // A loaded trip states its own ends exactly; until one arrives, the ends the line was seen
  // running between stand in.
  const [seenFirstTerminus, seenLastTerminus] = getLineTermini(line);
  const termini =
    diagramTripCalls.length > 0
      ? {
          firstTerminus: diagramTripCalls[0].stopName,
          lastTerminus: diagramTripCalls[diagramTripCalls.length - 1].stopName,
        }
      : { firstTerminus: seenFirstTerminus, lastTerminus: seenLastTerminus };
  // A line outside the core network knows no termini until a trip loads, and half a heading around a
  // bare arrow says less than the line's own name.
  const hasTermini = Boolean(termini.firstTerminus && termini.lastTerminus);
  // Every board in hand contributes: the core observation sees the lines crossing the Zentrum, and
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
    () => buildLineDiagramStops(network, line, diagramTripCalls, interchangeIndex),
    [network, line, diagramTripCalls, interchangeIndex],
  );
  // A ride is nobody's stop — the rider is on board, not waiting at one.
  const currentStopIndex = isRide
    ? -1
    : getCurrentStopIndex(diagramStops, stop.id, boardingStopPointId);
  // The stop chain *is* the coordinate system, and a different one — another line, the other
  // direction, a variant calling elsewhere — has nothing to do with where a mark stood in the last.
  // Remounting only the marker layer places every vehicle directly in the new system, so no mark
  // slides across a diagram it was never travelling. Live ticks within one system keep the same
  // layer, and therefore keep their motion. The trip the diagram happens to be drawn from is not
  // part of this: it changes whenever a board refresh finds a nearer one, and remounting for that
  // took every mark off the screen and put it straight back.
  const vehicleCoordinateKey = getLineDiagramCoordinateKey(line.id, diagramStops);
  // Joining is route inference over complete sequences. Vehicle positions tick every second, but
  // those sequences change only with the observations that supplied them.
  const joinedTripPairs = useMemo(
    () => getJoinedTripPortionPairs(visibleVehicleDepartures),
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
      ),
    [diagramStops, visibleVehicleDepartures, joinedTripPairs, departure, feedNow],
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
    trunkVehicles: vehicles,
  });
  // A joined mark still contributes once for each line it represents, matching the number shown
  // on the mark itself.
  const totalVehicleCount = countLineDiagramVehicles([vehicles, ...vehiclesByBranchKey.values()]);
  // Where the pinned trip is on the line, as a real row rather than as the absolutely positioned
  // mark: the ride's position control scrolls to it, and so does the placement that answers picking
  // the trip off the board in the first place. The nearest row is stable under remeasurement;
  // before a mark can be placed, the next call is the best available statement of where this trip
  // is heading. Without a pinned trip no vehicle is the rider's, and the row is simply absent.
  const tripPositionStopIndex = getTripPositionAnchorIndex(diagramStops, vehicles, rideNextCall);
  // Rows are told the time in coarse steps: their readings are minutes, and holding the value still
  // between them is what lets a memoized row sit out the ticks that only moved a mark.
  const rowFeedNow = Math.floor(feedNow / ROW_CLOCK_STEP_MS) * ROW_CLOCK_STEP_MS;
  const statusLabel = getLineDiagramStatusLabel(departure, departureBoard);
  // A pinned trip the diagram carries no mark for: the run has not begun, it is over, or the calls
  // in hand do not place it. Read against the rows' coarse clock, because it states a call time and
  // never a countdown, and there is nothing in it for a tick that only moved a mark to recompute.
  const tripPositionHint =
    diagramStops.length > 0
      ? getSelectedTripPositionHint(
          departure,
          vehicles.some((vehicle) => vehicle.isSelected),
          rowFeedNow,
        )
      : undefined;
  // In the ride the row's tap is the one choice a rider on board still has: which stop they get off
  // at. Everywhere else a row is a stop of the line being read, so it moves the reading along that
  // line: the line — and the trip pinned on it, where there is one — stays chosen, and what changes
  // is which stop's board stands beside the diagram. Dropping the line here made every step along it
  // a step out of it, which is also what took the diagram off the screen instead of moving it.
  const onActivate = useMemo(
    () =>
      onToggleAlighting && isRide
        ? { kind: "mark" as const, run: onToggleAlighting }
        : {
            kind: "open" as const,
            run: (stopId: string) =>
              navigateTo(
                getSelectionPath({
                  stopId,
                  lineId: line.id,
                  tripId: departure && getDepartureRouteId(departure),
                }),
              ),
          },
    [departure, isRide, line.id, onToggleAlighting],
  );
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
  // A forked diagram has no single pair of ends: its top rows are the legs' termini, and the trunk
  // rows that would be pinned are ordinary stops the lines happen to part at. Standing in for the
  // stops out of view is the one thing those pinned rows do, so where there is a fork they do not.
  const coveredStops = useCoveredStopState({
    scrollContainerRef,
    isStacked: isStacked || hasFork,
    stopCount: diagramStops.length,
  });
  // One leg. Its vehicles are this line's alone: the trunk carries the bundled lines as far as they
  // run together, and past the junction a vehicle is on exactly one leg's links.
  const renderBranch = (branch: LineBundleBranch, index: number) => {
    const branchLine = lineById.get(branch.lineId);
    if (!branchLine) return null;
    return (
      <LineDiagramBranch
        key={getLineBundleBranchKey(branch)}
        branch={branch}
        line={branchLine}
        network={network}
        lineById={lineById}
        vehicles={vehiclesByBranchKey.get(getLineBundleBranchKey(branch)) ?? EMPTY_BRANCH_VEHICLES}
        selectedDeparture={departure}
        junctionStopName={branch.direction === "ahead" ? junctionAhead : junctionBehind}
        /* The first leg continues the trunk's own rail; every leg beyond it is joined to the
           junction by a horizontal, which is how far across the fork that horizontal has to run. */
        connectorOffset={index}
        branchTransferKeys={
          index > 0 ? transferKeysByBranchKey.get(getLineBundleBranchKey(branch)) : undefined
        }
        rowFeedNow={rowFeedNow}
        /* Past the junction only this line runs, so its stops are read on it alone — never on the
           bundle, which is a statement about a corridor that has ended here. The pinned trip comes
           along only where the leg is its own line's. */
        onOpenStop={(stopId) =>
          navigateTo(
            getSelectionPath({
              stopId,
              lineId: branch.lineId,
              tripId:
                departure && isSameLineFamily(departure.lineId, branch.lineId)
                  ? getDepartureRouteId(departure)
                  : undefined,
            }),
          )
        }
      />
    );
  };
  const vehicleLayerGeometry = useVehicleLayerGeometry({
    stopListRef,
    coordinateKey: vehicleCoordinateKey,
  });

  // A line opened at a stop stands on that stop; a trip pinned on it stands on where that trip
  // actually is. Walking to another stop of the line moves neither — see `useStopPlacement`. A ride
  // starts at its status card and moves to the diagram only through the explicit position control.
  useStopPlacement({
    placementKey: isRide ? null : (tripId ?? line.id),
    chainKey: vehicleCoordinateKey,
    containerRef: scrollContainerRef,
  });
  // Which way the rider's own stop travelled, so the note that marks it can arrive from the side it
  // came from — the one thing that moves when the rider walks along the line.
  const currentStopMove = useCurrentStopMove(currentStopIndex, vehicleCoordinateKey);
  useRequestedTripPosition(tripPositionRequest, scrollContainerRef);
  useTransientScrollbar(scrollContainerRef);

  return (
    <div
      className={classNames(
        "line-diagram",
        isRide && "ride",
        departure && "has-selected-trip",
        /* A fork is drawn as legs standing side by side, so the diagram is read in a wider column
           for as long as there is one. Said here rather than left to the stylesheet to notice,
           because it is the same thing `has-selected-trip` is: what this diagram currently is. */
        hasFork && "has-fork",
      )}
      style={
        {
          "--line-color": line.color,
          "--line-text": line.textColor,
        } as React.CSSProperties
      }
    >
      <div className="line-diagram-header">
        {/* In the ride the status card above is this view's heading, so the header keeps no name
            of its own: only the quiet meta — what the marks are, how the trip is running — and the
            step back up to the board. Beside a board the sign doubles as the way back to the whole
            line while a trip is pinned. */}
        {!isRide && (
          <>
            {departure ? (
              <button
                type="button"
                className="line-diagram-sign"
                onClick={() => navigateTo(routePaths.line(line.id, stop.id))}
                aria-label={`Fahrt Richtung ${departure.destination} nicht mehr hervorheben, ganze Linie ${line.id} zeigen`}
              >
                {line.id}
              </button>
            ) : (
              <span className="line-diagram-sign">{line.id}</span>
            )}
            <h1 className={departure ? "trip-destination" : undefined}>
              {departure ? (
                departure.destination
              ) : hasTermini ? (
                <>
                  <span>{termini.firstTerminus}</span>
                  <i aria-hidden="true">↔</i>
                  <span>{termini.lastTerminus}</span>
                </>
              ) : (
                line.name
              )}
            </h1>
          </>
        )}
        <div className="line-diagram-header-actions">
          {!isRide && onChangeBundle && (
            <LineDiagramBundleControls
              controls={bundleControls}
              lineById={lineById}
              fallbackLine={line}
              onChangeBundle={onChangeBundle}
            />
          )}
          {totalVehicleCount > 0 && (
            <details className="line-diagram-legend line-diagram-legend-compact">
              <summary
                aria-label={`${totalVehicleCount} Fahrzeug${totalVehicleCount === 1 ? "" : "e"}, Positionen geschätzt`}
              >
                <i aria-hidden="true" />
                <span aria-hidden="true">{totalVehicleCount}</span>
              </summary>
              <span className="line-diagram-legend-tooltip">
                Positionen aus den laufenden Fahrten geschätzt
              </span>
            </details>
          )}
          {/* The way into the ride, and only that. The way back out of it is the step-up control in
              the bar: a ride begun here is addressed `/from/this stop`, so stepping up returns to
              exactly this view. A second button here saying the same thing in different words was
              one more way back than there are places to go. */}
          {departure && !isRide && (
            <button
              type="button"
              className="line-diagram-ride-toggle"
              onClick={() => navigateTo(routePaths.ride(getDepartureRouteId(departure), stop.id))}
            >
              <i aria-hidden="true" />
              Fahrt begleiten
            </button>
          )}
          {statusLabel && <span className="chip">{statusLabel}</span>}
        </div>
      </div>

      {/* Between the heading and the line itself, where the missing mark is: the diagram draws the
          rider's trip, so the one thing it cannot draw is said in words rather than left blank. */}
      {tripPositionHint && (
        <p className="line-diagram-trip-hint" role="status">
          {tripPositionHint}
        </p>
      )}

      <div ref={scrollContainerRef} className="line-diagram-stops">
        {/* Same condition as the covered-stop spans: only a diagram that scrolls has stops its
            pinned ends stand in for, and only then do they cover the marks travelling past. */}
        {/* The fork, at the end the line runs towards. Each leg is one bundled line past the stop
            they part at, drawn on its own chain and carrying its own vehicles; the trunk below
            names the junction once, and the legs run into it. */}
        {fork.terminatingAhead && (
          <p className="line-diagram-split ahead" role="status">
            {fork.terminatingAhead}
          </p>
        )}
        {branchesAhead.length > 0 && (
          <div className="line-diagram-fork ahead">{branchesAhead.map(renderBranch)}</div>
        )}
        <div
          ref={stopListRef}
          className="line-diagram-stop-list"
          data-covers-hidden-stops={(!isStacked && coveredStops.isScrollable) || undefined}
          data-current-stop-move={currentStopMove}
        >
          {diagramStops.map((diagramStop, index) => (
            <LineDiagramStopRow
              key={`${diagramStop.stopName}-${index}`}
              diagramStop={diagramStop}
              index={index}
              currentStopIndex={currentStopIndex}
              vehicleLabel={vehicleLabelByRowIndex.get(index) ?? ""}
              isFirst={index === 0 && branchesAhead.length === 0}
              isLast={index === diagramStops.length - 1 && branchesBehind.length === 0}
              coveredStopSpan={
                !isStacked &&
                coveredStops.isScrollable &&
                (index === 0 || index === diagramStops.length - 1)
                  ? {
                      count: index === 0 ? coveredStops.aboveCount : coveredStops.belowCount,
                      direction: index === 0 ? "above" : "below",
                    }
                  : null
              }
              isSelectedTrip={Boolean(departure)}
              isAlighting={Boolean(alightingStopId) && diagramStop.stopId === alightingStopId}
              isTripPositionAnchor={index === tripPositionStopIndex}
              onActivate={onActivate}
              feedNow={rowFeedNow}
            />
          ))}
          <LineDiagramVehicleLayer
            key={vehicleCoordinateKey}
            vehicles={vehicles}
            lineById={lineById}
            geometry={
              vehicleLayerGeometry.coordinateKey === vehicleCoordinateKey
                ? vehicleLayerGeometry
                : EMPTY_VEHICLE_LAYER_GEOMETRY
            }
          />
        </div>
        {/* And the other end: where the lines came together, for a bundle read from a stop they
            part at both ways round. */}
        {branchesBehind.length > 0 && (
          <div className="line-diagram-fork behind">{branchesBehind.map(renderBranch)}</div>
        )}
        {fork.terminatingBehind && (
          <p className="line-diagram-split behind">{fork.terminatingBehind}</p>
        )}
        {diagramStops.length === 0 &&
          (departureBoard === null ? (
            <div className="panel-empty">
              <strong>Fahrtverlauf wird geladen …</strong>
            </div>
          ) : (
            <div className="panel-empty">
              <strong>Fahrtverlauf nicht verfügbar</strong>
              {departureBoard.dataStatus === "unavailable" && (
                <span>
                  {departureBoard.errorMessage ?? "Der KVV-Feed konnte nicht gelesen werden."}
                </span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
