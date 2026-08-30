import { memo, useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { TransitLine } from "../../data/transit-types";
import type { LineDiagramVehicle } from "../../lib/line-diagram";
import { classNames } from "../../lib/class-names";
import type { VehicleLayerGeometry } from "./layout";

/**
 * The marks, drawn in one layer over the stop list.
 *
 * A mark moves for exactly one reason: the clock. It must not move because the diagram under it
 * changed height — and it does, unprompted: a pinned terminus grows a strip for the stops it covers
 * as the rider scrolls, and every row offset below it moves with the strip. So a fresh measurement
 * is painted without motion, and only a tick is animated. Position is carried on `transform` rather
 * than `top`, which keeps a travelling mark off the layout and paint path entirely.
 */
function LineDiagramVehicleLayerView({
  vehicles,
  geometry,
  lineById,
  branchTransferKeys,
}: {
  vehicles: readonly LineDiagramVehicle[];
  geometry: VehicleLayerGeometry;
  lineById: ReadonlyMap<string, TransitLine>;
  /** Markers that were on the shared trunk immediately before entering this branch. */
  branchTransferKeys?: ReadonlySet<string>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // Added before this render is painted, so the re-measured offsets land silently; lifted a whole
    // frame later, when there is no pending change left for a restored transition to pick up.
    layer.classList.add("remeasured");
    let settle = 0;
    const frame = requestAnimationFrame(() => {
      settle = requestAnimationFrame(() => layer.classList.remove("remeasured"));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settle);
    };
  }, [geometry]);

  const getVehicleTopOffset = (position: number) => {
    const lastIndex = geometry.stopCenterOffsets.length - 1;
    const previousStopIndex = Math.min(lastIndex, Math.max(0, Math.floor(position)));
    const nextStopIndex = Math.min(lastIndex, previousStopIndex + 1);
    const segmentProgress = Math.min(1, Math.max(0, position - previousStopIndex));
    const previousStopCenter = geometry.stopCenterOffsets[previousStopIndex];
    const nextStopCenter = geometry.stopCenterOffsets[nextStopIndex];
    return previousStopCenter === undefined || nextStopCenter === undefined
      ? undefined
      : previousStopCenter + (nextStopCenter - previousStopCenter) * segmentProgress;
  };

  return (
    <div ref={layerRef} className="line-diagram-vehicle-layer" aria-hidden="true">
      {vehicles.map(
        ({
          departure,
          joinedDepartures,
          markerKey,
          diagramPosition,
          directionArrow,
          laneIndex,
          isOtherTrip,
          isSelected,
        }) => {
          const vehicleTopOffset = getVehicleTopOffset(diagramPosition);
          if (vehicleTopOffset === undefined) return null;
          // The direction's base offset is CSS, measured from the rail itself: a wide panel has room
          // for labelled pills, a narrow one keeps compact marks on either side of the track. Only
          // the extra collision lane stays here because it belongs to this particular vehicle.
          const vehicleLaneOffset = laneIndex * 7;
          const vehicleLeftOffset = `calc(${geometry.trackLeft}px + var(--line-diagram-vehicle-offset) ${
            directionArrow === "↓" ? "-" : "+"
          } ${vehicleLaneOffset}px)`;
          // Centring stays part of the transform: a mark carries its whole position in one property.
          const transform = `translate3d(${vehicleLeftOffset}, ${vehicleTopOffset}px, 0) translate(-50%, -50%)`;
          const markerLine = lineById.get(departure.lineId);
          return (
            <b
              key={markerKey}
              className={classNames(
                "line-diagram-vehicle",
                `direction-${directionArrow === "↓" ? "down" : "up"}`,
                isOtherTrip && "other-trip",
                isSelected && "selected",
                branchTransferKeys?.has(markerKey) && "branch-transfer",
              )}
              data-selected-trip-marker={isSelected || undefined}
              style={
                {
                  transform,
                  ...(markerLine
                    ? {
                        "--line-color": markerLine.color,
                        "--line-text": markerLine.textColor,
                      }
                    : {}),
                } as CSSProperties
              }
            >
              <span>{departure.lineId}</span>
              {joinedDepartures.length > 1 && (
                <small className="line-diagram-vehicle-portions">{joinedDepartures.length}</small>
              )}
              {directionArrow}
            </b>
          );
        },
      )}
    </div>
  );
}

/** The clock ticks every second; nothing else here changes that often. */
export const LineDiagramVehicleLayer = memo(LineDiagramVehicleLayerView);
