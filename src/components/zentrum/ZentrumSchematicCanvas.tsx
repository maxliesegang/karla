import { type CSSProperties, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  useVehicleTrajectoryAnimations,
  type TrajectoryAnimationFields,
} from "../../hooks/vehicle-trajectory-animation";
import {
  getZentrumLabelSide,
  getZentrumVehicleLinkKey,
  getZentrumVehicleTransform,
  toZentrumCanvasLeft,
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
import {
  getZentrumSchematicDrawnPaths,
  getZentrumSchematicLinePathSegments,
} from "../../lib/zentrum-schematic-paths";
import type { ZentrumSchematicOverlay } from "../../lib/zentrum-schematic-overlays";
import { getZentrumSchematicStopMarks } from "../../lib/zentrum-schematic-stops";
import type { ZentrumLineSignReader } from "./line-sign";
import {
  ZentrumSchematicDrawing,
  getZentrumLitStretchKey,
  getZentrumLitStretchOffset,
} from "./ZentrumSchematicDrawing";

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

/** How soon a stop is reached from the opened one, and the line that gets the rider there. */
export type ZentrumStopTravelTag = { minutes: number; lineId: string };

/** What a mark animates with, on top of the place the schematic already gives it. */
type ZentrumVehicleMark = ZentrumSchematicVehicle & TrajectoryAnimationFields;

/** A lit stretch animates on its mark's own trajectory, read as a share of the stretch. */
type ZentrumLitStretchMark = ZentrumVehicleMark & { end: number };

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
  selectedStationId,
  vehicles,
  overlay,
  vehicleMinutesById,
  stopMinutesByNodeId,
  selectedVehicleId,
  onSelectVehicle,
  onSelectStation,
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
  /** The stop a rider has opened, which the plan is read from. */
  selectedStationId?: string;
  vehicles: readonly ZentrumSchematicVehicle[];
  /** What is lit over the route traces, or nothing to draw every line whole. */
  overlay?: ZentrumSchematicOverlay;
  /**
   * The countdown each tram the opened stop is waiting for carries on its mark. Present, it recedes
   * every other mark, because the reading is about these.
   */
  vehicleMinutesById?: ReadonlyMap<string, number>;
  /**
   * The minutes each stop is reached in from the opened one, printed before its name the way a
   * timetable prints its travel times, behind the sign of the line that gets the rider there. Present, it recedes every stop it does not reach.
   */
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectStation: (stationId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  planWidth: number | undefined;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);

  // A stop opened where the plan is panned -- a phone held upright shows a third of it -- is brought
  // to the middle of the view, so the reading it lights starts in front of the reader.
  useEffect(() => {
    const scroller = scrollRef.current;
    const canvas = canvasRef.current;
    const node = ZENTRUM_SCHEMATIC_NODES.find(({ id }) => id === selectedStationId);
    if (!scroller || !canvas || !node) return;
    const x =
      ((node.x - ZENTRUM_SCHEMATIC_VIEWBOX.x) / ZENTRUM_SCHEMATIC_VIEWBOX.width) *
      canvas.offsetWidth;
    const y =
      ((node.y - ZENTRUM_SCHEMATIC_VIEWBOX.y) / ZENTRUM_SCHEMATIC_VIEWBOX.height) *
      canvas.offsetHeight;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      left: canvas.offsetLeft + x - scroller.clientWidth / 2,
      top: canvas.offsetTop + y - scroller.clientHeight / 2,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [selectedStationId, scrollRef]);
  const visibleNodes = ZENTRUM_SCHEMATIC_NODES.filter((node) => lineIdsByNodeId.has(node.id));
  const showsEveryName = planWidth !== undefined && planWidth >= ZENTRUM_NAME_EVERY_STOP_WIDTH;
  // The lines kept at full strength: the one followed, or every line calling at the opened stop --
  // the rest recede, traces and trams alike, because the reading is about what leaves from here.
  // Only a followed line names its stops: an opened stop's lines run through most of the plan, and
  // naming everything they call at would bury a small plan again.
  const highlightedLineIds = useMemo(() => {
    if (selectedStationId !== undefined) return new Set(lineIdsByNodeId.get(selectedStationId));
    return selectedLineId === undefined ? undefined : new Set([selectedLineId]);
  }, [lineIdsByNodeId, selectedLineId, selectedStationId]);

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
    () =>
      drawnPaths.map((path) => ({
        ...path,
        sign: getSign(path.lineId),
        segments: getZentrumSchematicLinePathSegments(path, edges, trackWidth),
      })),
    [drawnPaths, getSign, edges, trackWidth],
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
  // paint already on the mark, a placement painted where it belongs. The canvas is the mark's
  // coordinate system, stated in container units -- the base sits at its origin and the translate
  // carries it along the vehicle path's points -- so a zoom or a resize
  // re-resolves the very same animation, and only a replan asks for a new one.
  const vehicleMarks: ZentrumVehicleMark[] = vehicles.map((vehicle) => ({
    ...vehicle,
    key: vehicle.markerKey ?? vehicle.id,
    linkKey: getZentrumVehicleLinkKey(vehicle.from.id, vehicle.to.id, vehicle.path),
  }));
  // The plan is blown up and re-fitted by zoom and box alike; while the coordinates state
  // themselves in live units the marks scale with it, the paint a replan would carry does not.
  const geometrySignature = [
    planWidth ?? zoom,
    trackWidth,
    ...edges.map(
      ({ id, trackBandOffset, trackLineIds }) =>
        `${id}:${trackBandOffset}:${trackLineIds.join(",")}`,
    ),
    ...drawnLinePaths.map(({ id, data }) => `${id}:${data}`),
  ].join("|");
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: vehicleMarks,
    geometrySignature,
    getTransform: (mark, progress) => getZentrumVehicleTransform(mark.path, progress),
    // The vehicle path's own points are where its drawn lane bends; a mark crossing each on its own clock
    // turns the corner the stroke turns, instead of interpolating straight across it.
    getBoundaryProgresses: (mark) => mark.path.steps.slice(1, -1),
  });
  // A stretch lit from a mark goes out behind it on the mark's own keyframes, so the colour ends
  // exactly where the mark stands rather than catching up with it once a second.
  const stretchMarks: ZentrumLitStretchMark[] = (overlay?.stretches ?? []).map(
    ({ vehicle, end }) => ({
      ...vehicle,
      end,
      key: getZentrumLitStretchKey(vehicle.markerKey ?? vehicle.id),
      linkKey: `${getZentrumVehicleLinkKey(vehicle.from.id, vehicle.to.id, vehicle.path)}:${end}`,
    }),
  );
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: stretchMarks,
    geometrySignature,
    property: "strokeDashoffset",
    getTransform: (mark, progress) => getZentrumLitStretchOffset(progress, mark.end),
    getBoundaryProgresses: (mark) => mark.path.steps.slice(1, -1),
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
          drawnLinePaths={drawnLinePaths}
          stopMarks={stopMarks}
          highlightedLineIds={highlightedLineIds}
          selectedStopId={selectedStationId}
          overlay={overlay}
          trackWidth={trackWidth}
        />

        {visibleNodes.map((node) => {
          const lineIdsAtNode = lineIdsByNodeId.get(node.id) ?? [];
          const stopMark = stopMarkByNodeId.get(node.id);
          const isHighlighted = highlightedLineIds
            ? lineIdsAtNode.some((lineId) => highlightedLineIds.has(lineId))
            : false;
          const isSelected = selectedStationId === node.id;
          const labelSide = getZentrumLabelSide(node, planWidth, stopMark?.labelClearance);
          const travel = stopMinutesByNodeId?.get(node.id);
          const minutes = travel?.minutes;
          const isMuted = stopMinutesByNodeId
            ? minutes === undefined && !isSelected
            : highlightedLineIds !== undefined && !isHighlighted;
          const isNamed =
            showsEveryName ||
            junctions.has(node.id) ||
            (selectedLineId !== undefined && isHighlighted) ||
            isSelected;
          return (
            <button
              key={node.id}
              type="button"
              className={`zentrum-schematic-stop ${labelSide}`}
              data-muted={isMuted}
              /* A stop reached from the opened one keeps its minutes whatever the room: the name
                 arrives with the room, as every other name does, and the list beside the plan names
                 them all. */
              data-named={isNamed ? "true" : minutes !== undefined ? "time" : "false"}
              data-selected={isSelected}
              style={
                {
                  left: toZentrumCanvasLeft(node.x),
                  top: toZentrumCanvasTop(node.y),
                  // The invisible button anchor is as tall or as wide as the station reaches on
                  // the side the name stands, so the name clears exactly what is drawn between it
                  // and the coordinate -- the rules of the mark, and the band running through --
                  // and stands no further off than that.
                  ...(stopMark && {
                    "--zentrum-stop-dot": `${(stopMark.labelClearance[labelSide] * 200) / ZENTRUM_SCHEMATIC_VIEWBOX.width}cqw`,
                  }),
                } as CSSProperties
              }
              onClick={() => onSelectStation(node.id)}
              aria-pressed={isSelected}
              aria-label={`${node.label}, Linien ${lineIdsAtNode.join(", ")}${travel ? `, mit Linie ${travel.lineId} in ${travel.minutes} Minuten erreichbar` : ""}. ${isSelected ? "Haltestelle schließen" : "Abfahrten und Fahrzeiten ab hier"}`}
            >
              <i aria-hidden="true" />
              <span>
                {/* The travel time heads the name, as a timetable heads its stops with minutes:
                    one place whichever side the name is set on, and no wider than the name. */}
                {travel && (
                  <b className="zentrum-schematic-stop-time" aria-hidden="true">
                    {/* The line rides in front of the minutes, so the time reads as that
                        tram's: "S1 8 min". */}
                    <em>{travel.lineId}</em>
                    {travel.minutes}
                    <small>min</small>
                  </b>
                )}
                <em className="zentrum-schematic-stop-name">{node.label}</em>
              </span>
            </button>
          );
        })}

        {vehicles.map((vehicle) => {
          const sign = getSign(vehicle.lineId);
          // The mark carries its whole position in transform in container units, anchored at
          // top-left of the canvas. That one property is what both the static paint and the
          // animated keyframes state, so link handovers and replans share the coordinate system
          // and transition seamlessly.
          const markerKey = vehicle.markerKey ?? vehicle.id;
          const isSelected = selectedVehicleId === vehicle.id;
          const minutes = vehicleMinutesById?.get(vehicle.id);
          const countdown =
            minutes === undefined ? undefined : minutes <= 0 ? "jetzt" : `${minutes} min`;
          const isHolding = vehicle.from.id === vehicle.to.id;
          const place =
            vehicle.phase === "beforeStart"
              ? `steht an ${vehicle.from.label} vor Abfahrt`
              : vehicle.phase === "afterEnd"
                ? `steht an ${vehicle.to.label} (Fahrt endet hier)`
                : isHolding
                  ? `hält an ${vehicle.from.label}`
                  : `geschätzt zwischen ${vehicle.from.label} und ${vehicle.to.label}`;
          const style = {
            transform: getZentrumVehicleTransform(vehicle.path, vehicle.progress),
            "--zentrum-line-color": sign.color,
            "--zentrum-vehicle-ink": sign.textColor,
            "--zentrum-vehicle-angle": `${vehicle.angle}deg`,
          } as CSSProperties;
          return (
            <button
              key={markerKey}
              type="button"
              className="zentrum-schematic-vehicle"
              data-marker-key={markerKey}
              data-selected={isSelected}
              data-dimmed={
                (vehicleMinutesById !== undefined && minutes === undefined) ||
                (highlightedLineIds !== undefined && !highlightedLineIds.has(vehicle.lineId))
                  ? "true"
                  : undefined
              }
              style={style}
              title={`Linie ${vehicle.lineId} nach ${vehicle.destination}; ${place}`}
              aria-label={`Linie ${vehicle.lineId} nach ${vehicle.destination}, ${place}${countdown ? `, fährt an der Haltestelle ${countdown === "jetzt" ? "jetzt" : `in ${countdown}`}` : ""}`}
              aria-expanded={isSelected}
              aria-controls={isSelected ? "zentrum-vehicle-detail" : undefined}
              onClick={() => onSelectVehicle(vehicle.id)}
            >
              <i aria-hidden="true" />
              {/* The sign the line diagram hangs on its vehicles, with the wait in it. */}
              {countdown && (
                <b className="zentrum-schematic-vehicle-tag" aria-hidden="true">
                  {vehicle.lineId} · {countdown}
                </b>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
