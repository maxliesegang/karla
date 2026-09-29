import { useCallback, useEffect, useMemo, useState } from "react";
import type { DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useZentrumVehicles } from "../../hooks";
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

/**
 * The one line the page says of itself before its drawing: the plan is still being built. It rides
 * both of the page's states, because it is a statement about the page and not about its reading —
 * and it leaves the page again the day the plan is done, like everything else that was only ever
 * honest about the one thing it named.
 */
const ZENTRUM_WORK_IN_PROGRESS = (
  <p className="zentrum-view-progress">
    <strong>In Arbeit</strong> — der Zentrumsliveplan wird gerade noch gebaut.
  </p>
);

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
 * the reader's word, the screen. Above it stands the one line that says the plan is still being
 * built; it is the page's own statement, and the drawing keeps everything under it.
 */
export function ZentrumView({
  network,
  coverage,
  departureBoards,
  selectedLineId,
  isFullscreen,
}: {
  network: ObservedNetwork;
  /** How many of the Zentrum's observation posts this reading rests on. */
  coverage: DepartureBoardCoverage;
  /** The trips that state which schematic corridors are in service. */
  departureBoards: readonly DepartureBoard[];
  /** The line the plan is following, as the address names it. */
  selectedLineId?: string;
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
  const isLineObserved = selectedLineId === undefined || schematicLineIds.includes(selectedLineId);
  useEffect(() => {
    if (!isLineObserved && schematicLineIds.length > 0) {
      replaceCurrentRoute(routePaths.zentrum(undefined, isFullscreen));
    }
  }, [isLineObserved, schematicLineIds.length, isFullscreen]);
  const followedLineId = isLineObserved ? selectedLineId : undefined;
  // The plan re-renders every second to move its marks; the Escape key that leaves the full-screen
  // reading listens for as long as that reading is up, and must not be re-subscribed under it.
  const changeFullscreen = useCallback(
    (next: boolean) => navigateTo(routePaths.zentrum(followedLineId, next)),
    [followedLineId],
  );
  if (network.stops.length === 0) {
    return (
      <>
        {ZENTRUM_PAGE_NAME}
        {ZENTRUM_WORK_IN_PROGRESS}
        <ObservationEmptyState coverage={coverage} labels={zentrumEmptyLabels} />
      </>
    );
  }

  return (
    <>
      {ZENTRUM_PAGE_NAME}
      {ZENTRUM_WORK_IN_PROGRESS}
      <ZentrumSchematic
        edges={schematic.edges}
        linePaths={schematic.linePaths}
        trackWidth={schematic.trackWidth}
        boardingPlacesByNodeId={schematic.boardingPlacesByNodeId}
        lineIdsByNodeId={schematic.lineIdsByNodeId}
        lineIds={schematicLineIds}
        getSign={getSign}
        selectedLineId={followedLineId}
        vehicles={vehicles}
        isFullscreen={isFullscreen}
        /* Following a line is navigating to it: the reading a rider arrives at is the reading
           they can share, and the back button is what stops following. The size the plan is being
           read at rides along — following a line is not a decision to stop reading it big. */
        onSelectLine={(lineId) => navigateTo(routePaths.zentrum(lineId, isFullscreen))}
        onChangeFullscreen={changeFullscreen}
      />
    </>
  );
}
