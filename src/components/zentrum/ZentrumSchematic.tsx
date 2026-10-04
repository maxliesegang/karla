import { useCallback, useEffect, useMemo, useState } from "react";
import type { Departure, DepartureBoard } from "../../data/transit-types";
import { useStoredPreference } from "../../hooks/stored-preference";
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
  type ZentrumTravelMeasure,
  getMinutesUntilArrival,
  getRideMinutes,
  getZentrumVehiclePathsOverlay,
  getZentrumStopBoard,
  getZentrumTravelTimes,
  type ZentrumTravelTime,
} from "../../lib/zentrum-schematic-overlays";
import { zentrumPlanOptions } from "../../lib/zentrum-plan-options";
import { type ZentrumPanelEntranceMotion, zentrumStopPanelState } from "../../lib/zentrum-panel";
import {
  type ZentrumSchematicNode,
  zentrumSchematicNodeById,
} from "../../lib/zentrum-schematic-plan";
import type { ZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematicCanvas, type ZentrumStopTravelTag } from "./ZentrumSchematicCanvas";
import { ZentrumPlanControls, ZentrumSchematicToolbar } from "./ZentrumSchematicToolbar";
import {
  type ZentrumReachableStop,
  ZentrumStopPanel,
  type ZentrumStopReading,
} from "./ZentrumStopPanel";
import { ZentrumStopBar } from "./ZentrumStopBar";
import { ZentrumVehicleDetail } from "./ZentrumVehicleDetail";

/** A German count, singular where it applies. */
const formatCount = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** The caption: what the colour means and, while nothing is chosen, that stops can be tapped. */
const getZentrumSchematicCaption = (
  selectedLineId: string | undefined,
  vehicleCount: number,
  stopReading: ZentrumStopReading | undefined,
  travelMeasure: ZentrumTravelMeasure,
  isShowingVehiclePaths: boolean,
): string => {
  if (stopReading === "departures") return "Farbig: Weg der nächsten Bahnen hierher";
  if (stopReading === "destinations") {
    return travelMeasure === "ride"
      ? "Minuten Fahrzeit, ohne Umsteigen"
      : "Minuten bis zur Ankunft, ohne Umsteigen";
  }
  if (selectedLineId) {
    return vehicleCount === 0
      ? `Linie ${selectedLineId} · gerade keine Bahn im Plan`
      : `Linie ${selectedLineId} · ${formatCount(vehicleCount, "Bahn", "Bahnen")} im Plan`;
  }
  const running = formatCount(vehicleCount, "Bahn", "Bahnen");
  return isShowingVehiclePaths
    ? `${running} · farbig: wohin sie fahren`
    : `${running} im Plan · Haltestelle antippen`;
};

/** What an opened stop lights, and its readings. */
type ZentrumStopView = {
  overlay: ZentrumSchematicOverlay;
  /** The stop's board, or nothing while it has not answered. */
  rows?: readonly ZentrumStopBoardRow[];
  reachableStops: readonly ZentrumReachableStop[];
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
  travelMeasure: ZentrumTravelMeasure,
): ZentrumStopView => {
  if (reading === "departures") {
    const { rows, overlay, vehicleMinutesById } = getZentrumStopBoard(
      board?.departures ?? [],
      vehicles,
      stop.id,
      feedNow,
    );
    return { overlay, rows: board ? rows : undefined, reachableStops: [], vehicleMinutesById };
  }
  const { travelTimesByNodeId, overlay } = getZentrumTravelTimes(
    runDepartures,
    stop.id,
    feedNow,
    travelMeasure,
  );
  const getMinutes = (time: ZentrumTravelTime) =>
    travelMeasure === "ride"
      ? getRideMinutes(time)
      : getMinutesUntilArrival(time.arrivesAt, feedNow);
  const reachableStops = [...travelTimesByNodeId]
    .flatMap(([nodeId, time]) => {
      const node = zentrumSchematicNodeById.get(nodeId);
      return node ? [{ ...time, nodeId, label: node.label, minutes: getMinutes(time) }] : [];
    })
    .sort(
      (left, right) =>
        left.minutes - right.minutes ||
        left.arrivesAt - right.arrivesAt ||
        left.label.localeCompare(right.label),
    );
  return {
    overlay,
    reachableStops,
    stopMinutesByNodeId: new Map(
      reachableStops.map(({ nodeId, minutes, lineId }) => [
        nodeId,
        { minutes, lineId, measure: travelMeasure },
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
  locationNote,
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
  /** Why the plan did not open at the rider's nearest stop, while that is news. */
  locationNote?: string;
  onSelectLine: (lineId: string | undefined) => void;
  onSelectStop: (stopId: string | undefined) => void;
  onChangeFullscreen: (isFullscreen: boolean) => void;
}) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>();
  const [stopReading, setStopReading] = useState<ZentrumStopReading>("destinations");
  const plan = useZentrumPlanCanvas();
  const options = useStoredPreference(zentrumPlanOptions);
  const stopPanelState = useStoredPreference(zentrumStopPanelState);
  const [panelEntranceMotion, setPanelEntranceMotion] =
    useState<ZentrumPanelEntranceMotion>("slide");
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
  const stopView = useMemo(
    () =>
      selectedStop
        ? getZentrumStopView(
            stopReading,
            selectedStop,
            stopBoard,
            vehicles,
            runDepartures,
            feedNow,
            options.travelMeasure,
          )
        : undefined,
    [stopReading, selectedStop, stopBoard, vehicles, runDepartures, feedNow, options.travelMeasure],
  );
  const isShowingVehiclePaths = !selectedStop && options.vehiclePathMode === "ahead";
  const overlay = useMemo(
    () =>
      stopView?.overlay ??
      (isShowingVehiclePaths ? getZentrumVehiclePathsOverlay(vehicles) : undefined),
    [stopView, isShowingVehiclePaths, vehicles],
  );
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
      setPanelEntranceMotion("slide");
      onSelectStop(stopId === selectedStopId ? undefined : stopId);
    },
    [onSelectStop, selectedStopId],
  );
  // Opened from a stop, a tram's detail rises from the stop's bar.
  const toggleVehicle = (vehicleId: string) => {
    setPanelEntranceMotion(selectedStop ? "rise" : "slide");
    setSelectedVehicleId((current) => (current === vehicleId ? undefined : vehicleId));
  };

  // A tram's detail always opens whole; closing it returns to the stop as the rider left it.
  const isStopPanelOpen = !selectedVehicle && stopPanelState === "expanded";
  const toggleStopPanel = () => {
    setPanelEntranceMotion("rise");
    setSelectedVehicleId(undefined);
    zentrumStopPanelState.write(isStopPanelOpen ? "collapsed" : "expanded");
  };

  const panel = selectedVehicle ? (
    <ZentrumVehicleDetail
      vehicle={selectedVehicle}
      getSign={getSign}
      feedNow={feedNow}
      returnLabel={selectedStop?.label}
      entranceMotion={panelEntranceMotion}
      onClose={() => setSelectedVehicleId(undefined)}
    />
  ) : selectedStop && stopView && isStopPanelOpen ? (
    <ZentrumStopPanel
      stopId={selectedStop.id}
      label={selectedStop.label}
      reading={stopReading}
      rows={stopView.rows}
      board={stopBoard}
      reachableStops={stopView.reachableStops}
      travelMeasure={options.travelMeasure}
      selectedVehicleId={selectedVehicleId}
      onSelectVehicle={toggleVehicle}
      getSign={getSign}
      feedNow={feedNow}
      entranceMotion={panelEntranceMotion}
    />
  ) : undefined;
  const stopBar = selectedStop && (
    <ZentrumStopBar
      label={selectedStop.label}
      reading={stopReading}
      onChangeReading={setStopReading}
      isPanelOpen={isStopPanelOpen}
      onTogglePanel={toggleStopPanel}
      onClose={() => selectStop(undefined)}
    />
  );

  return (
    <section
      className="zentrum-schematic"
      data-following={selectedLineId !== undefined}
      data-fullscreen={isFullscreen}
      data-has-panel={panel !== undefined}
      aria-label="Schematischer Linienplan des Zentrums"
    >
      <div className="zentrum-schematic-stage">
        <ZentrumSchematicCanvas
          schematic={schematic}
          getSign={getSign}
          selectedLineId={selectedLineId}
          selectedStopId={selectedStop?.id}
          vehicles={vehicles}
          overlay={overlay}
          unlitLineStyle={options.unlitLineStyle}
          vehicleMinutesById={stopView?.vehicleMinutesById}
          stopMinutesByNodeId={stopView?.stopMinutesByNodeId}
          selectedVehicleId={selectedVehicleId}
          onSelectVehicle={toggleVehicle}
          onSelectStop={selectStop}
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
          isStopOpen={selectedStop !== undefined}
        />
      </div>
      <ZentrumSchematicToolbar
        caption={
          locationNote ??
          getZentrumSchematicCaption(
            selectedLineId,
            followedVehicleCount,
            selectedStop ? stopReading : undefined,
            options.travelMeasure,
            isShowingVehiclePaths,
          )
        }
        lineIds={schematic.lineIds}
        getSign={getSign}
        selectedLineId={selectedLineId}
        onSelectLine={selectLine}
        stopBar={stopBar}
      />
      {panel}
    </section>
  );
}
