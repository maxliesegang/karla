import { getZentrumSchematicLineIdsByStopId } from "../../lib/zentrum-schematic-plan";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useDepartureBoard } from "../../hooks/departure-board";
import type { NearbyStopsController } from "../../hooks/nearby-stops";
import { useNearestZentrumStopOpening } from "../../hooks/zentrum-nearest-stop";
import { useZentrumVehicles } from "../../hooks/zentrum-vehicles";
import type { ObservedNetwork } from "../../lib/observed-network";
import { createZentrumSchematicReader } from "../../lib/zentrum-schematic";
import { navigateTo, replaceCurrentRoute, routePaths } from "../../routing";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { createZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematic } from "./ZentrumSchematic";

/** The page heading for screen readers. */
const zentrumPageHeading = <h1 className="visually-hidden">Experimente: Zentrum-Plan</h1>;

/** Shown while nothing is on the plan yet. */
const zentrumEmptyLabels = {
  loading: "Haltestellen werden geladen …",
  unavailable: "Zentrum derzeit nicht abrufbar",
  empty: "Derzeit keine Fahrten beobachtet",
};

/**
 * The Zentrum's plan. Following a line is a selection on the one drawing (the rest recedes), not a
 * mode that swaps the drawing out.
 */
export function ZentrumView({
  network,
  coverage,
  departureBoards,
  selectedLineId,
  selectedStopId,
  isFullscreen,
  isStacked,
  nearbyStops,
}: {
  network: ObservedNetwork;
  /** How many observation posts this reading rests on. */
  coverage: DepartureBoardCoverage;
  /** The trips stating which corridors are in service. */
  departureBoards: readonly DepartureBoard[];
  /** The followed line, as the address names it. */
  selectedLineId?: string;
  /** The opened stop, as the address names it. */
  selectedStopId?: string;
  /** Whether the plan fills the screen. */
  isFullscreen: boolean;
  /** Whether an opened panel stands under the plan rather than beside it. */
  isStacked: boolean;
  /** Where the rider stands, asked only when the plan is set to open at the nearest stop. */
  nearbyStops: NearbyStopsController;
}) {
  const { board: openedStopBoard } = useDepartureBoard(selectedStopId);
  const evidenceBoards = useMemo(
    () => (openedStopBoard ? [...departureBoards, openedStopBoard] : departureBoards),
    [departureBoards, openedStopBoard],
  );
  // Runs named by the posts, placed from their own readings; the set changes only as runs come and
  // go.
  const { runDepartures, feedNow } = useZentrumVehicles(evidenceBoards);
  // The drawing reads the marks' runs, so a line keeps its lanes while any mark is on them. The
  // reader keeps the last layout.
  const [readSchematic] = useState(createZentrumSchematicReader);
  const layout = useMemo(() => readSchematic(runDepartures), [readSchematic, runDepartures]);
  // Mode-based signs for lines without a verified sign.
  const getSign = useMemo(() => createZentrumLineSignReader(network.lines), [network.lines]);
  // A followed line or opened stop leaves the address once nothing drawn names it, after the first
  // answer.
  const isLineObserved = selectedLineId === undefined || layout.lineIds.includes(selectedLineId);
  const lineIdsByStopId = useMemo(
    () => getZentrumSchematicLineIdsByStopId(layout.lineIdsByNodeId),
    [layout.lineIdsByNodeId],
  );
  const isStopObserved = selectedStopId === undefined || lineIdsByStopId.has(selectedStopId);
  const isReadingAnswered = layout.lineIds.length > 0;
  useEffect(() => {
    if ((!isLineObserved || !isStopObserved) && isReadingAnswered) {
      replaceCurrentRoute(routePaths.zentrum({}, isFullscreen));
    }
  }, [isLineObserved, isStopObserved, isReadingAnswered, isFullscreen]);
  const openNearestStop = useCallback(
    (stopId: string) => replaceCurrentRoute(routePaths.zentrum({ stopId }, isFullscreen)),
    [isFullscreen],
  );
  const locationNote = useNearestZentrumStopOpening(
    nearbyStops,
    lineIdsByStopId,
    selectedLineId !== undefined || selectedStopId !== undefined,
    openNearestStop,
  );
  const followedLineId = isLineObserved ? selectedLineId : undefined;
  const openedStopId = isStopObserved ? selectedStopId : undefined;
  // An opened stop reads its whole board; the plan only draws trams already inside it.
  // Choosing navigates, so readings can be shared and closed with back. Stable for memoized stops.
  const selectLine = useCallback(
    (lineId: string | undefined) => navigateTo(routePaths.zentrum({ lineId }, isFullscreen)),
    [isFullscreen],
  );
  const selectStop = useCallback(
    (stopId: string | undefined) => navigateTo(routePaths.zentrum({ stopId }, isFullscreen)),
    [isFullscreen],
  );
  // Stable, so the Escape listener is not re-subscribed every second.
  const changeFullscreen = useCallback(
    (next: boolean) =>
      navigateTo(routePaths.zentrum({ lineId: followedLineId, stopId: openedStopId }, next)),
    [followedLineId, openedStopId],
  );
  if (network.stops.length === 0) {
    return (
      <>
        {zentrumPageHeading}
        <ObservationEmptyState coverage={coverage} labels={zentrumEmptyLabels} />
      </>
    );
  }

  return (
    <>
      {zentrumPageHeading}
      <ZentrumSchematic
        layout={layout}
        getSign={getSign}
        selectedLineId={followedLineId}
        selectedStopId={openedStopId}
        runDepartures={runDepartures}
        stopBoard={openedStopBoard}
        feedNow={feedNow}
        isFullscreen={isFullscreen}
        isStacked={isStacked}
        locationNote={locationNote}
        onSelectLine={selectLine}
        onSelectStop={selectStop}
        onChangeFullscreen={changeFullscreen}
      />
    </>
  );
}
