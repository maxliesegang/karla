import { useEffect, useState } from "react";
import { useZentrumPlanCanvas } from "../../hooks/zentrum-plan-canvas";
import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import type {
  ZentrumSchematicBoardingPlace,
  ZentrumSchematicEdge,
  ZentrumSchematicLinePath,
} from "../../lib/zentrum-schematic-plan";
import type { ZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematicCanvas } from "./ZentrumSchematicCanvas";
import { ZentrumSchematicToolbar } from "./ZentrumSchematicToolbar";
import { ZentrumVehicleDetail } from "./ZentrumVehicleDetail";

/** A count read as rider-facing German text, in the singular where there is one. */
const formatCount = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The caption at the foot of the drawing: what the marks on it are, in as few words as that takes.
 *
 * It says what cannot be read off the drawing — that the marks are estimates rather than fixes, and,
 * while progress mode is on, that the solid colour is the part currently reachable and the dotted
 * trace is the general route. A line with nothing to place keeps only that route trace.
 * What the reader can
 * already see, they are not told: which lines are drawn, and how many, is the legend beneath, and
 * where the reading came from is the page's provenance footer.
 */
const getZentrumSchematicCaption = (
  selectedLineId: string | undefined,
  vehicleCount: number,
  showVehicleProgress: boolean,
): string =>
  selectedLineId
    ? vehicleCount === 0
      ? `Linie ${selectedLineId} · derzeit keine Bahn unterwegs${showVehicleProgress ? " · gepunktet = Linienweg" : ""}`
      : `Linie ${selectedLineId} · ${formatCount(vehicleCount, "Bahn", "Bahnen")}${showVehicleProgress ? " · farbig = jetzt möglich" : " · ganzer Linienweg farbig"}`
    : `${formatCount(
        vehicleCount,
        "Bahn unterwegs · Position geschätzt",
        "Bahnen unterwegs · Positionen geschätzt",
      )}${showVehicleProgress ? " · farbig = jetzt möglich · gepunktet = Linienweg" : ""}`;

/**
 * The Zentrum's plan as it is read: the drawing, what it says of itself, and the controls under it.
 *
 * Three readings of one drawing, in the order a reader meets them — the plan and the marks moving
 * over it, the caption that says what those marks are worth, and the band that follows a line or
 * changes the size the plan is read at. The two choices are kept apart: the line being followed is
 * a level of the address and rides in from above, while the vehicle a reader opened and the zoom
 * they are reading at are this reading's own and live here.
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
  vehicles,
  isFullscreen,
  onSelectLine,
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
  vehicles: readonly ZentrumSchematicVehicle[];
  /** Whether the plan is being read at the size of the screen. */
  isFullscreen: boolean;
  onSelectLine: (lineId: string | undefined) => void;
  onChangeFullscreen: (isFullscreen: boolean) => void;
}) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>();
  const [selectedStationId, setSelectedStationId] = useState<string>();
  const [showVehicleProgress, setShowVehicleProgress] = useState(false);
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
  const followedVehicleCount = selectedLineId
    ? vehicles.filter((vehicle) => vehicle.lineId === selectedLineId).length
    : vehicles.length;

  // Following another line is following another path, and the vehicle that was open was on the old
  // one.
  const selectLine = (lineId: string | undefined) => {
    setSelectedVehicleId(undefined);
    setSelectedStationId(undefined);
    onSelectLine(lineId);
  };

  const selectStation = (stationId: string) => {
    setSelectedVehicleId(undefined);
    setSelectedStationId((current) => (current === stationId ? undefined : stationId));
    // A station focus is a map-level selection, so it replaces a line followed in the address.
    if (selectedLineId !== undefined) onSelectLine(undefined);
  };

  return (
    <section
      className="zentrum-schematic"
      data-following={selectedLineId !== undefined}
      data-fullscreen={isFullscreen}
      aria-label="Schematischer Linienplan des Zentrums"
    >
      {/* The drawing and everything that reads *of* the drawing: the caption at its foot and the
          vehicle a reader opened. Both stand over the plan rather than under it, so opening a
          vehicle no longer pushes the controls below the fold. */}
      <div className="zentrum-schematic-stage">
        <ZentrumSchematicCanvas
          edges={edges}
          linePaths={linePaths}
          trackWidth={trackWidth}
          boardingPlacesByNodeId={boardingPlacesByNodeId}
          lineIdsByNodeId={lineIdsByNodeId}
          getSign={getSign}
          selectedLineId={selectedLineId}
          selectedStationId={selectedStationId}
          vehicles={vehicles}
          showVehicleProgress={showVehicleProgress}
          selectedVehicleId={selectedVehicleId}
          onSelectVehicle={(vehicleId) =>
            setSelectedVehicleId((current) => (current === vehicleId ? undefined : vehicleId))
          }
          onSelectStation={selectStation}
          scrollRef={plan.scrollRef}
          zoom={plan.zoom}
          planWidth={plan.planWidth}
        />
        {selectedVehicle && (
          <ZentrumVehicleDetail
            vehicle={selectedVehicle}
            getSign={getSign}
            onClose={() => setSelectedVehicleId(undefined)}
          />
        )}
      </div>

      <ZentrumSchematicToolbar
        caption={getZentrumSchematicCaption(
          selectedLineId,
          followedVehicleCount,
          showVehicleProgress,
        )}
        lineIds={lineIds}
        getSign={getSign}
        selectedLineId={selectedLineId}
        onSelectLine={selectLine}
        showVehicleProgress={showVehicleProgress}
        onChangeVehicleProgress={setShowVehicleProgress}
        zoom={plan.zoom}
        canZoomIn={plan.canZoomIn}
        canZoomOut={plan.canZoomOut}
        onChangeZoom={plan.changeZoom}
        isFullscreen={isFullscreen}
        onChangeFullscreen={onChangeFullscreen}
      />
    </section>
  );
}
