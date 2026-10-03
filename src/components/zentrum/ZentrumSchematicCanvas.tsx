import { type CSSProperties, memo, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  useVehicleTrajectoryAnimations,
  type TrajectoryAnimationFields,
} from "../../hooks/vehicle-trajectory-animation";
import {
  getZentrumVehicleLinkKey,
  getZentrumVehicleTransform,
  toZentrumCanvasLeft,
  toZentrumCanvasRun,
  toZentrumCanvasTop,
} from "../../lib/zentrum-plan-canvas";
import type { ZentrumSchematicReading, ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import { placeZentrumSchematicLabels } from "../../lib/zentrum-schematic-labels";
import {
  ZENTRUM_SCHEMATIC_NODES,
  ZENTRUM_SCHEMATIC_VIEWBOX,
  zentrumSchematicNodeById,
} from "../../lib/zentrum-schematic-plan";
import type { ZentrumSchematicOverlay } from "../../lib/zentrum-schematic-overlays";
import type { ZentrumLineSignReader } from "./line-sign";
import {
  ZentrumSchematicDrawing,
  getZentrumLitStretchKey,
  getZentrumLitStretchOffset,
} from "./ZentrumSchematicDrawing";

/** The plan width in CSS pixels from which every stop is named (measured, not the zoom step). */
const ZENTRUM_NAME_EVERY_STOP_WIDTH = 1000;

/** How soon a stop is reached from the opened one, and the line that gets the rider there. */
export type ZentrumStopTravelTag = { minutes: number; lineId: string };

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
  schematic: ZentrumSchematicReading;
  getSign: ZentrumLineSignReader;
  /** The followed line. */
  selectedLineId?: string;
  /** The opened stop. */
  selectedStationId?: string;
  vehicles: readonly ZentrumSchematicVehicle[];
  /** What is lit over the route traces, or nothing to draw every line whole. */
  overlay?: ZentrumSchematicOverlay;
  /** The countdown on each tram the opened stop waits for; when present, other marks recede. */
  vehicleMinutesById?: ReadonlyMap<string, number>;
  /** Minutes to each stop from the opened one, printed before its name; unreached stops recede. */
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectStation: (stationId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  planWidth: number | undefined;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);

  // Bring an opened stop to the middle of a panned plan.
  useEffect(() => {
    const scroller = scrollRef.current;
    const canvas = canvasRef.current;
    const node =
      selectedStationId === undefined ? undefined : zentrumSchematicNodeById.get(selectedStationId);
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

  // The lines kept at full strength: the followed one, or those calling at the opened stop.
  const { lineIdsByNodeId } = schematic;
  const highlightedLineIds = useMemo(() => {
    if (selectedStationId !== undefined) return new Set(lineIdsByNodeId.get(selectedStationId));
    return selectedLineId === undefined ? undefined : new Set([selectedLineId]);
  }, [lineIdsByNodeId, selectedLineId, selectedStationId]);

  const drawnLinePaths = useMemo(
    () => schematic.drawnPaths.map((path) => ({ ...path, sign: getSign(path.lineId) })),
    [schematic.drawnPaths, getSign],
  );

  // One Web Animation per link, in container units, so zoom and resize keep it; a changed layout or
  // fit restarts them.
  const geometrySignature = `${planWidth ?? zoom}|${schematic.layoutKey}`;
  const vehicleMarks: ZentrumVehicleMark[] = vehicles.map((vehicle) => ({
    ...vehicle,
    key: getMarkerKey(vehicle),
    linkKey: getLinkKey(vehicle),
  }));
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: vehicleMarks,
    geometrySignature,
    getTransform: (mark, progress) => getZentrumVehicleTransform(mark.path, progress),
    getBoundaryProgresses: getBendProgresses,
  });
  // A lit stretch uses its mark's keyframes, so the colour ends at the mark.
  const stretchMarks: ZentrumLitStretchMark[] = (overlay?.stretches ?? []).map(
    ({ vehicle, end }) => ({
      ...vehicle,
      end,
      key: getZentrumLitStretchKey(getMarkerKey(vehicle)),
      linkKey: `${getLinkKey(vehicle)}:${end}`,
    }),
  );
  useVehicleTrajectoryAnimations({
    container: canvasRef,
    marks: stretchMarks,
    geometrySignature,
    property: "strokeDashoffset",
    getTransform: (mark, progress) => getZentrumLitStretchOffset(progress, mark.end),
    getBoundaryProgresses: getBendProgresses,
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
          stopMarks={schematic.stopMarks}
          highlightedLineIds={highlightedLineIds}
          selectedStopId={selectedStationId}
          overlay={overlay}
          trackWidth={schematic.trackWidth}
        />

        <ZentrumSchematicStops
          schematic={schematic}
          highlightedLineIds={highlightedLineIds}
          selectedLineId={selectedLineId}
          selectedStationId={selectedStationId}
          stopMinutesByNodeId={stopMinutesByNodeId}
          planWidth={planWidth}
          onSelectStation={onSelectStation}
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
              isDimmed={
                (vehicleMinutesById !== undefined && minutes === undefined) ||
                (highlightedLineIds !== undefined && !highlightedLineIds.has(vehicle.lineId))
              }
              onSelect={onSelectVehicle}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Where a vehicle is, in words, for the mark's label. */
const describeVehiclePlace = ({ phase, from, to }: ZentrumSchematicVehicle): string => {
  if (phase === "beforeStart") return `steht an ${from.label} vor Abfahrt`;
  if (phase === "afterEnd") return `steht an ${to.label} (Fahrt endet hier)`;
  if (from.id === to.id) return `hält an ${from.label}`;
  return `geschätzt zwischen ${from.label} und ${to.label}`;
};

/** One tram on the plan, with the countdown the opened stop reads for it. */
function ZentrumSchematicVehicleMark({
  vehicle,
  getSign,
  minutes,
  isSelected,
  isDimmed,
  onSelect,
}: {
  vehicle: ZentrumSchematicVehicle;
  getSign: ZentrumLineSignReader;
  /** Minutes until it leaves the opened stop, if the stop waits for it. */
  minutes?: number;
  isSelected: boolean;
  isDimmed: boolean;
  onSelect: (vehicleId: string) => void;
}) {
  const sign = getSign(vehicle.lineId);
  const countdown = minutes === undefined ? undefined : minutes <= 0 ? "jetzt" : `${minutes} min`;
  const place = describeVehiclePlace(vehicle);
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
      data-dimmed={isDimmed ? "true" : undefined}
      style={style}
      title={`Linie ${vehicle.lineId} nach ${vehicle.destination}; ${place}`}
      aria-label={`Linie ${vehicle.lineId} nach ${vehicle.destination}, ${place}${countdown ? `, fährt an der Haltestelle ${countdown === "jetzt" ? "jetzt" : `in ${countdown}`}` : ""}`}
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
  schematic,
  highlightedLineIds,
  selectedLineId,
  selectedStationId,
  stopMinutesByNodeId,
  planWidth,
  onSelectStation,
}: {
  schematic: ZentrumSchematicReading;
  highlightedLineIds?: ReadonlySet<string>;
  selectedLineId?: string;
  selectedStationId?: string;
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
  planWidth: number | undefined;
  onSelectStation: (stationId: string) => void;
}) {
  const { edges, lineIdsByNodeId, stopMarks, trackWidth } = schematic;
  // Here, not with the drawing: a printed travel time makes every name taller.
  const hasTimes = stopMinutesByNodeId !== undefined;
  const labelsByNodeId = useMemo(
    () => placeZentrumSchematicLabels(edges, stopMarks, trackWidth, planWidth, hasTimes),
    [edges, stopMarks, trackWidth, planWidth, hasTimes],
  );
  const junctions = useMemo(() => getJunctionIds(schematic), [schematic]);
  const visibleNodes = useMemo(
    () => ZENTRUM_SCHEMATIC_NODES.filter((node) => lineIdsByNodeId.has(node.id)),
    [lineIdsByNodeId],
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
        const isSelected = selectedStationId === node.id;
        const label = labelsByNodeId.get(node.id);
        const travel = stopMinutesByNodeId?.get(node.id);
        const minutes = travel?.minutes;
        const isMuted = stopMinutesByNodeId
          ? minutes === undefined && !isSelected
          : highlightedLineIds !== undefined && !isHighlighted;
        // Only a followed line names its stops. A name the placer could not fit shows on hover.
        const isNamed =
          isSelected ||
          (label?.fits !== false &&
            (showsEveryName ||
              junctions.has(node.id) ||
              (selectedLineId !== undefined && isHighlighted)));
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
            /* A reached stop shows its minutes even where its name is held back, unless it found
               no room. */
            data-named={
              isNamed ? "true" : minutes !== undefined && label?.fits !== false ? "time" : "false"
            }
            data-selected={isSelected}
            style={
              {
                left: toZentrumCanvasLeft(centre.x),
                top: toZentrumCanvasTop(centre.y),
                "--zentrum-label-x": toZentrumCanvasRun((label?.anchor.x ?? centre.x) - centre.x),
                "--zentrum-label-y": toZentrumCanvasRun((label?.anchor.y ?? centre.y) - centre.y),
              } as CSSProperties
            }
            onClick={() => onSelectStation(node.id)}
            aria-pressed={isSelected}
            aria-label={`${node.label}, Linien ${lineIdsAtNode.join(", ")}${travel ? `, mit Linie ${travel.lineId} in ${travel.minutes} Minuten erreichbar` : ""}. ${isSelected ? "Haltestelle schließen" : "Abfahrten und Fahrzeiten ab hier"}`}
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
