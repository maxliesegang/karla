import { useEffect, useState } from "react";
import type { Departure, DepartureBoard } from "../../data/transit-types";
import { useZentrumPlanCanvas } from "../../hooks/zentrum-plan-canvas";
import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import {
  type ZentrumSchematicOverlay,
  type ZentrumStopBoardRow,
  getMinutesUntilArrival,
  getZentrumProgressOverlay,
  getZentrumStopBoard,
  getZentrumTravelTimes,
} from "../../lib/zentrum-schematic-overlays";
import {
  type ZentrumSchematicBoardingPlace,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
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
 * The caption under the drawing: what the colour on it means, in as few words as that takes.
 *
 * It says what cannot be read off the drawing — what the colour stands for in the reading being
 * shown, and, while nothing is chosen, that a stop can be. What the reader can already see, they are
 * not told: which lines are drawn is the legend beside it, and where the reading came from is the
 * page's provenance footer.
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
  /** The minutes each reached stop is printed with on the plan, and the line that gets there. */
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
 * The Zentrum's plan as it is read: the drawing with its own controls, the band under it, and the
 * panel beside it for whatever a reader opened.
 *
 * Two levels of choice, each one segmented control. The plan's own reading -- its lines, or where
 * the trams on it are still going -- sits in the band under it. An opened stop is the other level:
 * it is in the address, lights the plan from that stop, and brings its own two readings in the
 * panel, where the departure board stands beside a line's diagram. A vehicle opens in the same
 * panel, over the stop it was found from, and closing it returns there.
 */
export function ZentrumSchematic({
  edges,
  linePaths,
  trackWidth,
  boardingPlacesByNodeId,
  lineIdsByNodeId,
  lineIds,
  getSign,
  selectedLineId,
  selectedStopId,
  vehicles,
  runDepartures,
  stopBoard,
  feedNow,
  isFullscreen,
  onSelectLine,
  onSelectStop,
  onChangeFullscreen,
}: {
  edges: readonly ZentrumSchematicEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  /** The one width the lanes are laid out on, which is also the width they are painted at. */
  trackWidth: number;
  /** The stops the reading can name more than one place to stand at, which are marked once each. */
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  lineIds: readonly string[];
  getSign: ZentrumLineSignReader;
  /** The line the plan is following, as the address names it. */
  selectedLineId?: string;
  /** The stop the plan is read from, as the address names it. */
  selectedStopId?: string;
  vehicles: readonly ZentrumSchematicVehicle[];
  /** Every run the posts name, the ones not on the plan yet included: what a stop's wait is read from. */
  runDepartures: readonly Departure[];
  /** The opened stop's own board, or nothing while it has not answered. */
  stopBoard: DepartureBoard | null;
  feedNow: number;
  /** Whether the plan is being read at the size of the screen. */
  isFullscreen: boolean;
  onSelectLine: (lineId: string | undefined) => void;
  onSelectStop: (stopId: string | undefined) => void;
  onChangeFullscreen: (isFullscreen: boolean) => void;
}) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>();
  const [planReading, setPlanReading] = useState<ZentrumPlanReading>("lines");
  const [stopReading, setStopReading] = useState<ZentrumStopReading>("travelTimes");
  const plan = useZentrumPlanCanvas();

  // Escape is what a reader expects to close a thing that took the screen, and the back gesture is
  // the other -- which the address already answers, because the size is a level of it.
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
  // An opened stop is the reading the plan is lit by; without one, the plan's own reading is.
  const stopView = selectedStop
    ? getZentrumStopView(stopReading, selectedStop, stopBoard, vehicles, runDepartures, feedNow)
    : undefined;
  const overlay =
    stopView?.overlay ??
    (planReading === "progress" ? getZentrumProgressOverlay(vehicles) : undefined);
  const followedVehicleCount = selectedLineId
    ? vehicles.filter((vehicle) => vehicle.lineId === selectedLineId).length
    : vehicles.length;

  // Following another line, or opening another stop, is another reading of the plan, and the
  // vehicle that was open belonged to the old one.
  const selectLine = (lineId: string | undefined) => {
    setSelectedVehicleId(undefined);
    onSelectLine(lineId);
  };
  const selectStop = (stopId: string | undefined) => {
    setSelectedVehicleId(undefined);
    onSelectStop(stopId === selectedStopId ? undefined : stopId);
  };
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
            edges={edges}
            linePaths={linePaths}
            trackWidth={trackWidth}
            boardingPlacesByNodeId={boardingPlacesByNodeId}
            lineIdsByNodeId={lineIdsByNodeId}
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
          lineIds={lineIds}
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
