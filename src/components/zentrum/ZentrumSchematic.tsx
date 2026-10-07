import { getZentrumSchematicStopId } from "../../lib/zentrum-schematic-plan";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Departure, DepartureBoard } from "../../data/transit-types";
import { useDeviceNow } from "../../hooks/clock";
import { getZentrumPositionFreshness } from "../../lib/zentrum-presentation";
import { useStoredPreference } from "../../hooks/stored-preference";
import { useZentrumPlanCanvas } from "../../hooks/zentrum-plan-canvas";
import { findTurnarounds } from "../../lib/line-turnarounds";
import { useRunMotions } from "../../hooks/run-motions";
import {
  type ZentrumSchematicLayout,
  createZentrumSchematicDrawer,
  getZentrumSchematicBranchIdsOnPlan,
  getZentrumSchematicVehicles,
} from "../../lib/zentrum-schematic";
import {
  type ZentrumTravelMeasure,
  getZentrumDirectRides,
  getZentrumVehiclePathsOverlay,
  getZentrumApproachingVehicleIds,
} from "../../lib/zentrum-schematic-overlays";
import { getZentrumStopView, type ZentrumStopReading } from "../../lib/zentrum-stop-view";
import { zentrumPlanOptions } from "../../lib/zentrum-plan-options";
import { type ZentrumPanelEntranceMotion, zentrumStopPanelState } from "../../lib/zentrum-panel";
import { zentrumSchematicNodeById } from "../../lib/zentrum-schematic-plan";
import { ARE_OTHER_EXPERIMENT_MAPS_SHOWN } from "../../routing";
import { ExperimentMapSwitch } from "../experiment/ExperimentMapSwitch";
import type { ZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematicCanvas } from "./ZentrumSchematicCanvas";
import { ZentrumPlanOptionsMenu } from "./ZentrumPlanOptionsMenu";
import { ZentrumPlanControls, ZentrumSchematicToolbar } from "./ZentrumSchematicToolbar";
import { ZentrumStopPanel } from "./ZentrumStopPanel";
import { ZentrumStopBar } from "./ZentrumStopBar";
import { ZentrumStopSearch } from "./ZentrumStopSearch";
import { ZentrumDestinationDetail } from "./ZentrumDestinationDetail";
import { ZentrumVehicleDetail } from "./ZentrumVehicleDetail";
import { ZentrumLoading } from "./ZentrumLoading";

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
    return travelMeasure === "arrival"
      ? "Minuten bis zur Ankunft, ohne Umsteigen"
      : "Minuten Fahrzeit, ohne Umsteigen";
  }
  if (selectedLineId) {
    return vehicleCount === 0
      ? `Linie ${selectedLineId} · gerade keine Bahn im Plan`
      : `Linie ${selectedLineId} · ${formatCount(vehicleCount, "Bahn", "Bahnen")} im Plan`;
  }
  const running = formatCount(vehicleCount, "Bahn", "Bahnen");
  return isShowingVehiclePaths
    ? `${running} · geschätzte Positionen · farbig: Fahrwege`
    : "Positionen geschätzt · Haltestelle antippen";
};

type ZentrumDetailSelection =
  | { kind: "vehicle"; vehicleId: string }
  | { kind: "destination"; originStopId: string; destinationStopId: string };

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
  isLoading,
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
  isLoading: boolean;
  /** Whether the plan fills the screen. */
  isFullscreen: boolean;
  /** Whether an opened panel stands under the plan rather than beside it. */
  isStacked: boolean;
  /** Why the plan did not open at the rider's nearest stop, while that is news. */
  locationNote?: string;
  onSelectLine: (lineId: string | undefined) => void;
  onSelectStop: (stopId: string | undefined) => void;
  onChangeFullscreen: (isFullscreen: boolean) => void;
}) {
  const [detailSelection, setDetailSelection] = useState<ZentrumDetailSelection>();
  const [hoveredLineIds, setHoveredLineIds] = useState<readonly string[]>([]);
  const selectedVehicleId =
    detailSelection?.kind === "vehicle" ? detailSelection.vehicleId : undefined;
  const [stopReading, setStopReading] = useState<ZentrumStopReading>("destinations");
  const plan = useZentrumPlanCanvas();
  const options = useStoredPreference(zentrumPlanOptions);
  const stopPanelState = useStoredPreference(zentrumStopPanelState) ?? "collapsed";
  const [panelEntranceMotion, setPanelEntranceMotion] =
    useState<ZentrumPanelEntranceMotion>("slide");
  // The lane width follows the plan's on-screen size; a line's branch is drawn while its tram is on
  // the plan. The drawer returns the same reading until either changes.
  const [drawSchematic] = useState(createZentrumSchematicDrawer);
  const schematic = useMemo(
    () =>
      drawSchematic(
        layout,
        plan.planWidth,
        getZentrumSchematicBranchIdsOnPlan(layout, runDepartures, feedNow),
      ),
    [drawSchematic, layout, plan.planWidth, runDepartures, feedNow],
  );
  const [hasPlacedVehicles, setHasPlacedVehicles] = useState(false);
  useEffect(() => {
    if (hasPlacedVehicles || isLoading || plan.planWidth === undefined) return;
    // The measured lines must paint before the first vehicle layer appears.
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => setHasPlacedVehicles(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hasPlacedVehicles, isLoading, plan.planWidth, schematic]);
  const isPreparingVehicles = !hasPlacedVehicles;
  // Mark motion, shared with every view. Placed once per tick, so other renders re-place nothing.
  const motions = useRunMotions();
  const turnarounds = useMemo(() => findTurnarounds(runDepartures), [runDepartures]);
  const vehicles = useMemo(
    () =>
      isPreparingVehicles
        ? []
        : getZentrumSchematicVehicles(schematic, runDepartures, feedNow, motions, turnarounds),
    [isPreparingVehicles, schematic, runDepartures, feedNow, motions, turnarounds],
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

  const readingNow = useDeviceNow();
  const freshness = getZentrumPositionFreshness(
    vehicles.map(({ departure }) => departure),
    readingNow,
  );
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId);
  const selectedStop =
    selectedStopId === undefined ? undefined : zentrumSchematicNodeById.get(selectedStopId);
  const stopView = useMemo(
    () =>
      selectedStop
        ? getZentrumStopView(
            stopReading,
            selectedStop.id,
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
  // With Fahrwege on, an opened stop keeps the trams that have left it half visible.
  const departedVehicleIds = useMemo(() => {
    if (!selectedStop || options.vehiclePathMode !== "ahead") return undefined;
    const approachingIds = getZentrumApproachingVehicleIds(vehicles, selectedStop.id);
    return new Set(
      vehicles.filter((vehicle) => !approachingIds.has(vehicle.id)).map((vehicle) => vehicle.id),
    );
  }, [selectedStop, options.vehiclePathMode, vehicles]);
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
    setDetailSelection(undefined);
    onSelectLine(lineId);
  };
  // Stable, so memoized stops do not re-render every second.
  const selectStop = useCallback(
    (stopId: string | undefined) => {
      setDetailSelection(undefined);
      setPanelEntranceMotion("slide");
      const address = stopId === undefined ? undefined : getZentrumSchematicStopId(stopId);
      onSelectStop(address === selectedStopId ? undefined : address);
    },
    [onSelectStop, selectedStopId],
  );
  // Opened from a stop, a tram's detail rises from the stop's bar.
  const toggleVehicle = (vehicleId: string) => {
    setPanelEntranceMotion(selectedStop ? "rise" : "slide");
    setDetailSelection((current) =>
      current?.kind === "vehicle" && current.vehicleId === vehicleId
        ? undefined
        : { kind: "vehicle", vehicleId },
    );
  };

  // A tram's detail always opens whole; closing it returns to the stop as the rider left it.
  const selectedDestination =
    detailSelection?.kind === "destination" &&
    detailSelection.originStopId === selectedStopId &&
    stopReading === "destinations"
      ? stopView?.reachableStops.find((stop) => stop.nodeId === detailSelection.destinationStopId)
      : undefined;
  const destinationNodeId = selectedDestination?.nodeId;
  const destinationRides = useMemo(
    () =>
      selectedStop && destinationNodeId
        ? getZentrumDirectRides(runDepartures, selectedStop.id, destinationNodeId, feedNow)
        : [],
    [selectedStop, destinationNodeId, runDepartures, feedNow],
  );
  const isStopPanelOpen = !selectedVehicle && !selectedDestination && stopPanelState === "expanded";
  const selectDestination = (nodeId: string) => {
    if (!selectedStop) return;
    setDetailSelection({
      kind: "destination",
      originStopId: selectedStop.id,
      destinationStopId: nodeId,
    });
  };
  const toggleStopPanel = () => {
    setPanelEntranceMotion("rise");
    setDetailSelection(undefined);
    zentrumStopPanelState.write(isStopPanelOpen ? "collapsed" : "expanded");
  };

  const panel = selectedVehicle ? (
    <ZentrumVehicleDetail
      vehicle={selectedVehicle}
      getSign={getSign}
      feedNow={feedNow}
      readingNow={readingNow}
      returnLabel={selectedStop?.label}
      entranceMotion={panelEntranceMotion}
      onClose={() => setDetailSelection(undefined)}
    />
  ) : selectedDestination && selectedStop ? (
    <ZentrumDestinationDetail
      key={`${selectedStop.id}:${selectedDestination.nodeId}`}
      originStopId={selectedStop.id}
      originStopLabel={selectedStop.label}
      reachableStop={selectedDestination}
      rides={destinationRides}
      board={stopBoard}
      feedNow={feedNow}
      getSign={getSign}
      onSelectStop={selectStop}
      onClose={() => {
        setDetailSelection(undefined);
        zentrumStopPanelState.write("expanded");
      }}
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
      isLoading={isLoading}
      selectedVehicleId={selectedVehicleId}
      onSelectVehicle={toggleVehicle}
      onSelectDestination={selectDestination}
      getSign={getSign}
      feedNow={feedNow}
      entranceMotion={panelEntranceMotion}
    />
  ) : undefined;
  const stopBar = selectedStop && (
    <ZentrumStopBar
      label={selectedStop.label}
      reading={stopReading}
      onChangeReading={(reading) => {
        setStopReading(reading);
        setDetailSelection(undefined);
      }}
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
      data-pale-lines={options.paleLineStyle}
      aria-label="Schematischer Linienplan des Zentrums"
      aria-busy={isPreparingVehicles}
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
          departedVehicleIds={departedVehicleIds}
          stopMinutesByNodeId={stopView?.stopMinutesByNodeId}
          selectedVehicleId={selectedVehicleId}
          onSelectVehicle={toggleVehicle}
          onSelectStop={selectStop}
          onSelectLine={selectLine}
          onHoverLines={setHoveredLineIds}
          scrollRef={plan.scrollRef}
          zoom={plan.zoom}
          planWidth={plan.planWidth}
        />
        {freshness && <p className="zentrum-position-freshness">{freshness}</p>}
        <ZentrumPlanControls
          zoom={plan.zoom}
          canZoomIn={plan.canZoomIn}
          canZoomOut={plan.canZoomOut}
          onChangeZoom={plan.changeZoom}
          isFullscreen={isFullscreen}
          onChangeFullscreen={onChangeFullscreen}
          optionsMenu={<ZentrumPlanOptionsMenu />}
          stopSearch={
            <ZentrumStopSearch
              lineIdsByNodeId={schematic.lineIdsByNodeId}
              onSelectStop={selectStop}
            />
          }
          onFitWholePlan={plan.fitWholePlan}
        />
        {ARE_OTHER_EXPERIMENT_MAPS_SHOWN && <ExperimentMapSwitch map="center" />}
        {isPreparingVehicles && <ZentrumLoading />}
      </div>
      <ZentrumSchematicToolbar
        caption={
          (isPreparingVehicles
            ? schematic.lineIds.length === 0
              ? "Linien werden aufgebaut …"
              : "Fahrten werden ergänzt …"
            : locationNote) ??
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
        hoveredLineIds={hoveredLineIds}
        onSelectLine={selectLine}
        stopBar={stopBar}
      />
      {panel}
    </section>
  );
}
