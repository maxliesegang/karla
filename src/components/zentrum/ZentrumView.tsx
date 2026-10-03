import { useCallback, useEffect, useMemo, useState } from "react";
import type { DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useDepartureBoard } from "../../hooks/departure-board";
import { useZentrumVehicles } from "../../hooks/zentrum-vehicles";
import type { ObservedNetwork } from "../../lib/observed-network";
import { createZentrumSchematicReader } from "../../lib/zentrum-schematic";
import { navigateTo, replaceCurrentRoute, routePaths } from "../../routing";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { createZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematic } from "./ZentrumSchematic";

/** The page's name, for screen readers: printed, it would take room from the drawing. */
const ZENTRUM_PAGE_NAME = <h1 className="visually-hidden">Zentrum live</h1>;

/** What the page says while the observation has placed nothing on the plan yet. */
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
}: {
  network: ObservedNetwork;
  /** How many of the Zentrum's observation posts this reading rests on. */
  coverage: DepartureBoardCoverage;
  /** The trips that state which corridors are in service. */
  departureBoards: readonly DepartureBoard[];
  /** The followed line, as the address names it. */
  selectedLineId?: string;
  /** The opened stop, as the address names it. */
  selectedStopId?: string;
  /** Whether the plan fills the screen, as the address says. */
  isFullscreen: boolean;
}) {
  // The posts name the runs, each run's own reading places it. The set changes only when a run is
  // picked up or lets go, not on every board refetch.
  const { runDepartures, feedNow } = useZentrumVehicles(departureBoards);
  // The drawing reads the same runs the marks are placed from, so a line keeps its lanes while any
  // of its marks is still on them. The reader keeps the last layout between refreshes.
  const [readSchematic] = useState(createZentrumSchematicReader);
  const layout = useMemo(() => readSchematic(runDepartures), [readSchematic, runDepartures]);
  // The feed's mode signs the lines that have no verified sign.
  const getSign = useMemo(() => createZentrumLineSignReader(network.lines), [network.lines]);
  // A followed line or opened stop leaves the address once nothing drawn names it, but not before
  // the reading has answered at all.
  const isLineObserved = selectedLineId === undefined || layout.lineIds.includes(selectedLineId);
  const isStopObserved = selectedStopId === undefined || layout.lineIdsByNodeId.has(selectedStopId);
  const isReadingAnswered = layout.lineIds.length > 0;
  useEffect(() => {
    if ((!isLineObserved || !isStopObserved) && isReadingAnswered) {
      replaceCurrentRoute(routePaths.zentrum({}, isFullscreen));
    }
  }, [isLineObserved, isStopObserved, isReadingAnswered, isFullscreen]);
  const followedLineId = isLineObserved ? selectedLineId : undefined;
  const openedStopId = isStopObserved ? selectedStopId : undefined;
  // An opened stop reads its own whole board: the plan only draws the trams already inside it.
  const { board: openedStopBoard } = useDepartureBoard(openedStopId);
  // Choosing is navigating, so a reading can be shared and closed with back; full screen rides
  // along. Stable, so the memoized stops do not re-render every second.
  const selectLine = useCallback(
    (lineId: string | undefined) => navigateTo(routePaths.zentrum({ lineId }, isFullscreen)),
    [isFullscreen],
  );
  const selectStop = useCallback(
    (stopId: string | undefined) => navigateTo(routePaths.zentrum({ stopId }, isFullscreen)),
    [isFullscreen],
  );
  // Stable, so the Escape listener is not re-subscribed on every per-second render.
  const changeFullscreen = useCallback(
    (next: boolean) =>
      navigateTo(routePaths.zentrum({ lineId: followedLineId, stopId: openedStopId }, next)),
    [followedLineId, openedStopId],
  );
  if (network.stops.length === 0) {
    return (
      <>
        {ZENTRUM_PAGE_NAME}
        <ObservationEmptyState coverage={coverage} labels={zentrumEmptyLabels} />
      </>
    );
  }

  return (
    <>
      {ZENTRUM_PAGE_NAME}
      <ZentrumSchematic
        layout={layout}
        getSign={getSign}
        selectedLineId={followedLineId}
        selectedStopId={openedStopId}
        runDepartures={runDepartures}
        stopBoard={openedStopBoard}
        feedNow={feedNow}
        isFullscreen={isFullscreen}
        onSelectLine={selectLine}
        onSelectStop={selectStop}
        onChangeFullscreen={changeFullscreen}
      />
    </>
  );
}
