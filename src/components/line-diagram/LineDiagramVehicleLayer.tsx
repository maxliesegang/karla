import { memo, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { TransitLine } from "../../data/transit-types";
import { getVehicleRowCoordinate, type LineDiagramVehicle } from "../../lib/line-diagram";
import { classNames } from "../../lib/class-names";
import { assignStableVehicleLanes } from "../../lib/vehicle-lanes";
import { useVehicleTrajectoryAnimations } from "../../hooks/vehicle-trajectory-animation";
import { useDeviceNow } from "../../hooks/clock";
import { getVehiclePositionSourceLabel } from "../../lib/vehicle-position-presentation";
import { getVehicleLeftOffset, type VehicleLayerGeometry } from "./layout";

/**
 * The marks, in one layer over the stop list. Animation is `useVehicleTrajectoryAnimations`; this
 * layer supplies coordinates that follow the rows, and re-measures (without carrying paint) when
 * the rows move, as they do when a pinned terminus grows a strip. Whether a mark travelled or was
 * placed comes from `RunPlacement.motion`, never from watching coordinates.
 *
 * Pointing at (or tapping) a mark opens it into a chip naming its destination, one at a time. The
 * layer is hidden from assistive technology; stop rows already name their vehicles.
 */
/** Shows the placement reading inside an opened mark, for debugging. */
const SHOW_VEHICLE_DEBUG_LABEL = false;
/** Debug reading of a mark's placement: row, link and share, and whether it was placed. */
const getVehicleDebugLabel = (
  {
    rowIndex,
    toIndex,
    progress,
    phase,
    motion,
  }: Pick<LineDiagramVehicle, "rowIndex" | "toIndex" | "progress" | "phase" | "motion">,
  stopNames: readonly string[] | undefined,
): string | undefined => {
  if (!stopNames) return undefined;
  const name = (index: number) => stopNames[index] ?? `#${index}`;
  const placed = motion === "placed" ? " · platziert" : "";
  if (phase === "running") {
    return `${name(rowIndex)} → ${Math.round(progress * 100)} % → ${name(toIndex)}${placed}`;
  }
  return `${name(rowIndex)} · ${
    phase === "beforeStart" ? "steht vor Abfahrt" : "Fahrt endet hier"
  }${placed}`;
};

function LineDiagramVehicleLayerView({
  vehicles,
  geometry,
  lineById,
  stopNames,
  branchTransferKeys,
}: {
  vehicles: readonly LineDiagramVehicle[];
  geometry: VehicleLayerGeometry;
  lineById: ReadonlyMap<string, TransitLine>;
  /** Every row's stop name, for the debug reading. */
  stopNames?: readonly string[];
  /** Marks that were on the shared trunk just before entering this branch. */
  branchTransferKeys?: ReadonlySet<string>;
}) {
  const readingNow = useDeviceNow();
  const layerRef = useRef<HTMLDivElement>(null);
  const [laneState, setLaneState] = useState(() => ({
    source: vehicles,
    layout: assignStableVehicleLanes(vehicles, new Map()),
  }));
  // The open mark, for devices without hover; one at a time.
  const [openMarkerKey, setOpenMarkerKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // Added before paint so re-measured offsets land silently; removed a frame later.
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

  /**
   * A mark's top offset, followed row by row since rows differ in height and links can span rows.
   */
  const getVehicleTopOffset = (vehicle: LineDiagramVehicle) => {
    const lastIndex = geometry.stopCenterOffsets.length - 1;
    const coordinate = getVehicleRowCoordinate(vehicle);
    const previousStopIndex = Math.min(lastIndex, Math.max(0, Math.floor(coordinate)));
    const nextStopIndex = Math.min(lastIndex, previousStopIndex + 1);
    const segmentProgress = Math.min(1, Math.max(0, coordinate - previousStopIndex));
    const previousStopCenter = geometry.stopCenterOffsets[previousStopIndex];
    const nextStopCenter = geometry.stopCenterOffsets[nextStopIndex];
    return previousStopCenter === undefined || nextStopCenter === undefined
      ? undefined
      : previousStopCenter + (nextStopCenter - previousStopCenter) * segmentProgress;
  };

  const getVehicleTransform = (vehicle: LineDiagramVehicle, progress = vehicle.progress) => {
    const topOffset = getVehicleTopOffset({ ...vehicle, progress });
    if (topOffset === undefined) return undefined;
    return `translate3d(${getVehicleLeftOffset(geometry.trackLeft, vehicle.laneIndex, vehicle.directionArrow)}, ${topOffset}px, 0) translate(calc(0px - var(--line-diagram-vehicle-anchor)), -50%)`;
  };

  let laneLayout = laneState.layout;
  if (laneState.source !== vehicles) {
    laneLayout = assignStableVehicleLanes(vehicles, laneState.layout.assignments);
    setLaneState({ source: vehicles, layout: laneLayout });
  }
  const stableVehicles = laneLayout.vehicles;

  // The marks drawn this render; one without a measured row offset is not drawn.
  const drawnMarks = stableVehicles.flatMap((vehicle) => {
    const topOffset = getVehicleTopOffset(vehicle);
    return topOffset === undefined ? [] : [{ vehicle, topOffset }];
  });

  // One geometry signature for every mark this pass, not re-joined per mark per tick.
  const geometrySignature = [geometry.trackLeft, geometry.stopCenterOffsets.join(",")].join(":");
  useVehicleTrajectoryAnimations({
    container: layerRef,
    marks: drawnMarks.flatMap(({ vehicle }) => [
      {
        ...vehicle,
        key: vehicle.markerKey,
        linkKey: `${vehicle.fromIndex}:${vehicle.toIndex}:${vehicle.laneIndex}`,
      },
    ]),
    geometrySignature,
    getValue: (mark, progress) => getVehicleTransform(mark, progress),
    // Every row boundary a link crosses is a keyframe.
    getBoundaryProgresses: (mark) => {
      const rowSpan = mark.toIndex - mark.fromIndex;
      return rowSpan === 0
        ? []
        : geometry.stopCenterOffsets.map((_, rowIndex) => (rowIndex - mark.fromIndex) / rowSpan);
    },
  });

  return (
    <div ref={layerRef} className="line-diagram-vehicle-layer" aria-hidden="true">
      {drawnMarks.map(({ vehicle, topOffset: vehicleTopOffset }) => {
        const {
          departure,
          joinedDepartures,
          markerKey,
          directionArrow,
          destinationLabel,
          rowIndex,
          toIndex,
          progress,
          phase,
          motion,
          isOtherRun,
          isSelected,
        } = vehicle;
        // Base offsets and lane step are CSS (wide panels fit labelled pills, narrow ones compact
        // marks); only the lane index is per vehicle. The pull-back is written out because the
        // anchor differs by tier.
        const transform =
          getVehicleTransform(vehicle) ??
          `translate3d(${getVehicleLeftOffset(geometry.trackLeft, vehicle.laneIndex, vehicle.directionArrow)}, ${vehicleTopOffset}px, 0) translate(calc(0px - var(--line-diagram-vehicle-anchor)), -50%)`;
        const markerLine = lineById.get(departure.lineId);
        const debugLabel = SHOW_VEHICLE_DEBUG_LABEL
          ? getVehicleDebugLabel({ rowIndex, toIndex, progress, phase, motion }, stopNames)
          : undefined;
        const sourceLabel = getVehiclePositionSourceLabel(
          departure,
          readingNow,
          vehicle.fromStopId,
          vehicle.toStopId,
        );
        return (
          <button
            type="button"
            // Hidden from assistive technology, so not keyboard-reachable either.
            tabIndex={-1}
            key={markerKey}
            data-marker-key={markerKey}
            className={classNames(
              "line-diagram-vehicle",
              `direction-${directionArrow === "↓" ? "down" : "up"}`,
              isOtherRun && "other-run",
              phase !== "running" && "standing",
              openMarkerKey === markerKey && "open",
              isSelected && "selected",
              branchTransferKeys?.has(markerKey) && "branch-transfer",
            )}
            data-selected-run-marker={isSelected || undefined}
            title={`Position geschätzt · ${sourceLabel}`}
            onClick={() =>
              setOpenMarkerKey((current) => (current === markerKey ? null : markerKey))
            }
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
            {phase === "beforeStart" ? (
              <svg className="line-diagram-vehicle-pause" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2" y="1" width="3" height="10" rx="1" />
                <rect x="7" y="1" width="3" height="10" rx="1" />
              </svg>
            ) : (
              directionArrow
            )}
            {/* The chip opens across the stop names; debug mode adds the placement. */}
            <small className="line-diagram-vehicle-destination">
              {destinationLabel}
              <span className="line-diagram-vehicle-source">{sourceLabel}</span>
              {debugLabel && <span className="line-diagram-vehicle-debug">{debugLabel}</span>}
            </small>
          </button>
        );
      })}
    </div>
  );
}

/** Parent ticks hand vehicles between links; motion within a link belongs to the browser. */
export const LineDiagramVehicleLayer = memo(LineDiagramVehicleLayerView);
