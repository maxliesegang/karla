import { type CSSProperties, memo, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  useVehicleTrajectoryAnimations,
  type TrajectoryAnimationFields,
} from "../../hooks/vehicle-trajectory-animation";
import {
  getZentrumRevealScroll,
  getZentrumVehicleLinkKey,
  getZentrumVehicleTransform,
  toZentrumCanvasLeft,
  toZentrumCanvasRun,
  toZentrumCanvasTop,
} from "../../lib/zentrum-plan-canvas";
import type { ZentrumSchematicReading, ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import {
  type ZentrumSchematicLabel,
  placeZentrumSchematicLabels,
  type ZentrumNameTime,
} from "../../lib/zentrum-schematic-labels";
import {
  getZentrumSchematicStopId,
  getZentrumSchematicLineIdsByStopId,
  ZENTRUM_SCHEMATIC_VIEWBOX,
  zentrumSchematicNodeById,
} from "../../lib/zentrum-schematic-plan";
import type { ZentrumPlanOptions } from "../../lib/zentrum-plan-options";
import type { ZentrumSchematicOverlay } from "../../lib/zentrum-schematic-overlays";
import type { ZentrumStopTravelTag } from "../../lib/zentrum-stop-view";
import type { ZentrumLineSignReader } from "./line-sign";
import { getZentrumVehiclePlaceLabel } from "../../lib/zentrum-presentation";
import {
  ZentrumSchematicDrawing,
  getZentrumLitStretchKey,
  getZentrumLitStretchOffset,
} from "./ZentrumSchematicDrawing";

/** The plan width in CSS pixels from which every stop is named (measured, not the zoom step). */
const ZENTRUM_NAME_EVERY_STOP_WIDTH = 1000;

/** A mark with what its animation needs. */
type ZentrumVehicleMark = ZentrumSchematicVehicle & TrajectoryAnimationFields;

/** A lit stretch animates on its mark's trajectory, as a share of the stretch. */
type ZentrumLitStretchMark = ZentrumVehicleMark & { end: number };

const getMarkerKey = (vehicle: ZentrumSchematicVehicle): string => vehicle.markerKey ?? vehicle.id;

const getLinkKey = (vehicle: ZentrumSchematicVehicle): string =>
  getZentrumVehicleLinkKey(vehicle.from.id, vehicle.to.id, vehicle.path);

/** Keyframes at the path's points, so the mark turns the bend the stroke draws. */
const getBendProgresses = (mark: ZentrumVehicleMark): readonly number[] =>
  mark.path.steps.slice(1, -1);

/**
 * The plan: drawing, stops and moving marks, in proportional coordinates so zoom and resize
 * re-resolve.
 */
export function ZentrumSchematicCanvas({
  schematic,
  getSign,
  selectedLineId,
  selectedStopId,
  vehicles,
  overlay,
  unlitLineStyle,
  vehicleMinutesById,
  departedVehicleIds,
  stopMinutesByNodeId,
  selectedVehicleId,
  onSelectVehicle,
  onSelectStop,
  onSelectLine,
  onHoverLines,
  scrollRef,
  zoom,
  planWidth,
}: {
  schematic: ZentrumSchematicReading;
  getSign: ZentrumLineSignReader;
  /** The followed line. */
  selectedLineId?: string;
  /** The opened stop. */
  selectedStopId?: string;
  vehicles: readonly ZentrumSchematicVehicle[];
  /** What is lit over the route traces, or nothing to draw every line whole. */
  overlay?: ZentrumSchematicOverlay;
  /** How lines calling at the opened stop are drawn where the overlay does not light them. */
  unlitLineStyle?: ZentrumPlanOptions["unlitLineStyle"];
  /** The countdown on each tram the opened stop waits for; when present, other marks recede. */
  vehicleMinutesById?: ReadonlyMap<string, number>;
  /** Trams that have left the opened stop; on its lines they recede only partly. */
  departedVehicleIds?: ReadonlySet<string>;
  /** Minutes to each stop from the opened one, printed before its name; unreached stops recede. */
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectStop: (stationId: string) => void;
  onSelectLine: (lineId: string | undefined) => void;
  onHoverLines: (lineIds: readonly string[]) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  planWidth: number | undefined;
}) {
  const { edges, stopMarks, trackWidth } = schematic;
  // Here, not with the drawing: a printed travel time makes every name taller.
  const hasTimes: ZentrumNameTime =
    stopMinutesByNodeId === undefined
      ? false
      : [...stopMinutesByNodeId.values()].some((tag) => tag.waitMinutes !== undefined)
        ? "with-wait"
        : true;
  const labelsByNodeId = useMemo(
    () =>
      placeZentrumSchematicLabels(
        edges,
        stopMarks,
        trackWidth,
        planWidth,
        hasTimes,
        stopMinutesByNodeId ? new Set(stopMinutesByNodeId.keys()) : undefined,
        selectedStopId,
      ),
    [edges, stopMarks, trackWidth, planWidth, hasTimes, stopMinutesByNodeId, selectedStopId],
  );
  const canvasRef = useRef<HTMLDivElement>(null);

  // Bring an opened stop into view, moving the plan no further than that.
  useEffect(() => {
    const scroller = scrollRef.current;
    const canvas = canvasRef.current;
    const node =
      selectedStopId === undefined ? undefined : zentrumSchematicNodeById.get(selectedStopId);
    if (!scroller || !canvas || !node) return;
    const x =
      canvas.offsetLeft +
      ((node.x - ZENTRUM_SCHEMATIC_VIEWBOX.x) / ZENTRUM_SCHEMATIC_VIEWBOX.width) *
        canvas.offsetWidth;
    const y =
      canvas.offsetTop +
      ((node.y - ZENTRUM_SCHEMATIC_VIEWBOX.y) / ZENTRUM_SCHEMATIC_VIEWBOX.height) *
        canvas.offsetHeight;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      left: getZentrumRevealScroll(scroller.scrollLeft, x, scroller.clientWidth),
      top: getZentrumRevealScroll(scroller.scrollTop, y, scroller.clientHeight),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [selectedStopId, scrollRef, planWidth]);

  // The lines kept at full strength: the followed one, or those calling at the opened stop.
  const { lineIdsByNodeId } = schematic;
  const highlightedLineIds = useMemo(() => {
    if (selectedStopId !== undefined)
      return new Set(getZentrumSchematicLineIdsByStopId(lineIdsByNodeId).get(selectedStopId));
    return selectedLineId === undefined ? undefined : new Set([selectedLineId]);
  }, [lineIdsByNodeId, selectedLineId, selectedStopId]);

  const drawnLinePaths = useMemo(
    () => schematic.drawnPaths.map((path) => ({ ...path, sign: getSign(path.lineId) })),
    [schematic.drawnPaths, getSign],
  );

  // Path keys carry lane geometry; only a resize invalidates every mark's painted coordinates.
  const geometrySignature = `${planWidth ?? zoom}`;
  const vehicleMarks: ZentrumVehicleMark[] = vehicles.map((vehicle) => ({
    ...vehicle,
    key: getMarkerKey(vehicle),
    linkKey: getLinkKey(vehicle),
  }));
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: vehicleMarks,
    geometrySignature,
    getValue: (mark, progress) => getZentrumVehicleTransform(mark.path, progress),
    getBoundaryProgresses: getBendProgresses,
  });
  // A lit stretch uses its mark's keyframes, so the colour ends at the mark.
  const foregroundPaths = schematic.drawnPaths.filter((path) => path.foregroundRegions.length > 0);
  const stretchMarks: ZentrumLitStretchMark[] = (overlay?.stretches ?? []).flatMap(
    ({ vehicle, end }) => {
      const foregroundPathIds =
        highlightedLineIds === undefined || highlightedLineIds.has(vehicle.lineId)
          ? foregroundPaths
              .filter(
                (path) =>
                  path.lineIds.includes(vehicle.lineId) &&
                  path.segments.some((segment) =>
                    vehicle.path.corridorRanges.some(
                      (range) => range.corridorId === segment.corridorId,
                    ),
                  ),
              )
              .map((path) => path.id)
          : [];
      return [undefined, ...foregroundPathIds].map((foregroundPathId) => ({
        ...vehicle,
        end,
        key: getZentrumLitStretchKey(getMarkerKey(vehicle), foregroundPathId),
        linkKey: `${getLinkKey(vehicle)}:${end}`,
      }));
    },
  );
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: stretchMarks,
    geometrySignature,
    property: "strokeDashoffset",
    getValue: (mark, progress) => getZentrumLitStretchOffset(progress, mark.end),
    getBoundaryProgresses: getBendProgresses,
  });

  return (
    <div className="zentrum-schematic-scroll" ref={scrollRef}>
      <div
        className="zentrum-schematic-canvas"
        ref={canvasRef}
        style={
          {
            aspectRatio: `${ZENTRUM_SCHEMATIC_VIEWBOX.width} / ${ZENTRUM_SCHEMATIC_VIEWBOX.height}`,
            width: planWidth === undefined ? `${zoom * 100}%` : `${planWidth}px`,
            "--zentrum-vehicle-size": toZentrumCanvasRun(trackWidth * 2.5),
          } as CSSProperties
        }
      >
        <ZentrumSchematicDrawing
          drawnLinePaths={drawnLinePaths}
          stopMarks={stopMarks}
          highlightedLineIds={highlightedLineIds}
          selectedStopId={selectedStopId}
          overlay={overlay}
          unlitLineStyle={unlitLineStyle}
          trackWidth={schematic.trackWidth}
          selectedLineId={selectedLineId}
          onSelectLine={onSelectLine}
          onHoverLines={onHoverLines}
        />

        <ZentrumSchematicStops
          labelsByNodeId={labelsByNodeId}
          schematic={schematic}
          highlightedLineIds={highlightedLineIds}
          selectedLineId={selectedLineId}
          selectedStopId={selectedStopId}
          stopMinutesByNodeId={stopMinutesByNodeId}
          planWidth={planWidth}
          onSelectStop={onSelectStop}
        />

        {vehicles.map((vehicle) => {
          const minutes = vehicleMinutesById?.get(vehicle.id);
          return (
            <ZentrumSchematicVehicleMark
              key={getMarkerKey(vehicle)}
              vehicle={vehicle}
              getSign={getSign}
              minutes={minutes}
              isSelected={selectedVehicleId === vehicle.id}
              dimming={getVehicleDimming(
                vehicle,
                minutes,
                vehicleMinutesById,
                highlightedLineIds,
                departedVehicleIds,
              )}
              onSelect={onSelectVehicle}
            />
          );
        })}
      </div>
    </div>
  );
}

type ZentrumVehicleDimming = "dimmed" | "departed" | undefined;

/** Off-reading lines dim fully; their own trams that have left the opened stop only recede. */
const getVehicleDimming = (
  vehicle: ZentrumSchematicVehicle,
  minutes: number | undefined,
  vehicleMinutesById: ReadonlyMap<string, number> | undefined,
  highlightedLineIds: ReadonlySet<string> | undefined,
  departedVehicleIds: ReadonlySet<string> | undefined,
): ZentrumVehicleDimming => {
  if (highlightedLineIds !== undefined && !highlightedLineIds.has(vehicle.lineId)) return "dimmed";
  if (departedVehicleIds?.has(vehicle.id)) return "departed";
  return vehicleMinutesById !== undefined && minutes === undefined ? "dimmed" : undefined;
};

/** One tram on the plan, with the countdown the opened stop reads for it. */
function ZentrumSchematicVehicleMark({
  vehicle,
  getSign,
  minutes,
  isSelected,
  dimming,
  onSelect,
}: {
  vehicle: ZentrumSchematicVehicle;
  getSign: ZentrumLineSignReader;
  /** Minutes until it leaves the opened stop, if the stop waits for it. */
  minutes?: number;
  isSelected: boolean;
  dimming: ZentrumVehicleDimming;
  onSelect: (vehicleId: string) => void;
}) {
  const sign = getSign(vehicle.lineId);
  const countdown = minutes === undefined ? undefined : minutes <= 0 ? "jetzt" : `${minutes} min`;
  const place = getZentrumVehiclePlaceLabel(vehicle);
  // One transform in container units for paint and keyframes, so handovers are seamless.
  const style = {
    transform: getZentrumVehicleTransform(vehicle.path, vehicle.progress),
    "--zentrum-line-color": sign.color,
    "--zentrum-vehicle-ink": sign.textColor,
    "--zentrum-vehicle-angle": `${vehicle.angle}deg`,
  } as CSSProperties;
  return (
    <button
      type="button"
      className="zentrum-schematic-vehicle"
      data-marker-key={getMarkerKey(vehicle)}
      data-selected={isSelected}
      data-dimmed={dimming === "dimmed" ? "true" : undefined}
      data-departed={dimming === "departed" ? "true" : undefined}
      style={style}
      title={`Linie ${vehicle.lineId} nach ${vehicle.destination}; ${place}; Position geschätzt`}
      aria-label={`Linie ${vehicle.lineId} nach ${vehicle.destination}, ${place}, Position geschätzt${countdown ? `, fährt an der Haltestelle ${countdown === "jetzt" ? "jetzt" : `in ${countdown}`}` : ""}`}
      aria-expanded={isSelected}
      aria-controls={isSelected ? "zentrum-vehicle-detail" : undefined}
      onClick={() => onSelect(vehicle.id)}
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
}

/** Stops where corridors meet or end: always named. */
const getJunctionIds = ({ edges, lineIdsByNodeId }: ZentrumSchematicReading): Set<string> => {
  const corridorCountByNodeId = new Map<string, number>();
  for (const { from, to } of edges) {
    for (const nodeId of [from.id, to.id]) {
      corridorCountByNodeId.set(nodeId, (corridorCountByNodeId.get(nodeId) ?? 0) + 1);
    }
  }
  return new Set(
    [...lineIdsByNodeId.keys()].filter((nodeId) => (corridorCountByNodeId.get(nodeId) ?? 0) !== 2),
  );
};

/** The stop buttons, apart from the marks so they do not re-render every second. */
const ZentrumSchematicStops = memo(function ZentrumSchematicStops({
  labelsByNodeId,
  schematic,
  highlightedLineIds,
  selectedLineId,
  selectedStopId,
  stopMinutesByNodeId,
  planWidth,
  onSelectStop,
}: {
  labelsByNodeId: ReadonlyMap<string, ZentrumSchematicLabel>;
  schematic: ZentrumSchematicReading;
  highlightedLineIds?: ReadonlySet<string>;
  selectedLineId?: string;
  selectedStopId?: string;
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
  planWidth: number | undefined;
  onSelectStop: (stationId: string) => void;
}) {
  const { lineIdsByNodeId, stopMarks } = schematic;
  const junctions = useMemo(() => getJunctionIds(schematic), [schematic]);
  const visibleNodes = useMemo(
    () => [...schematic.nodesById.values()].filter((node) => lineIdsByNodeId.has(node.id)),
    [lineIdsByNodeId, schematic.nodesById],
  );
  const stopMarkByNodeId = useMemo(
    () => new Map(stopMarks.map((mark) => [mark.nodeId, mark])),
    [stopMarks],
  );
  const showsEveryName = planWidth !== undefined && planWidth >= ZENTRUM_NAME_EVERY_STOP_WIDTH;
  return (
    <>
      {visibleNodes.map((node) => {
        const lineIdsAtNode = lineIdsByNodeId.get(node.id) ?? [];
        const stopMark = stopMarkByNodeId.get(node.id);
        const isHighlighted = highlightedLineIds
          ? lineIdsAtNode.some((lineId) => highlightedLineIds.has(lineId))
          : false;
        const isSelected = selectedStopId === getZentrumSchematicStopId(node.id);
        const label = labelsByNodeId.get(node.id);
        const travel = stopMinutesByNodeId?.get(node.id);
        const minutes = travel?.minutes;
        const isMuted = stopMinutesByNodeId
          ? minutes === undefined && !isSelected
          : highlightedLineIds !== undefined && !isHighlighted;
        // Reached stops are named; crowded names remain available on hover and focus.
        const isNamed =
          !node.stopId &&
          (isSelected ||
            (label?.fits !== false &&
              (showsEveryName ||
                travel !== undefined ||
                junctions.has(node.id) ||
                (selectedLineId !== undefined && isHighlighted))));
        // The button is the capsule; the name hangs where the placer set it.
        const centre = stopMark
          ? {
              x: (stopMark.main.from.x + stopMark.main.to.x) / 2,
              y: (stopMark.main.from.y + stopMark.main.to.y) / 2,
            }
          : node;
        return (
          <button
            key={node.id}
            type="button"
            className="zentrum-schematic-stop"
            data-side={label?.side ?? node.labelSide ?? "below"}
            data-muted={isMuted}
            data-named={isNamed}
            data-selected={isSelected}
            style={
              {
                left: toZentrumCanvasLeft(centre.x),
                top: toZentrumCanvasTop(centre.y),
                "--zentrum-label-x": toZentrumCanvasRun((label?.anchor.x ?? centre.x) - centre.x),
                "--zentrum-label-y": toZentrumCanvasRun((label?.anchor.y ?? centre.y) - centre.y),
              } as CSSProperties
            }
            onClick={() => onSelectStop(getZentrumSchematicStopId(node.id))}
            aria-pressed={isSelected}
            aria-label={`${node.label}, Linien ${lineIdsAtNode.join(", ")}${travel ? `, mit Linie ${travel.lineId} ${travel.measure === "arrival" ? `in ${travel.minutes} Minuten erreichbar` : `${travel.minutes} Minuten Fahrt`}${travel.waitMinutes === undefined ? "" : `, ab in ${travel.waitMinutes} Minuten`}, ${travel.sourceLabel}` : ""}. ${isSelected ? "Haltestelle schließen" : "Ziele und Abfahrten ab hier"}`}
          >
            <i aria-hidden="true" />
            <span>
              {/* Minutes before the name, as a timetable prints them. */}
              {travel && (
                <b className="zentrum-schematic-stop-time" aria-hidden="true">
                  {/* "S1 8 min": the time is that line's. */}
                  <em>{travel.lineId}</em>
                  {travel.minutes}
                  <small>min</small>
                  {travel.waitMinutes !== undefined && (
                    <small className="zentrum-schematic-stop-wait">
                      · {travel.waitMinutes <= 0 ? "jetzt" : `in ${travel.waitMinutes}`}
                    </small>
                  )}
                </b>
              )}
              <em className="zentrum-schematic-stop-name">{node.label}</em>
            </span>
          </button>
        );
      })}
    </>
  );
});
