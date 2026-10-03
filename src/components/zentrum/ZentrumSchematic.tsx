import { useCallback, useEffect, useMemo, useState } from "react";
import type { Departure, DepartureBoard } from "../../data/transit-types";
import { useZentrumPlanCanvas } from "../../hooks/zentrum-plan-canvas";
import { createRunMotions } from "../../lib/vehicle-positioning";
import {
  type ZentrumSchematicLayout,
  type ZentrumSchematicVehicle,
  createZentrumSchematicDrawer,
  getZentrumSchematicVehicles,
} from "../../lib/zentrum-schematic";
import {
  type ZentrumSchematicOverlay,
  type ZentrumStopBoardRow,
  getMinutesUntilArrival,
  getZentrumProgressOverlay,
  getZentrumStopBoard,
  getZentrumTravelTimes,
} from "../../lib/zentrum-schematic-overlays";
import {
  type ZentrumSchematicNode,
  zentrumSchematicNodeById,
} from "../../lib/zentrum-schematic-plan";
import type { ZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematicCanvas, type ZentrumStopTravelTag } from "./ZentrumSchematicCanvas";
import {
  ZentrumPlanControls,
  ZentrumSchematicToolbar,
  type ZentrumPlanReading,
} from "./ZentrumSchematicToolbar";
import {
  type ZentrumReachedStop,
  ZentrumStopPanel,
  type ZentrumStopReading,
} from "./ZentrumStopPanel";
import { ZentrumVehicleDetail } from "./ZentrumVehicleDetail";

/** A count read as rider-facing German text, in the singular where there is one. */
const formatCount = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The caption under the drawing: only what cannot be read off it, i.e. what the colour means
 * and, while nothing is chosen, that a stop can be tapped.
 */
const getZentrumSchematicCaption = (
  selectedLineId: string | undefined,
  vehicleCount: number,
  colour: ZentrumPlanReading | ZentrumStopReading,
): string => {
  if (colour === "departures") return "Farbig: Weg der nächsten Bahnen hierher";
  if (colour === "travelTimes") return "Minuten bis zur Ankunft, ohne Umsteigen";
  if (selectedLineId) {
    return vehicleCount === 0
      ? `Linie ${selectedLineId} · gerade keine Bahn im Plan`
      : `Linie ${selectedLineId} · ${formatCount(vehicleCount, "Bahn", "Bahnen")} im Plan`;
  }
  const running = formatCount(vehicleCount, "Bahn", "Bahnen");
  return colour === "progress"
    ? `${running} · farbig: ihr Weg voraus`
    : `${running} im Plan · Haltestelle antippen`;
};

/** What one opened stop lights on the plan, and the readings that go with it. */
type ZentrumStopView = {
  overlay: ZentrumSchematicOverlay;
  /** The stop's board, or nothing while it has not answered. */
  rows?: readonly ZentrumStopBoardRow[];
  reachedStops: readonly ZentrumReachedStop[];
  /** The countdown each tram the stop is waiting for carries on the plan. */
  vehicleMinutesById?: ReadonlyMap<string, number>;
  /** The minutes and line each reached stop is printed with on the plan. */
  stopMinutesByNodeId?: ReadonlyMap<string, ZentrumStopTravelTag>;
};

const getZentrumStopView = (
  reading: ZentrumStopReading,
  stop: ZentrumSchematicNode,
  board: DepartureBoard | null,
  vehicles: readonly ZentrumSchematicVehicle[],
  runDepartures: readonly Departure[],
  feedNow: number,
): ZentrumStopView => {
  if (reading === "departures") {
    const { rows, overlay, vehicleMinutesById } = getZentrumStopBoard(
      board?.departures ?? [],
      vehicles,
      stop.id,
      feedNow,
    );
    return { overlay, rows: board ? rows : undefined, reachedStops: [], vehicleMinutesById };
  }
  const { travelTimesByNodeId, overlay } = getZentrumTravelTimes(runDepartures, stop.id, feedNow);
  const reachedStops = [...travelTimesByNodeId]
    .flatMap(([nodeId, time]) => {
      const node = zentrumSchematicNodeById.get(nodeId);
      return node ? [{ ...time, nodeId, label: node.label }] : [];
    })
    .sort(
      (left, right) => left.arrivesAt - right.arrivesAt || left.label.localeCompare(right.label),
    );
  return {
    overlay,
    reachedStops,
    stopMinutesByNodeId: new Map(
      reachedStops.map(({ nodeId, arrivesAt, lineId }) => [
        nodeId,
        { minutes: getMinutesUntilArrival(arrivesAt, feedNow), lineId },
      ]),
    ),
  };
};

/**
 * The plan with its controls, the band under it, and the panel for whatever is opened. The plan's
 * own reading is chosen in the band; an opened stop lights the plan from there and brings its own
 * readings to the panel. A vehicle opens over the stop it was found from.
 */
export function ZentrumSchematic({
  layout,
  getSign,
  selectedLineId,
  selectedStopId,
  runDepartures,
  stopBoard,
  feedNow,
  isFullscreen,
  onSelectLine,
  onSelectStop,
  onChangeFullscreen,
}: {
  /** The lanes laid out for what runs over the plan, drawn here at the width the plan is shown. */
  layout: ZentrumSchematicLayout;
  getSign: ZentrumLineSignReader;
  /** The followed line, as the address names it. */
  selectedLineId?: string;
  /** The opened stop, as the address names it. */
  selectedStopId?: string;
  /** Every run the posts name, including those not on the plan yet. */
  runDepartures: readonly Departure[];
  /** The opened stop's own board, or null until it answers. */
  stopBoard: DepartureBoard | null;
  feedNow: number;
  /** Whether the plan fills the screen. */
  isFullscreen: boolean;
  onSelectLine: (lineId: string | undefined) => void;
  onSelectStop: (stopId: string | undefined) => void;
  onChangeFullscreen: (isFullscreen: boolean) => void;
}) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>();
  const [planReading, setPlanReading] = useState<ZentrumPlanReading>("lines");
  const [stopReading, setStopReading] = useState<ZentrumStopReading>("travelTimes");
  const plan = useZentrumPlanCanvas();
  // The lane width follows the plan's size on screen, so the geometry is drawn where it is measured.
  const [drawSchematic] = useState(createZentrumSchematicDrawer);
  const schematic = useMemo(
    () => drawSchematic(layout, plan.planWidth),
    [drawSchematic, layout, plan.planWidth],
  );
  // How the marks have been moving, kept while the plan is mounted.
  const [motions] = useState(createRunMotions);
  const vehicles = getZentrumSchematicVehicles(schematic, runDepartures, feedNow, motions);

  // Escape leaves full screen; back already does, since the size is part of the address.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onChangeFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen, onChangeFullscreen]);

  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId);
  const selectedStop =
    selectedStopId === undefined ? undefined : zentrumSchematicNodeById.get(selectedStopId);
  // An opened stop lights the plan; without one, the plan's own reading does.
  const stopView = selectedStop
    ? getZentrumStopView(stopReading, selectedStop, stopBoard, vehicles, runDepartures, feedNow)
    : undefined;
  const overlay =
    stopView?.overlay ??
    (planReading === "progress" ? getZentrumProgressOverlay(vehicles) : undefined);
  const followedVehicleCount = selectedLineId
    ? vehicles.filter((vehicle) => vehicle.lineId === selectedLineId).length
    : vehicles.length;

  // The open vehicle belonged to the previous reading.
  const selectLine = (lineId: string | undefined) => {
    setSelectedVehicleId(undefined);
    onSelectLine(lineId);
  };
  // Stable, so the memoized stops do not re-render every second.
  const selectStop = useCallback(
    (stopId: string | undefined) => {
      setSelectedVehicleId(undefined);
      onSelectStop(stopId === selectedStopId ? undefined : stopId);
    },
    [onSelectStop, selectedStopId],
  );
  const toggleVehicle = (vehicleId: string) =>
    setSelectedVehicleId((current) => (current === vehicleId ? undefined : vehicleId));

  const sheet = selectedVehicle ? (
    <ZentrumVehicleDetail
      vehicle={selectedVehicle}
      getSign={getSign}
      feedNow={feedNow}
      returnLabel={selectedStop?.label}
      onClose={() => setSelectedVehicleId(undefined)}
    />
  ) : selectedStop && stopView ? (
    <ZentrumStopPanel
      stopId={selectedStop.id}
      label={selectedStop.label}
      reading={stopReading}
      onChangeReading={setStopReading}
      rows={stopView.rows}
      board={stopBoard}
      reachedStops={stopView.reachedStops}
      selectedVehicleId={selectedVehicleId}
      onSelectVehicle={toggleVehicle}
      getSign={getSign}
      feedNow={feedNow}
      onClose={() => selectStop(undefined)}
    />
  ) : undefined;

  return (
    <section
      className="zentrum-schematic"
      data-following={selectedLineId !== undefined}
      data-fullscreen={isFullscreen}
      data-has-sheet={sheet !== undefined}
      aria-label="Schematischer Linienplan des Zentrums"
    >
      <div className="zentrum-schematic-main">
        <div className="zentrum-schematic-stage">
          <ZentrumSchematicCanvas
            schematic={schematic}
            getSign={getSign}
            selectedLineId={selectedLineId}
            selectedStationId={selectedStop?.id}
            vehicles={vehicles}
            overlay={overlay}
            vehicleMinutesById={stopView?.vehicleMinutesById}
            stopMinutesByNodeId={stopView?.stopMinutesByNodeId}
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={toggleVehicle}
            onSelectStation={selectStop}
            scrollRef={plan.scrollRef}
            zoom={plan.zoom}
            planWidth={plan.planWidth}
          />
          <ZentrumPlanControls
            zoom={plan.zoom}
            canZoomIn={plan.canZoomIn}
            canZoomOut={plan.canZoomOut}
            onChangeZoom={plan.changeZoom}
            isFullscreen={isFullscreen}
            onChangeFullscreen={onChangeFullscreen}
          />
        </div>
        <ZentrumSchematicToolbar
          caption={getZentrumSchematicCaption(
            selectedLineId,
            followedVehicleCount,
            selectedStop ? stopReading : planReading,
          )}
          lineIds={schematic.lineIds}
          getSign={getSign}
          selectedLineId={selectedLineId}
          onSelectLine={selectLine}
          planReading={planReading}
          onChangePlanReading={selectedStop ? undefined : setPlanReading}
        />
      </div>
      {sheet}
    </section>
  );
}
