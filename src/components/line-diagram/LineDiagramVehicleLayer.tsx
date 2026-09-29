import { memo, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { TransitLine } from "../../data/transit-types";
import { getVehicleRowCoordinate, type LineDiagramVehicle } from "../../lib/line-diagram";
import { classNames } from "../../lib/class-names";
import { assignStableVehicleLanes } from "../../lib/vehicle-lanes";
import { useVehicleTrajectoryAnimations } from "../../hooks/vehicle-trajectory-animation";
import { getVehicleLeftOffset, type VehicleLayerGeometry } from "./layout";

/**
 * The marks, drawn in one layer over the stop list.
 *
 * A mark moves on one segment-long Web Animation whose duration ends at the next expected arrival;
 * `useVehicleTrajectoryAnimations` owns how the animation is kept, and this layer owns only where
 * its coordinates are: transforms that follow the rows rather than one straight between the two
 * ends, and a geometry signature that re-measures when the rows move. It must not move because the
 * diagram under it changed height — and it does, unprompted: a pinned terminus grows a strip for
 * covered stops as the rider scrolls. Geometry changes therefore cancel and recreate the same
 * domain trajectory in the newly measured coordinate system, without carrying the old paint.
 *
 * The distinction about the mark's own position — travel animated, a placement painted where it
 * belongs — is the placement's to state (`RunPlacement.motion`), and the shared hook reads it
 * from the mark. This layer deliberately does not try to work that out for itself by watching
 * coordinates jump: the two are indistinguishable from here, since a mark making up several
 * minutes and a mark being repositioned move the same distance in the same tick, and only the
 * module that placed it knows which happened.
 *
 * A mark also answers one question about itself: where its trip is going. It is asked by pointing
 * at the mark, and on a device with no pointer by tapping it, and the mark answers by opening into
 * a chip with the destination in it — one mark at a time, over the stop names beside it, and closed
 * again the moment the rider looks elsewhere. Nothing is spoken here: the layer is hidden from
 * assistive technology and every stop row already names the vehicles standing behind it.
 */
/**
 * The placement reading inside an opened mark, enabled while vehicle placement is being debugged.
 */
const SHOW_VEHICLE_DEBUG_LABEL = false;
/**
 * Debug reading of where a mark stands, for whoever is looking for a placement bug: the row the
 * placement has it at — the stand of a turnaround included — the link and share of it while it
 * runs, and whether it was placed there rather than having travelled. Names fall back to row
 * numbers where the rows in hand do not cover the link.
 */
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
  /** The stop name of every row, so the debug reading can name where a mark stands. */
  stopNames?: readonly string[];
  /** Markers that were on the shared trunk immediately before entering this branch. */
  branchTransferKeys?: ReadonlySet<string>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [laneState, setLaneState] = useState(() => ({
    source: vehicles,
    layout: assignStableVehicleLanes(vehicles, new Map()),
  }));
  // Which mark is open, where a rider has no hover to open one with. One at a time: two chips over
  // the same names would be two answers to a question asked about one of them.
  const [openMarkerKey, setOpenMarkerKey] = useState<string | null>(null);
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

  /**
   * Where on the rail a mark on this link stands, followed row by row rather than as one straight
   * line between the two ends. Rows differ in height — call times, qualifiers, the rider's own stop
   * — and a link that spans more than one of them, which a working skipping stops this diagram
   * draws is on, would otherwise cross the ones between at the wrong pace.
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

  // The marks this render actually draws, in the order the layer draws them: a vehicle whose row
  // offset cannot be measured yet is not one of them.
  const drawnMarks = stableVehicles.flatMap((vehicle) => {
    const topOffset = getVehicleTopOffset(vehicle);
    return topOffset === undefined ? [] : [{ vehicle, topOffset }];
  });

  // A segment is one browser animation, not a succession of one-second CSS transitions. A feed
  // revision changes the trajectory signature, so the old animation is cancelled and the
  // remaining distance starts from the exact progress the domain model sampled at that refresh.
  // One statement of the coordinate system every mark of this pass is planned in: it is the same
  // for all of them, and a diagram of forty rows would otherwise re-join those offsets into a
  // string for every mark on it, every second.
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
    getTransform: (mark, progress) => getVehicleTransform(mark, progress),
    // A mark that skips stops crosses each row it passes on its own clock, so every row boundary
    // is a keyframe; the trajectory's own sampling narrows these to the ones still ahead.
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
        // The direction's base offset is CSS, measured from the rail itself: a wide panel has room
        // for labelled pills, a narrow one keeps compact marks on either side of the track. Only
        // which lane this vehicle is in stays here, because that belongs to this vehicle; how far
        // a lane steps is CSS again, since a fan that fits beside a labelled pill would walk a
        // compact mark off the edge of a narrow panel.
        // The mark carries its whole position in one property. Closed marks have one known width,
        // so both directions are centred evenly around the spine without either edge approaching
        // the panel boundary. Vertically they remain centred as their position changes. The
        // pull-back is written out here rather than read from a variable of its own: the anchor
        // is declared on the mark and differs by tier, and a variable declared on the layer would
        // have frozen the widest tier's half-width into every narrow mark below it.
        const transform =
          getVehicleTransform(vehicle) ??
          `translate3d(${getVehicleLeftOffset(geometry.trackLeft, vehicle.laneIndex, vehicle.directionArrow)}, ${vehicleTopOffset}px, 0) translate(calc(0px - var(--line-diagram-vehicle-anchor)), -50%)`;
        const markerLine = lineById.get(departure.lineId);
        const debugLabel = SHOW_VEHICLE_DEBUG_LABEL
          ? getVehicleDebugLabel({ rowIndex, toIndex, progress, phase, motion }, stopNames)
          : undefined;
        return (
          <button
            type="button"
            // The layer is hidden from assistive technology, so this must not be reachable by
            // keyboard either; it is a way to point at a mark, never a control of its own.
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
            {/* The mark's own answer, carried inside it: the chip opens across the stop names —
                  the one part of the row with the width for a name — and closes back to a mark.
                  Under the destination, where a placement is being debugged, it also states where
                  the placement has the vehicle standing. */}
            <small className="line-diagram-vehicle-destination">
              {destinationLabel}
              {debugLabel && <span className="line-diagram-vehicle-debug">{debugLabel}</span>}
            </small>
          </button>
        );
      })}
    </div>
  );
}

/** Parent ticks still hand vehicles between links; motion within a link belongs to the browser. */
export const LineDiagramVehicleLayer = memo(LineDiagramVehicleLayerView);
