import type { Departure, DepartureBoard } from "../data/transit-types";
import { ZENTRUM_OBSERVATION_POST_STOP_IDS } from "./observed-network";
import { getDistinctRuns } from "./trips";

/**
 * The vehicles the Zentrum's observation posts can place, read off the posts' own boards.
 *
 * Every vehicle, whichever line it is on: following a line picks one out of the plan, and a plan
 * that emptied of marks until a line was chosen would be answering a question nobody asked. The
 * choice recedes the marks, it does not fetch them.
 */
export type ZentrumRunObservation = {
  /** One row per run, whichever of the posts read it, dated by the post that read it. */
  runDepartures: readonly Departure[];
  /** The freshest post, which is the clock the marks are moved against. */
  clockBoard: DepartureBoard | null;
};

const ZENTRUM_POST_STOP_IDS: ReadonlySet<string> = new Set(ZENTRUM_OBSERVATION_POST_STOP_IDS);

/** Only rail is drawn: the plan is a rail plan, and a bus has no corridor on it to ride. */
const isDrawableRun = (departure: Departure): boolean =>
  Boolean(departure.tripCalls?.length) &&
  (departure.transportMode === "tram" || departure.transportMode === "lightRail");

/** What the posts' current boards say is out on the Zentrum's corridors. */
export function getZentrumRunObservation(
  departureBoards: readonly DepartureBoard[],
): ZentrumRunObservation {
  const boards = departureBoards.filter(
    (board) => board.dataStatus === "live" && ZENTRUM_POST_STOP_IDS.has(board.stopId),
  );
  const runDepartures = getDistinctRuns(
    boards.flatMap((board) => board.departures).filter(isDrawableRun),
  );
  const clockBoard = boards.reduce<DepartureBoard | null>(
    (newest, board) => (!newest || board.receivedAt > newest.receivedAt ? board : newest),
    null,
  );
  return { runDepartures, clockBoard };
}
