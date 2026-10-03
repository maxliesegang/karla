import { useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import type { Departure, TransitLine, TransitNetwork } from "../../data/transit-types";
import type { LineBundleBranch } from "../../lib/line-bundles";
import type { LineDiagramVehicle } from "../../lib/line-diagram";
import {
  buildLineDiagramStops,
  getLineDiagramCoordinateKey,
  getRunPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
} from "../../lib/line-diagram";
import { classNames } from "../../lib/class-names";
import { LineDiagramStopRow } from "./LineDiagramStopRow";
import { LineDiagramVehicleLayer } from "./LineDiagramVehicleLayer";
import { useVehicleLayerGeometry } from "./layout";

/**
 * One leg of a forked line diagram: one bundled line past the shared stretch, with its own stop
 * chain, coordinates and vehicles. The junction is in the chain (a leg's first link starts on the
 * trunk) but drawn as a stub carrying the leg's sign, since the trunk already names the stop.
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
  /** This leg's line, for the stub's sign and the colour. */
  line: TransitLine;
  network: TransitNetwork;
  /** Line colours for marks, including siblings. */
  lineById: ReadonlyMap<string, TransitLine>;
  /** This leg's placed vehicles. */
  vehicles: readonly LineDiagramVehicle[];
  selectedDeparture: Departure | undefined;
  /** The stop the lines part at. */
  junctionStopName: string;
  /**
   * Legs between this one and the trunk's rail (equal-width flex children); the connector spans
   * them.
   */
  connectorOffset: number;
  /** Marks that were on the shared trunk just before entering this leg. */
  branchTransferKeys?: ReadonlySet<string>;
  /** The rows' coarse clock. */
  rowFeedNow: number;
  onOpenStop: (stopId: string) => void;
}) {
  const stopListRef = useRef<HTMLDivElement>(null);
  // Reversed like the trunk, so the stub is always the row touching the trunk.
  const diagramTripCalls = useMemo(() => [...branch.calls].reverse(), [branch.calls]);
  const diagramStops = useMemo(
    () => buildLineDiagramStops(network, diagramTripCalls),
    [network, diagramTripCalls],
  );
  const junctionIndex = branch.direction === "ahead" ? diagramStops.length - 1 : 0;
  const coordinateKey = getLineDiagramCoordinateKey(line.id, diagramStops);
  const stopNames = useMemo(() => diagramStops.map(({ stopName }) => stopName), [diagramStops]);
  const vehicleLabelByRowIndex = useMemo(() => getVehicleLabelsByRowIndex(vehicles), [vehicles]);
  const geometry = useVehicleLayerGeometry({ stopListRef, coordinateKey });
  // The leg never states a next call; the trunk does, so the position control has one anchor.
  const runPositionStopIndex = getRunPositionAnchorIndex(diagramStops, vehicles, undefined);
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
            /* The junction stub: measured like a row so marks cross it, but not a stop. */
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
              {/* Shown only while the legs are stacked. */}
              <span className="line-diagram-branch-junction-name" aria-hidden="true">
                ab {junctionStopName}
              </span>
            </div>
          ) : (
            <LineDiagramStopRow
              key={`${diagramStop.stopName}-${index}`}
              diagramStop={diagramStop}
              index={index}
              isCurrent={false}
              vehicleLabel={vehicleLabelByRowIndex.get(index) ?? ""}
              isFirst={index === 0}
              isLast={index === diagramStops.length - 1}
              isSelectedDeparture={Boolean(selectedDeparture)}
              isAlighting={false}
              isRunPositionAnchor={index === runPositionStopIndex}
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
