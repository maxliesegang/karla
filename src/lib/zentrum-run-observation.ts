import type { Departure, DepartureBoard } from "../data/transit-types";
import { getDistinctRuns } from "./trips";
import { isRailDeparture } from "./zentrum-schematic-plan";

/**
 * The vehicles the Zentrum's observation posts can place. Every line's, always: following a line
 * recedes the others rather than fetching only its own.
 */
export type ZentrumRunObservation = {
  /** One row per run, whichever post read it. */
  runDepartures: readonly Departure[];
  /** The freshest post: the clock the marks move against. */
  clockBoard: DepartureBoard | null;
};

const isDrawableRun = (departure: Departure): boolean =>
  Boolean(departure.tripCalls?.length) && isRailDeparture(departure);

/** What the posts' current boards say is out on the Zentrum's corridors. */
export function getZentrumRunObservation(
  departureBoards: readonly DepartureBoard[],
): ZentrumRunObservation {
  const boards = departureBoards.filter((board) => board.dataStatus === "live");
  const runDepartures = getDistinctRuns(
    boards.flatMap((board) => board.departures).filter(isDrawableRun),
  );
  const clockBoard = boards.reduce<DepartureBoard | null>(
    (newest, board) => (!newest || board.receivedAt > newest.receivedAt ? board : newest),
    null,
  );
  return { runDepartures, clockBoard };
}
