import { type CSSProperties, useMemo, useRef, type RefObject } from "react";
import { useVehicleTrajectoryAnimations, type TrajectoryAnimationFields } from "../../hooks";
import {
  getZentrumVehicleTransform,
  toZentrumCanvasLeft,
  toZentrumCanvasRun,
  toZentrumCanvasTop,
} from "../../lib/zentrum-plan-canvas";
import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import {
  ZENTRUM_SCHEMATIC_NODES,
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type ZentrumSchematicBoardingPlace,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
} from "../../lib/zentrum-schematic-plan";
import { getZentrumSchematicDrawnPaths } from "../../lib/zentrum-schematic-paths";
import { getZentrumSchematicStopMarks } from "../../lib/zentrum-schematic-stops";
import { navigateTo, routePaths } from "../../routing";
import type { ZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematicDrawing } from "./ZentrumSchematicDrawing";

/**
 * The plan width, in CSS pixels, from which every stop is named rather than only the ones a reader
 * steers by.
 *
 * Read off the plan as it was actually laid out, not off the zoom step that produced it. Zoom used
 * to decide this, which quietly made the zoom control the naming control: a wide desktop panel
 * showing the whole Zentrum legibly still withheld the names until it was pressed twice, and a
 * phone at the same step had them at a size nothing could be read at. What decides whether a name
 * beside every dot has somewhere to go is how much room the drawing got, and that is this.
 */
const ZENTRUM_NAME_EVERY_STOP_WIDTH = 1000;

/** What a mark animates with, on top of the place the schematic already gives it. */
type ZentrumVehicleMark = ZentrumSchematicVehicle &
  TrajectoryAnimationFields & { courseX: string; courseY: string };

/**
 * The plan itself: the drawing, the stops named on it, and the marks moving over it.
 *
 * Everything here is read in the canvas' own coordinates — a share of a drawing that keeps its
 * ratio — so a zoom or a resize re-resolves the very same placements and animations rather than
 * asking for new ones. The scrollport it is read in, and the width it is drawn at, are the reading
 * above it (`useZentrumPlanCanvas`); what changes with the second is only the marks.
 */
export function ZentrumSchematicCanvas({
  edges,
  linePaths,
  trackWidth,
  boardingPlacesByNodeId,
  lineIdsByNodeId,
  getSign,
  selectedLineId,
  vehicles,
  aheadEdgeIdsByTrackId,
  selectedVehicleId,
  onSelectVehicle,
  scrollRef,
  zoom,
  planWidth,
}: {
  edges: readonly ZentrumSchematicEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  /** The one width the lanes are laid out on, which is also the width they are painted at. */
  trackWidth: number;
  /** The stops the reading can name more than one place to stand at, which are marked once each. */
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  getSign: ZentrumLineSignReader;
  /** The line the plan is following, as the address names it. */
  selectedLineId?: string;
  vehicles: readonly ZentrumSchematicVehicle[];
  /**
   * The corridors the followed line's vehicles are still to run, which the plan lights ahead of
   * them; absent — and every stretch keeps its colour — while no line is being followed.
   */
  aheadEdgeIdsByTrackId?: ReadonlyMap<string, ReadonlySet<string>>;
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  planWidth: number | undefined;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const visibleNodes = ZENTRUM_SCHEMATIC_NODES.filter((node) => lineIdsByNodeId.has(node.id));
  const showsEveryName = planWidth !== undefined && planWidth >= ZENTRUM_NAME_EVERY_STOP_WIDTH;

  // Every name at once is what buries a small plan: twenty-five of them, most of them long German
  // compounds, over a drawing whose corridors are the thing to read. So a plan with no room for
  // them names what a reader steers by -- where corridors meet, and where the drawing ends -- and
  // the rest of the names arrive with the room that holds them. Following a line names its own path
  // whatever the room, because that is the moment those names are what is being asked for. Nothing
  // is lost while a name is unprinted: the dot keeps it, and reads it out.
  // A stop stands out of the naming only while exactly two corridors pass through it; counting the
  // corridors once and reading the counts is what keeps this off the per-second render.
  const junctions = useMemo(() => {
    const corridorCountByNodeId = new Map<string, number>();
    for (const { from, to } of edges) {
      for (const nodeId of [from.id, to.id]) {
        corridorCountByNodeId.set(nodeId, (corridorCountByNodeId.get(nodeId) ?? 0) + 1);
      }
    }
    return new Set(
      [...lineIdsByNodeId.keys()].filter(
        (nodeId) => (corridorCountByNodeId.get(nodeId) ?? 0) !== 2,
      ),
    );
  }, [edges, lineIdsByNodeId]);

  // The lines the drawing paints, with the geometry they are painted from. Path data is the
  // drawing's dearest reading, and none of its inputs moves with the vehicle clock, so it is kept
  // between the per-second renders that only move the marks along it.
  const drawnPaths = useMemo(
    () => getZentrumSchematicDrawnPaths(linePaths, edges, trackWidth),
    [linePaths, edges, trackWidth],
  );
  const drawnLinePaths = useMemo(
    () => drawnPaths.map((path) => ({ ...path, sign: getSign(path.lineId) })),
    [drawnPaths, getSign],
  );

  // A stop is a rule across the band rather than a dot on one lane of it, and a stop the reading
  // has named more than one place to stand at is one rule per place. Laid out from the same edges
  // and lane width the lanes were, so a mark crosses exactly what is drawn beneath it.
  const stopMarks = useMemo(
    () => getZentrumSchematicStopMarks(edges, trackWidth, boardingPlacesByNodeId),
    [edges, trackWidth, boardingPlacesByNodeId],
  );
  const stopMarkByNodeId = useMemo(
    () => new Map(stopMarks.map((mark) => [mark.nodeId, mark])),
    [stopMarks],
  );

  // Marks move on one segment-long Web Animation, the same choreography the line diagram's marks
  // keep: the placement's own trajectory sampled into keyframes, a replan correcting from the
  // paint already on the mark, a placement painted where it belongs. The corridor is the mark's
  // coordinate system, stated in container units -- the base sits at the corridor's lane start
  // and the translate carries the whole run -- so a zoom or a resize re-resolves the very same
  // animation, and only a replan asks for a new one.
  const vehicleMarks: ZentrumVehicleMark[] = vehicles.flatMap((vehicle) =>
    vehicle.trajectory
      ? [
          {
            ...vehicle,
            trajectory: vehicle.trajectory,
            key: vehicle.id,
            linkKey: `${vehicle.from.id}:${vehicle.to.id}`,
            courseX: toZentrumCanvasRun(vehicle.to.x - vehicle.from.x),
            courseY: toZentrumCanvasRun(vehicle.to.y - vehicle.from.y),
          },
        ]
      : [],
  );
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: vehicleMarks,
    // The plan is blown up and re-fitted by zoom and box alike; while the coordinates state
    // themselves in live units the marks scale with it, the paint a replan would carry does not.
    geometrySignature: String(planWidth ?? zoom),
    getTransform: (mark, progress) =>
      getZentrumVehicleTransform(mark.courseX, mark.courseY, progress),
  });

  return (
    <div className="zentrum-schematic-scroll" ref={scrollRef}>
      <div
        className="zentrum-schematic-canvas"
        ref={canvasRef}
        style={{
          aspectRatio: `${ZENTRUM_SCHEMATIC_VIEWBOX.width} / ${ZENTRUM_SCHEMATIC_VIEWBOX.height}`,
          width: planWidth === undefined ? `${zoom * 100}%` : `${planWidth}px`,
        }}
      >
        <ZentrumSchematicDrawing
          edges={edges}
          drawnLinePaths={drawnLinePaths}
          stopMarks={stopMarks}
          selectedLineId={selectedLineId}
          aheadEdgeIdsByTrackId={aheadEdgeIdsByTrackId}
          trackWidth={trackWidth}
        />

        {visibleNodes.map((node) => {
          const lineIdsAtNode = lineIdsByNodeId.get(node.id) ?? [];
          const stopMark = stopMarkByNodeId.get(node.id);
          const isMuted = selectedLineId !== undefined && !lineIdsAtNode.includes(selectedLineId);
          const isNamed =
            showsEveryName ||
            junctions.has(node.id) ||
            (selectedLineId !== undefined && lineIdsAtNode.includes(selectedLineId));
          return (
            <button
              key={node.id}
              type="button"
              className={`zentrum-schematic-stop ${node.labelSide ?? "below"}`}
              data-muted={isMuted}
              data-named={isNamed}
              style={
                {
                  left: toZentrumCanvasLeft(node.x),
                  top: toZentrumCanvasTop(node.y),
                  // The invisible button anchor occupies the enclosing circle of the stop's
                  // rules. The label then clears the whole of the mark, however far out on an
                  // arm the reading put it, rather than being spaced from the coordinate.
                  ...(stopMark && {
                    "--zentrum-stop-dot": `${(stopMark.labelRadius * 200) / ZENTRUM_SCHEMATIC_VIEWBOX.width}cqw`,
                  }),
                } as CSSProperties
              }
              onClick={() => navigateTo(routePaths.stop(node.id))}
              aria-label={`${node.label}, Linien ${lineIdsAtNode.join(", ")}. Haltestelle öffnen`}
            >
              <i aria-hidden="true" />
              <span>{node.label}</span>
            </button>
          );
        })}

        {vehicles.map((vehicle) => {
          const sign = getSign(vehicle.lineId);
          // The base sits at the corridor's start -- lane included, so the mark rides its
          // line's colour from the first frame -- and the translate carries the whole run to
          // the stop ahead. That one property is what both the static paint and the animated
          // keyframes state, so the per-second tick repositions nothing the animation runs.
          const runX = vehicle.to.x - vehicle.from.x;
          const runY = vehicle.to.y - vehicle.from.y;
          const courseX = toZentrumCanvasRun(runX);
          const courseY = toZentrumCanvasRun(runY);
          const isSelected = selectedVehicleId === vehicle.id;
          const style = {
            left: toZentrumCanvasLeft(vehicle.x - runX * vehicle.progress),
            top: toZentrumCanvasTop(vehicle.y - runY * vehicle.progress),
            transform: getZentrumVehicleTransform(courseX, courseY, vehicle.progress),
            "--zentrum-line-color": sign.color,
            "--zentrum-vehicle-ink": sign.textColor,
            "--zentrum-vehicle-angle": `${vehicle.angle}deg`,
          } as CSSProperties;
          return (
            <button
              key={vehicle.id}
              type="button"
              className="zentrum-schematic-vehicle"
              data-marker-key={vehicle.id}
              data-selected={isSelected}
              data-dimmed={
                selectedLineId !== undefined && vehicle.lineId !== selectedLineId
                  ? "true"
                  : undefined
              }
              style={style}
              title={`Linie ${vehicle.lineId} nach ${vehicle.destination}; geschätzt zwischen ${vehicle.from.label} und ${vehicle.to.label}`}
              aria-label={`Linie ${vehicle.lineId} nach ${vehicle.destination}, geschätzte Position zwischen ${vehicle.from.label} und ${vehicle.to.label}`}
              aria-expanded={isSelected}
              aria-controls={isSelected ? "zentrum-vehicle-detail" : undefined}
              onClick={() => onSelectVehicle(vehicle.id)}
            >
              <i aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
