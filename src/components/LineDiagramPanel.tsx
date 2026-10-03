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
import { useTransientScrollbar } from "../hooks/scrollbar";
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
  /** Siblings read with it, drawn only over the stretch all were observed running together. */
  bundledLines?: readonly TransitLine[];
  /** Siblings this stop's corridor could be read with. */
  bundleOffers?: readonly LineBundleOffer[];
  /** Adding or dropping a sibling; navigates, since the bundle is part of the address. */
  onChangeBundle?: (bundledLineIds: readonly string[]) => void;
  network: TransitNetwork;
  /** The stop this line was selected at, which this view steps back up to. */
  stop: TransitStop;
  departure?: Departure;
  /**
   * The addressed trip; unlike `departure` it does not blink during re-reads, so placement keys on
   * it.
   */
  addressId?: string;
  /** Where the rider was last heading on this line, so the diagram keeps its direction. */
  preferredDestination?: string;
  departureBoard: DepartureBoard | null;
  /** The stop's board plus samples along the line. */
  lineDepartureBoards: readonly DepartureBoard[];
  /**
   * The Zentrum observation boards, whose trips describe the lines met further out (for changes).
   */
  observationBoards: readonly DepartureBoard[];
  /** A ride: the diagram alone at full width, with room to state changes at every stop. */
  isRide: boolean;
  /** The rider's Ausstieg, drawn as the end of the ride still ahead. */
  alightingStopId?: string;
  /** Marking an Ausstieg: on a ride, a row tap toggles it. */
  onToggleAlighting?: (stopId: string) => void;
  /** Bumped when the rider asks to see the trip on the line. */
  runPositionRequest?: number;
  /**
   * The stop the ride runs towards, as the ride card reads it (possibly from the rider's position),
   * so the position control scrolls to the stop the card names.
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
  // What is drawn; everything below is where it goes.
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
  // One arrow per end: which end is on top is all the heading adds to the names.
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
  // On a ride a row tap sets the Ausstieg; elsewhere it moves the reading to that stop, keeping the
  // line and any pinned trip.
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
  // One leg; past the junction its vehicles are this line's alone.
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
        /* The first leg continues the trunk's rail; others join the junction by a horizontal this
           far. */
        connectorOffset={index}
        branchTransferKeys={
          index > 0 ? transferKeysByBranchKey.get(getLineBundleBranchKey(branch)) : undefined
        }
        rowFeedNow={rowFeedNow}
        /* Past the junction, the leg's stops open on its own line; the pinned trip only if it is
           that line's. */
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
  // Placement: see `useStopPlacement`. A ride moves only through the position control.
  useStopPlacement({
    placementKey: isRide ? null : (addressId ?? line.id),
    chainKey: vehicleCoordinateKey,
    containerRef: scrollContainerRef,
  });
  // Which way the rider's stop moved, so its note arrives from that side.
  const currentStopMove = useCurrentStopMove(currentStopIndex, vehicleCoordinateKey);
  useRequestedRunPosition(runPositionRequest, scrollContainerRef);
  useTransientScrollbar(scrollContainerRef);

  return (
    <div
      className={classNames(
        "line-diagram",
        isRide && "ride",
        departure && "has-selected-run",
        /* A fork's legs stand side by side, so the diagram takes a wider column while there is
           one. */
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
        {/* On a ride the status card is the heading; else the sign leads to the line. */}
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
          {/* The way into the ride; the step-up control is the way out. */}
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

      {/* The pinned trip's missing mark, explained in words. */}
      {runPositionHint && (
        <p className="line-diagram-trip-hint" role="status">
          {runPositionHint}
        </p>
      )}

      <div ref={scrollContainerRef} className="line-diagram-stops">
        {/* The fork at the end the line runs towards: one leg per line past the junction. */}
        {fork.terminatingAhead && (
          <p className="line-diagram-split ahead" role="status">
            {fork.terminatingAhead}
          </p>
        )}
        {branchesAhead.length > 0 && (
          <div
            className="line-diagram-fork ahead"
            /* An opened answer on a leg may take this fraction of the panel. */
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
        {/* The other end, for a stop the lines part at both ways. */}
        {branchesBehind.length > 0 && (
          <div
            className="line-diagram-fork behind"
            /* An opened answer on a leg may take this fraction of the panel. */
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
