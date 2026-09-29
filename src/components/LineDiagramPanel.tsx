import { useMemo, useRef } from "react";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransitStop,
  TripCall,
} from "../data/transit-types";
import { getDepartureAddressId, getSelectionPath, navigateTo, routePaths } from "../routing";
import { useTransientScrollbar } from "../hooks";
import { classNames } from "../lib/class-names";
import {
  getLineBundleBranchKey,
  getLineBundleTermini,
  type LineBundleBranch,
  type LineBundleOffer,
} from "../lib/line-bundles";
import { isCurrentLineDiagramStop } from "../lib/line-diagram";
import { isSameLineFamily } from "../lib/line-families";
import { LineDiagramStopRow } from "./line-diagram/LineDiagramStopRow";
import { LineDiagramVehicleLayer } from "./line-diagram/LineDiagramVehicleLayer";
import { LineDiagramBranch } from "./line-diagram/LineDiagramBranch";
import { LineDiagramBundleControls } from "./line-diagram/LineDiagramBundleControls";
import { LineDiagramLineSigns } from "./line-diagram/LineDiagramLineSigns";
import { EMPTY_LINE_BUNDLE_BRANCH_VEHICLES } from "./line-diagram/bundle";
import {
  useCurrentStopMove,
  useStopPlacement,
  useRequestedRunPosition,
  useVehicleLayerGeometry,
} from "./line-diagram/layout";
import { useLineDiagramReading } from "./line-diagram/reading";

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
  addressId?: string;
  /**
   * Where the rider was last heading on this line. A selected trip states its own direction; once
   * it has departed, this keeps the diagram pointing the same way instead of turning around.
   */
  preferredDestination?: string;
  departureBoard: DepartureBoard | null;
  /** The selected stop's board plus the samples taken along the line, its ends included. */
  lineDepartureBoards: readonly DepartureBoard[];
  /**
   * The Zentrum observation boards. Their trips are what the changes beside each stop are read from:
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
  /** Incremented by the ride status when the rider asks to see the trip on the line. */
  runPositionRequest?: number;
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
  bundledLines,
  bundleOffers,
  onChangeBundle,
  network,
  stop,
  departure: observedDeparture,
  addressId,
  preferredDestination,
  departureBoard,
  lineDepartureBoards,
  observationBoards,
  isRide,
  alightingStopId,
  onToggleAlighting,
  runPositionRequest = 0,
  rideNextCall,
}: LineDiagramPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stopListRef = useRef<HTMLDivElement>(null);
  // What is being drawn — the trip, the chain of stops, the marks on it and the words around them.
  // Everything below is where it goes on the screen.
  const {
    departure,
    fork,
    branches,
    lineById,
    bundleControls,
    diagramStops,
    diagramStopNames,
    currentStopIndex,
    vehicleCoordinateKey,
    vehicles,
    vehicleLabelByRowIndex,
    vehiclesByBranchKey,
    transferKeysByBranchKey,
    totalVehicleCount,
    runPositionStopIndex,
    rowFeedNow,
    statusLabel,
    runPositionHint,
    termini,
  } = useLineDiagramReading({
    line,
    bundledLines,
    bundleOffers,
    network,
    stop,
    departure: observedDeparture,
    addressId,
    preferredDestination,
    departureBoard,
    lineDepartureBoards,
    observationBoards,
    isRide,
    rideNextCall,
  });
  const { branchesAhead, branchesBehind, junctionAhead, junctionBehind, hasFork } = fork;
  const displayedLines = [line, ...(bundledLines ?? [])];
  const aheadTermini = getLineBundleTermini(branches, "ahead", termini.firstTerminus);
  const behindTermini = getLineBundleTermini(branches, "behind", termini.lastTerminus);
  const hasHeadingTermini = aheadTermini.length > 0 && behindTermini.length > 0;
  // One arrow per end, and no word for it. Which of the two ends is drawn at the top of the list is
  // the only thing the heading has to add to the names themselves, and an arrow says it in the room
  // a label would have taken from the names — which are what a reader actually steers by.
  const renderHeadingEnd = (arrow: "↑" | "↓", names: readonly string[]) => (
    <span
      className="line-diagram-heading-end"
      role="group"
      aria-label={`${arrow === "↑" ? "Oben" : "Unten"} Richtung ${names.join(" oder ")}`}
    >
      <i aria-hidden="true">{arrow}</i>
      <span
        className={classNames("line-diagram-termini", names.length > 1 && "branched")}
        aria-hidden="true"
      >
        {names.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </span>
    </span>
  );
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
                  bundledLineIds: (bundledLines ?? []).map(({ id }) => id),
                  addressId: departure && getDepartureAddressId(departure),
                }),
              ),
          },
    [bundledLines, departure, isRide, line.id, onToggleAlighting],
  );
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
        vehicles={
          vehiclesByBranchKey.get(getLineBundleBranchKey(branch)) ??
          EMPTY_LINE_BUNDLE_BRANCH_VEHICLES
        }
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
              addressId:
                departure && isSameLineFamily(departure.lineId, branch.lineId)
                  ? getDepartureAddressId(departure)
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
    placementKey: isRide ? null : (addressId ?? line.id),
    chainKey: vehicleCoordinateKey,
    containerRef: scrollContainerRef,
  });
  // Which way the rider's own stop travelled, so the note that marks it can arrive from the side it
  // came from — the one thing that moves when the rider walks along the line.
  const currentStopMove = useCurrentStopMove(currentStopIndex, vehicleCoordinateKey);
  useRequestedRunPosition(runPositionRequest, scrollContainerRef);
  useTransientScrollbar(scrollContainerRef);

  return (
    <div
      className={classNames(
        "line-diagram",
        isRide && "ride",
        departure && "has-selected-run",
        /* A fork is drawn as legs standing side by side, so the diagram is read in a wider column
           for as long as there is one. Said here rather than left to the stylesheet to notice,
           because it is the same thing `has-selected-run` is: what this diagram currently is. */
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
            <LineDiagramLineSigns
              lines={displayedLines}
              onClearRun={
                departure
                  ? () =>
                      navigateTo(
                        routePaths.line(
                          line.id,
                          stop.id,
                          (bundledLines ?? []).map(({ id }) => id),
                        ),
                      )
                  : undefined
              }
              clearRunLabel={
                departure
                  ? `Fahrt Richtung ${departure.destination} nicht mehr hervorheben, Linien ${displayedLines
                      .map(({ id }) => id)
                      .join(", ")} zeigen`
                  : undefined
              }
            />
            <h1>
              {departure ? (
                renderHeadingEnd("↑", [departure.destination])
              ) : hasHeadingTermini ? (
                <>
                  {renderHeadingEnd("↑", aheadTermini)}
                  {renderHeadingEnd("↓", behindTermini)}
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
              onClick={() => navigateTo(routePaths.ride(getDepartureAddressId(departure), stop.id))}
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
      {runPositionHint && (
        <p className="line-diagram-trip-hint" role="status">
          {runPositionHint}
        </p>
      )}

      <div ref={scrollContainerRef} className="line-diagram-stops">
        {/* The fork, at the end the line runs towards. Each leg is one bundled line past the stop
            they part at, drawn on its own chain and carrying its own vehicles; the trunk below
            names the junction once, and the legs run into it. */}
        {fork.terminatingAhead && (
          <p className="line-diagram-split ahead" role="status">
            {fork.terminatingAhead}
          </p>
        )}
        {branchesAhead.length > 0 && (
          <div
            className="line-diagram-fork ahead"
            /* How wide an answer opened on a leg may be is a fraction of the panel, and the fork
               is the only thing that knows which fraction. */
            style={{ "--line-diagram-fork-legs": branchesAhead.length } as React.CSSProperties}
          >
            {branchesAhead.map(renderBranch)}
          </div>
        )}
        <div
          ref={stopListRef}
          className="line-diagram-stop-list"
          data-current-stop-move={currentStopMove}
        >
          {diagramStops.map((diagramStop, index) => (
            <LineDiagramStopRow
              key={`${diagramStop.stopName}-${index}`}
              diagramStop={diagramStop}
              index={index}
              isCurrent={isCurrentLineDiagramStop(diagramStops, currentStopIndex, index)}
              vehicleLabel={vehicleLabelByRowIndex.get(index) ?? ""}
              isFirst={index === 0 && branchesAhead.length === 0}
              isLast={index === diagramStops.length - 1 && branchesBehind.length === 0}
              isSelectedDeparture={Boolean(departure)}
              isAlighting={Boolean(alightingStopId) && diagramStop.stopId === alightingStopId}
              isRunPositionAnchor={index === runPositionStopIndex}
              onActivate={onActivate}
              feedNow={rowFeedNow}
            />
          ))}
          <LineDiagramVehicleLayer
            key={vehicleCoordinateKey}
            vehicles={vehicles}
            lineById={lineById}
            stopNames={diagramStopNames}
            geometry={vehicleLayerGeometry}
          />
        </div>
        {/* And the other end: where the lines came together, for a bundle read from a stop they
            part at both ways round. */}
        {branchesBehind.length > 0 && (
          <div
            className="line-diagram-fork behind"
            /* How wide an answer opened on a leg may be is a fraction of the panel, and the fork
               is the only thing that knows which fraction. */
            style={{ "--line-diagram-fork-legs": branchesBehind.length } as React.CSSProperties}
          >
            {branchesBehind.map(renderBranch)}
          </div>
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
