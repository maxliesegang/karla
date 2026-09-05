import type { Departure, DepartureBoard } from "../data/transit-types";
import { ZENTRUM_OBSERVATION_POST_STOP_IDS } from "./observed-network";
import { getDistinctVehicleTrips } from "./trips";

/**
 * The vehicles the Zentrum's observation posts can place, read off the posts' own boards.
 *
 * Every vehicle, whichever line it is on: following a line picks one out of the plan, and a plan
 * that emptied of marks until a line was chosen would be answering a question nobody asked. The
 * choice recedes the marks, it does not fetch them.
 */
export type ZentrumVehicleObservation = {
  /** One departure per vehicle, whichever of the posts read it. */
  departures: readonly Departure[];
  /**
   * When each row was read, keyed by the row rather than by the object: these departures are
   * re-read as whole trips, and a completed row is a new object that has to stamp with the age of
   * the board its row came off all the same.
   */
  observedAtByRowId: ReadonlyMap<string, number>;
  /** The freshest post, which is the clock the marks are moved against. */
  clockBoard: DepartureBoard | null;
};

const ZENTRUM_POST_STOP_IDS: ReadonlySet<string> = new Set(ZENTRUM_OBSERVATION_POST_STOP_IDS);

/** Only rail is drawn: the plan is a rail plan, and a bus has no corridor on it to ride. */
const isDrawnVehicle = (departure: Departure): boolean =>
  Boolean(departure.tripCalls?.length) &&
  (departure.transportMode === "tram" || departure.transportMode === "lightRail");

/** What the posts' current boards say is out on the Zentrum's corridors. */
export function getZentrumVehicleObservation(
  departureBoards: readonly DepartureBoard[],
): ZentrumVehicleObservation {
  const boards = departureBoards.filter(
    (board) => board.dataStatus === "live" && ZENTRUM_POST_STOP_IDS.has(board.stopId),
  );
  const observedAtByRowId = new Map(
    boards.flatMap((board) =>
      board.departures.map((departure): [string, number] => [departure.id, board.receivedAt]),
    ),
  );
  const departures = getDistinctVehicleTrips(
    boards.flatMap((board) => board.departures).filter(isDrawnVehicle),
    (departure) => observedAtByRowId.get(departure.id) ?? 0,
  );
  const clockBoard = boards.reduce<DepartureBoard | null>(
    (newest, board) => (!newest || board.receivedAt > newest.receivedAt ? board : newest),
    null,
  );
  return { departures, observedAtByRowId, clockBoard };
}
