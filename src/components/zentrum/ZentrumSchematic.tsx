import { useCallback, useEffect, useMemo, useState } from "react";
import type { Departure, DepartureBoard } from "../../data/transit-types";
import { useZentrumPlanCanvas } from "../../hooks/zentrum-plan-canvas";
import { findTurnarounds } from "../../lib/line-turnarounds";
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
  getZentrumStopBoard,
  getZentrumTravelTimes,
} from "../../lib/zentrum-schematic-overlays";
import {
  type ZentrumSchematicNode,
  zentrumSchematicNodeById,
} from "../../lib/zentrum-schematic-plan";
import type { ZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematicCanvas, type ZentrumStopTravelTag } from "./ZentrumSchematicCanvas";
import { ZentrumPlanControls, ZentrumSchematicToolbar } from "./ZentrumSchematicToolbar";
import {
  type ZentrumReachedStop,
  ZentrumStopPanel,
  type ZentrumStopReading,
} from "./ZentrumStopPanel";
import { ZentrumVehicleDetail } from "./ZentrumVehicleDetail";

/** A German count, singular where it applies. */
const formatCount = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The caption: what the colour means and, while nothing is chosen, that stops can be tapped. */
const getZentrumSchematicCaption = (
  selectedLineId: string | undefined,
  vehicleCount: number,
  stopReading: ZentrumStopReading | undefined,
): string => {
  if (stopReading === "departures") return "Farbig: Weg der nächsten Bahnen hierher";
  if (stopReading === "destinations") return "Minuten bis zur Ankunft, ohne Umsteigen";
  if (selectedLineId) {
    return vehicleCount === 0
      ? `Linie ${selectedLineId} · gerade keine Bahn im Plan`
      : `Linie ${selectedLineId} · ${formatCount(vehicleCount, "Bahn", "Bahnen")} im Plan`;
  }
  return `${formatCount(vehicleCount, "Bahn", "Bahnen")} im Plan · Haltestelle antippen`;
};

/** What an opened stop lights, and its readings. */
type ZentrumStopView = {
  overlay: ZentrumSchematicOverlay;
  /** The stop's board, or nothing while it has not answered. */
  rows?: readonly ZentrumStopBoardRow[];
  reachedStops: readonly ZentrumReachedStop[];
  /** The countdown on each tram the stop waits for. */
  vehicleMinutesById?: ReadonlyMap<string, number>;
  /** Minutes and line printed at each reached stop. */
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
 * The plan, its controls, the reading band and the panel for whatever is opened. A vehicle opens
 * over the stop it was found from.
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
  /** The lane layout, drawn here at the shown width. */
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
  const [stopReading, setStopReading] = useState<ZentrumStopReading>("destinations");
  const plan = useZentrumPlanCanvas();
  // The lane width follows the plan's on-screen size.
  const [drawSchematic] = useState(createZentrumSchematicDrawer);
  const schematic = useMemo(
    () => drawSchematic(layout, plan.planWidth),
    [drawSchematic, layout, plan.planWidth],
  );
  // Mark motion, kept while mounted. Placed once per tick, so other renders re-place nothing.
  const [motions] = useState(createRunMotions);
  const turnarounds = useMemo(() => findTurnarounds(runDepartures), [runDepartures]);
  const vehicles = useMemo(
    () => getZentrumSchematicVehicles(schematic, runDepartures, feedNow, motions, turnarounds),
    [schematic, runDepartures, feedNow, motions, turnarounds],
  );

  // Escape leaves full screen; back does too, since size is in the address.
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
  // Only an opened stop lights the plan.
  const stopView = selectedStop
    ? getZentrumStopView(stopReading, selectedStop, stopBoard, vehicles, runDepartures, feedNow)
    : undefined;
  const overlay = stopView?.overlay;
  const followedVehicleCount = selectedLineId
    ? vehicles.filter((vehicle) => vehicle.lineId === selectedLineId).length
    : vehicles.length;

  // The open vehicle belonged to the previous reading.
  const selectLine = (lineId: string | undefined) => {
    setSelectedVehicleId(undefined);
    onSelectLine(lineId);
  };
  // Stable, so memoized stops do not re-render every second.
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
            selectedStop ? stopReading : undefined,
          )}
          lineIds={schematic.lineIds}
          getSign={getSign}
          selectedLineId={selectedLineId}
          onSelectLine={selectLine}
        />
      </div>
      {sheet}
    </section>
  );
}
