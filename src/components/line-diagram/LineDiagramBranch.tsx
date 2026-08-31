import { useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import type { Departure, TransitLine, TransitNetwork } from "../../data/transit-types";
import type { LineBundleBranch } from "../../lib/line-bundles";
import type { LineDiagramVehicle } from "../../lib/line-diagram";
import {
  buildLineDiagramStops,
  getLineDiagramCoordinateKey,
  getTripPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
} from "../../lib/line-diagram";
import { classNames } from "../../lib/class-names";
import { LineDiagramStopRow } from "./LineDiagramStopRow";
import { LineDiagramVehicleLayer } from "./LineDiagramVehicleLayer";
import { useVehicleLayerGeometry } from "./layout";

/**
 * One leg of a forked line diagram: what a single bundled line does past the stretch the bundle is
 * drawn over.
 *
 * A leg is its own chain of stops and therefore its own coordinate system, which is exactly why it
 * is a component rather than more rows in the trunk's list. Everything the trunk does with a stop
 * chain — build its rows, place the vehicles on it, measure where its rows really sit — it does
 * here too, for this line alone. Marks hand over between the two lists at the junction: the trunk
 * carries every bundled line as far as they run together, and past that a vehicle is on one leg's
 * links and on no other list's.
 *
 * The junction itself is drawn as a stub rather than as a stop. It has to be *in* the chain — a
 * vehicle is placed on the link between two calls, and the first link of a leg has one end on the
 * trunk — but the trunk already names that stop, and naming it again on every leg would turn one
 * stop into three. So the stub is the track meeting the trunk, carrying the leg's own sign.
 */
export function LineDiagramBranch({
  branch,
  line,
  network,
  lineById,
  vehicles,
  selectedDeparture,
  junctionStopName,
  connectorOffset,
  branchTransferKeys,
  rowFeedNow,
  onOpenStop,
}: {
  branch: LineBundleBranch;
  /** This leg's own line, whose sign the stub carries and whose colour the leg is drawn in. */
  line: TransitLine;
  network: TransitNetwork;
  /** The line colours for vehicle marks, including a sibling on the shared trunk. */
  lineById: ReadonlyMap<string, TransitLine>;
  /** Already placed on this leg: the marks are this line's vehicles and no others. */
  vehicles: readonly LineDiagramVehicle[];
  selectedDeparture: Departure | undefined;
  /** The stop the lines part at, which the trunk names and this leg only points back to. */
  junctionStopName: string;
  /**
   * How many legs stand between this one and the trunk's own rail, which the first leg continues.
   * It is what the connector is drawn across: the legs are equal-width flex children, so the trunk
   * rail is exactly this many leg widths and gaps to the left of this leg's own. Zero draws none.
   */
  connectorOffset: number;
  /** Markers that were on the shared trunk immediately before entering this leg. */
  branchTransferKeys?: ReadonlySet<string>;
  /** The rows' coarse clock, so a tick that only moved a mark does not re-render them. */
  rowFeedNow: number;
  onOpenStop: (stopId: string) => void;
}) {
  const stopListRef = useRef<HTMLDivElement>(null);
  // Travel order reversed, the same way up as the trunk: the way ahead is drawn upwards, so a leg
  // ahead ends at its junction stub and a leg behind begins at one. Either way the stub is the row
  // that touches the trunk.
  const diagramTripCalls = useMemo(() => [...branch.calls].reverse(), [branch.calls]);
  const diagramStops = useMemo(
    () => buildLineDiagramStops(network, line, diagramTripCalls, null),
    [network, line, diagramTripCalls],
  );
  const junctionIndex = branch.direction === "ahead" ? diagramStops.length - 1 : 0;
  const coordinateKey = getLineDiagramCoordinateKey(line.id, diagramStops);
  const stopNames = useMemo(() => diagramStops.map(({ stopName }) => stopName), [diagramStops]);
  const vehicleLabelByRowIndex = useMemo(() => getVehicleLabelsByRowIndex(vehicles), [vehicles]);
  const geometry = useVehicleLayerGeometry({ stopListRef, coordinateKey });
  // The leg never states a next call of its own: the trip's own next call is read on the trunk, and
  // two lists both claiming the anchor would leave the position control scrolling to whichever the
  // document happened to hold first. A mark of this line out here is anchor enough.
  const tripPositionStopIndex = getTripPositionAnchorIndex(diagramStops, vehicles, undefined);
  const onActivate = useMemo(() => ({ kind: "open" as const, run: onOpenStop }), [onOpenStop]);

  return (
    <div
      className={classNames(
        "line-diagram-branch",
        branch.direction,
        connectorOffset > 0 && "connected",
      )}
      role="group"
      aria-label={
        branch.direction === "ahead"
          ? `${line.id} ab ${junctionStopName} nach ${branch.destination}`
          : `${line.id} von ${branch.destination} nach ${junctionStopName}`
      }
      style={
        {
          "--line-color": line.color,
          "--line-text": line.textColor,
          "--line-diagram-branch-offset": connectorOffset,
        } as CSSProperties
      }
    >
      <div ref={stopListRef} className="line-diagram-branch-list">
        {diagramStops.map((diagramStop, index) =>
          index === junctionIndex ? (
            /* The junction: the track running into the trunk, and the sign saying whose leg this
               is. It is measured like any row — the marks between it and the first stop of the leg
               travel across it — but it is not a stop, because the trunk below already is one. */
            <div
              key={`junction-${diagramStop.stopId}`}
              className="line-diagram-branch-junction"
              data-line-diagram-stop-index={index}
            >
              <span className="line-diagram-track" aria-hidden="true">
                <i className="line-diagram-node" />
              </span>
              <span className="line-diagram-branch-sign" aria-hidden="true">
                {line.id}
              </span>
            </div>
          ) : (
            <LineDiagramStopRow
              key={`${diagramStop.stopName}-${index}`}
              diagramStop={diagramStop}
              index={index}
              currentStopIndex={-1}
              vehicleLabel={vehicleLabelByRowIndex.get(index) ?? ""}
              isFirst={index === 0}
              isLast={index === diagramStops.length - 1}
              coveredStopSpan={null}
              isSelectedTrip={Boolean(selectedDeparture)}
              isAlighting={false}
              isTripPositionAnchor={index === tripPositionStopIndex}
              onActivate={onActivate}
              feedNow={rowFeedNow}
            />
          ),
        )}
        <LineDiagramVehicleLayer
          key={coordinateKey}
          vehicles={vehicles}
          lineById={lineById}
          stopNames={stopNames}
          branchTransferKeys={branchTransferKeys}
          geometry={geometry}
        />
      </div>
    </div>
  );
}
