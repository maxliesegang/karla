import { getZentrumSchematicLineIdsByStopId } from "../../lib/zentrum-schematic-plan";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Departure, DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useDepartureBoard } from "../../hooks/departure-board";
import type { NearbyStopsController } from "../../hooks/nearby-stops";
import { useSteadyValue } from "../../hooks/steady-value";
import { useNearestZentrumStopOpening } from "../../hooks/zentrum-nearest-stop";
import { useZentrumVehicles } from "../../hooks/zentrum-vehicles";
import type { ObservedNetwork } from "../../lib/observed-network";
import { createZentrumSchematicReader } from "../../lib/zentrum-schematic";
import { navigateTo, replaceCurrentRoute, routePaths } from "../../routing";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { createZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematic } from "./ZentrumSchematic";

/** How long a changed plan waits for further changes, and how often it may change at most. */
const ZENTRUM_LAYOUT_PACE = { settleMs: 1_500, intervalMs: 15_000 };

/** The page heading for screen readers. */
const zentrumPageHeading = <h1 className="visually-hidden">Experimente: Zentrum-Plan</h1>;

/** Shown while nothing is on the plan yet. */
const zentrumEmptyLabels = {
  loading: "Linien und Fahrten werden geladen …",
  unavailable: "Zentrum derzeit nicht abrufbar",
  empty: "Derzeit keine Fahrten beobachtet",
};

type ZentrumViewProps = {
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
};

/** Lines appear first; vehicles wait for the initial readings and layout. */
export function ZentrumView(props: ZentrumViewProps) {
  const { network, coverage, departureBoards, selectedStopId } = props;
  const { board: openedStopBoard } = useDepartureBoard(selectedStopId);
  const evidenceBoards = useMemo(
    () => (openedStopBoard ? [...departureBoards, openedStopBoard] : departureBoards),
    [departureBoards, openedStopBoard],
  );
  const { runDepartures, feedNow, isLoading } = useZentrumVehicles(evidenceBoards);
  const isInitialLoading = coverage.status === "loading" || isLoading;
  if (network.stops.length === 0 && !isInitialLoading) {
    return (
      <>
        {zentrumPageHeading}
        <ObservationEmptyState coverage={coverage} labels={zentrumEmptyLabels} />
      </>
    );
  }
  return (
    <ZentrumPlan
      {...props}
      runDepartures={runDepartures}
      feedNow={feedNow}
      openedStopBoard={openedStopBoard}
      isInitialLoading={isInitialLoading}
    />
  );
}

/** The first vehicles wait for the settled layout; later readings keep them visible. */
function ZentrumPlan({
  network,
  selectedLineId,
  selectedStopId,
  isFullscreen,
  isStacked,
  nearbyStops,
  runDepartures,
  feedNow,
  openedStopBoard,
  isInitialLoading,
}: ZentrumViewProps & {
  runDepartures: readonly Departure[];
  feedNow: number;
  openedStopBoard: DepartureBoard | null;
  isInitialLoading: boolean;
}) {
  const [hasLoaded, setHasLoaded] = useState(false);
  const [readSchematic] = useState(createZentrumSchematicReader);
  const readLayout = useMemo(() => readSchematic(runDepartures), [readSchematic, runDepartures]);
  const layout = useSteadyValue(readLayout, readLayout.layoutKey, {
    ...ZENTRUM_LAYOUT_PACE,
    intervalMs: hasLoaded ? ZENTRUM_LAYOUT_PACE.intervalMs : 0,
  });
  const isLoading = !hasLoaded && (isInitialLoading || layout.layoutKey !== readLayout.layoutKey);
  if (!hasLoaded && !isLoading) setHasLoaded(true);
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
  const isReadingAnswered = !isLoading && layout.lineIds.length > 0;
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
    isLoading ? new Map() : lineIdsByStopId,
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
        isLoading={isLoading}
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
