import { useCallback, useEffect, useMemo, useState } from "react";
import type { DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useDepartureBoard } from "../../hooks/departure-board";
import { useZentrumVehicles } from "../../hooks/zentrum-vehicles";
import { compareLineIds } from "../../lib/line-families";
import type { ObservedNetwork } from "../../lib/observed-network";
import { createRunMotions } from "../../lib/vehicle-positioning";
import {
  buildZentrumSchematicReading,
  getZentrumSchematicVehicles,
} from "../../lib/zentrum-schematic";
import { navigateTo, replaceCurrentRoute, routePaths } from "../../routing";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { createZentrumLineSignReader } from "./line-sign";
import { ZentrumSchematic } from "./ZentrumSchematic";

/**
 * The page's name, said to a reader who cannot see the drawing.
 *
 * Printed it was a band across the top of every screen restating the tab that was pressed to get
 * here, over a drawing that is the whole point of the page — so the plan takes that room and the
 * name is spoken instead. A page still needs one, and a screen reader listing the headings of this
 * app should not find the one page with a drawing on it unnamed.
 */
const ZENTRUM_PAGE_NAME = <h1 className="visually-hidden">Zentrum live</h1>;

/** What the page says while the observation has placed nothing on the plan yet. */
const zentrumEmptyLabels = {
  loading: "Haltestellen werden geladen …",
  unavailable: "Zentrum derzeit nicht abrufbar",
  empty: "Derzeit keine Fahrten beobachtet",
};

/**
 * The Zentrum's plan: one drawing of what is running through it.
 *
 * One drawing, not four readings of one. Following a line is a *selection* on it — the rest of the
 * band recedes and the followed line's stretches light up in front of its vehicles — rather than a
 * mode that swaps the drawing out from under the reader and drops what they had chosen. The
 * reading's coverage is stated by the page's provenance footer, because that is what it is a
 * statement about. What is left on this page is the drawing, and the drawing has the panel — or, at
 * the reader's word, the screen.
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
  /** The trips that state which schematic corridors are in service. */
  departureBoards: readonly DepartureBoard[];
  /** The line the plan is following, as the address names it. */
  selectedLineId?: string;
  /** The stop the plan is read from, as the address names it. */
  selectedStopId?: string;
  /** Whether the plan is being read at the size of the screen, as the address names it. */
  isFullscreen: boolean;
}) {
  // What is running through the Zentrum, on the two clocks that place it: the posts name the runs,
  // and each run's own reading says where it is by now. The set is the drawn runs — board rows and
  // retained readings alike, however the runs came to be named — and it changes only when a run is
  // picked up or lets go, not when a post's board is re-fetched.
  const { runDepartures, feedNow } = useZentrumVehicles(departureBoards);
  // The drawing reads the same runs the marks are placed from, so a line holds its corridors while
  // any run the plan is drawing still states them: a board refresh that only swapped rows draws
  // the same plan again, and a line the boards have stopped naming does not take its lanes down
  // under a mark still travelling on them.
  const schematic = useMemo(() => buildZentrumSchematicReading(runDepartures), [runDepartures]);
  // Every mark rides the lane its line is drawn in, because every line is drawn in a lane.
  // The plan's own memory of how its marks are moving, kept for as long as the plan is mounted.
  const [motions] = useState(createRunMotions);
  const vehicles = getZentrumSchematicVehicles(schematic, runDepartures, feedNow, motions);
  // The feed states each line's mode, and the badge needs it for the lines that have no verified sign.
  const getSign = useMemo(() => createZentrumLineSignReader(network.lines), [network.lines]);
  const schematicLineIds = useMemo(
    () => [...new Set(schematic.edges.flatMap((edge) => edge.lineIds))].sort(compareLineIds),
    [schematic.edges],
  );
  // A line that has stopped running leaves the address by itself, exactly as a stop or a trip does
  // — but never before the reading that could name it has answered, which is what the plan having
  // corridors at all says. The reading names a line while any run the plan draws still states it,
  // so a line the boards have stopped listing is followed for exactly as long as its mark is.
  // An opened stop leaves the same way, once nothing the plan draws calls there any more.
  const isLineObserved = selectedLineId === undefined || schematicLineIds.includes(selectedLineId);
  const isStopObserved =
    selectedStopId === undefined || schematic.lineIdsByNodeId.has(selectedStopId);
  const isReadingAnswered = schematicLineIds.length > 0;
  useEffect(() => {
    if ((!isLineObserved || !isStopObserved) && isReadingAnswered) {
      replaceCurrentRoute(routePaths.zentrum({}, isFullscreen));
    }
  }, [isLineObserved, isStopObserved, isReadingAnswered, isFullscreen]);
  const followedLineId = isLineObserved ? selectedLineId : undefined;
  const openedStopId = isStopObserved ? selectedStopId : undefined;
  // An opened stop reads its own board, the one its stop page shows: the plan only draws the trams
  // already inside it, and a rider at the stop is asking about every one that will leave.
  const { board: openedStopBoard } = useDepartureBoard(openedStopId);
  // The plan re-renders every second to move its marks; the Escape key that leaves the full-screen
  // reading listens for as long as that reading is up, and must not be re-subscribed under it.
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
        edges={schematic.edges}
        linePaths={schematic.linePaths}
        trackWidth={schematic.trackWidth}
        boardingPlacesByNodeId={schematic.boardingPlacesByNodeId}
        lineIdsByNodeId={schematic.lineIdsByNodeId}
        lineIds={schematicLineIds}
        getSign={getSign}
        selectedLineId={followedLineId}
        selectedStopId={openedStopId}
        vehicles={vehicles}
        runDepartures={runDepartures}
        stopBoard={openedStopBoard}
        feedNow={feedNow}
        isFullscreen={isFullscreen}
        /* Following a line, or opening a stop, is navigating to it: the reading a rider arrives at
           is the reading they can share, and the back button is what closes it. The size the plan
           is being read at rides along — choosing is not a decision to stop reading it big. */
        onSelectLine={(lineId) => navigateTo(routePaths.zentrum({ lineId }, isFullscreen))}
        onSelectStop={(stopId) => navigateTo(routePaths.zentrum({ stopId }, isFullscreen))}
        onChangeFullscreen={changeFullscreen}
      />
    </>
  );
}
