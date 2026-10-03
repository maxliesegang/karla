import { useLayoutEffect, useRef, useState } from "react";
import { scrollIntoView } from "../../lib/scroll";

/**
 * Layout measurement for the line diagram: row centres, scroll extents, the addressed row. The only
 * place the diagram's class names and data attributes are queried.
 */

export type VehicleLayerGeometry = {
  coordinateKey: string;
  stopCenterOffsets: readonly number[];
  trackLeft: number;
};
const EMPTY_VEHICLE_LAYER_GEOMETRY: VehicleLayerGeometry = {
  coordinateKey: "",
  stopCenterOffsets: [],
  trackLeft: 0,
};

/**
 * A marker's horizontal coordinate as repeated additions: Safari before 18.2 rejects multiplication
 * in a transform's `calc()`. Lane indexes are small.
 */
export function getVehicleLeftOffset(
  trackLeft: number,
  laneIndex: number,
  directionArrow: "↑" | "↓",
): string {
  const operator = directionArrow === "↓" ? " - " : " + ";
  const laneSteps = Array.from(
    { length: Math.max(0, Math.floor(laneIndex)) },
    () => "var(--line-diagram-vehicle-lane-step)",
  ).join(operator);
  return `calc(${trackLeft}px + var(--line-diagram-vehicle-offset)${laneSteps ? `${operator}${laneSteps}` : ""})`;
}

/**
 * Scrolls the diagram only when something new is opened (a line, or a pinned trip), never when the
 * rider steps to another stop of the line. A pinned trip places on its vehicle, else the rider's
 * stop. Opening jumps; pinning a trip on an open line glides; a new stop chain jumps. Live data and
 * ticks never scroll.
 */
export function useStopPlacement({
  placementKey,
  chainKey,
  containerRef,
}: {
  /** The line or trip being read, never the stop. `null` places nothing. */
  placementKey: string | null;
  /** The stop chain; gliding only happens within one. */
  chainKey: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const placedRef = useRef<{ key: string; chainKey: string } | null>(null);

  // Wait until the target row (or the pinned trip's vehicle) exists; then the placement is spent.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!placementKey || !container) {
      placedRef.current = null;
      return;
    }
    const placed = placedRef.current;
    if (placed?.key === placementKey && placed.chainKey === chainKey) return;

    const stopRow =
      container.querySelector<HTMLElement>('[data-trip-position-anchor="true"]') ??
      container.querySelector<HTMLElement>('[data-current-stop="true"]');
    if (!stopRow) return;
    if (placed?.chainKey === chainKey) {
      scrollIntoView(stopRow, { block: "center" });
    } else {
      stopRow.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    }
    placedRef.current = { key: placementKey, chainKey };
  });
}

/**
 * Whether the rider's stop note moved within one diagram, derived during render so the motion is
 * on the element from its first commit. A new chain or a first appearance is no move.
 */
export type CurrentStopMove = "travelled" | undefined;

/** The rider's stop and the chain it was in; `-1` marks none. */
export type CurrentStopPlace = { index: number; chainKey: string };

/** Whether two places are one note that moved: same chain, different rows. */
export function describeCurrentStopMove(
  previous: CurrentStopPlace,
  next: CurrentStopPlace,
): CurrentStopMove {
  if (previous.chainKey !== next.chainKey) return undefined;
  if (previous.index < 0 || next.index < 0 || previous.index === next.index) return undefined;
  return "travelled";
}

export function useCurrentStopMove(currentStopIndex: number, chainKey: string): CurrentStopMove {
  const [previous, setPrevious] = useState<CurrentStopPlace & { move: CurrentStopMove }>({
    index: currentStopIndex,
    chainKey,
    move: undefined,
  });

  if (previous.index === currentStopIndex && previous.chainKey === chainKey) return previous.move;

  const next = { index: currentStopIndex, chainKey };
  const move = describeCurrentStopMove(previous, next);
  setPrevious({ ...next, move });
  return move;
}

/** A ride moves only when the rider asks to return to its position. */
export function useRequestedRunPosition(
  request: number,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const handledRequestRef = useRef(request);

  useLayoutEffect(() => {
    if (request === handledRequestRef.current) return;
    const anchor = containerRef.current?.querySelector<HTMLElement>(
      '[data-run-position-anchor="true"]',
    );
    // If the sequence is being replaced, fulfil the request next render.
    if (!anchor) return;
    anchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    handledRequestRef.current = request;
  });
}

/**
 * The node centre in stop-list coordinates. The node is centred by a transform, which does not
 * affect layout, so the measured offset is already the centre.
 */
export const getMeasuredNodeCenterOffset = (
  rowOffsetTop: number,
  trackOffsetTop: number,
  nodeOffsetTop: number,
): number => rowOffsetTop + trackOffsetTop + nodeOffsetTop;

/**
 * Measured row centres for the vehicle layer (rows differ in height). ResizeObserver re-measures on
 * layout changes; the tick reuses it. Returns nothing for the one render where the measurement
 * still belongs to the previous chain.
 */
export function useVehicleLayerGeometry({
  stopListRef,
  coordinateKey,
}: {
  stopListRef: React.RefObject<HTMLDivElement | null>;
  /** The chain the geometry belongs to; a new one is measured from scratch. */
  coordinateKey: string;
}): VehicleLayerGeometry {
  const [geometry, setGeometry] = useState(EMPTY_VEHICLE_LAYER_GEOMETRY);

  useLayoutEffect(() => {
    const stopList = stopListRef.current;
    if (!stopList) return;

    const stopRows = [...stopList.querySelectorAll<HTMLElement>("[data-line-diagram-stop-index]")];
    const measure = () => {
      const track = stopRows[0]?.querySelector<HTMLElement>(".line-diagram-track");
      const nextGeometry = {
        coordinateKey,
        // The node, not the row: it is where rail and marker meet.
        stopCenterOffsets: stopRows.map((row) => {
          const rowTrack = row.querySelector<HTMLElement>(".line-diagram-track");
          const node = rowTrack?.querySelector<HTMLElement>(".line-diagram-node");
          return rowTrack && node
            ? getMeasuredNodeCenterOffset(row.offsetTop, rowTrack.offsetTop, node.offsetTop)
            : row.offsetTop + row.offsetHeight / 2;
        }),
        trackLeft: track?.offsetLeft ?? 0,
      };
      setGeometry((current) =>
        current.coordinateKey === nextGeometry.coordinateKey &&
        current.trackLeft === nextGeometry.trackLeft &&
        current.stopCenterOffsets.length === nextGeometry.stopCenterOffsets.length &&
        current.stopCenterOffsets.every(
          (stopCenterOffset, index) => stopCenterOffset === nextGeometry.stopCenterOffsets[index],
        )
          ? current
          : nextGeometry,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stopList);
    stopRows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [coordinateKey, stopListRef]);

  return geometry.coordinateKey === coordinateKey ? geometry : EMPTY_VEHICLE_LAYER_GEOMETRY;
}
