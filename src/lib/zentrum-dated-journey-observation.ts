import type { StopEvent, StopEventBoard } from "../data/transit-types";
import { getDistinctDatedJourneys } from "./journeys";
import { isRailStopEvent } from "./zentrum-schematic-plan";

/**
 * The vehicles the Zentrum's observation posts can place. Every line's, always: following a line
 * recedes the others rather than fetching only its own.
 */
export type ZentrumDatedJourneyObservation = {
  /** One row per dated journey, whichever post read it. */
  datedJourneyStopEvents: readonly StopEvent[];
  /** The freshest post: the clock the marks move against. */
  clockBoard: StopEventBoard | null;
};

const isDrawableDatedJourney = (stopEvent: StopEvent): boolean =>
  Boolean(stopEvent.calls?.length) && isRailStopEvent(stopEvent);

/** What the posts' current boards say is out on the Zentrum's corridors. */
export function getZentrumDatedJourneyObservation(
  stopEventBoards: readonly StopEventBoard[],
): ZentrumDatedJourneyObservation {
  const boards = stopEventBoards.filter((board) => board.dataStatus === "live");
  const datedJourneyStopEvents = getDistinctDatedJourneys(
    boards.flatMap((board) => board.stopEvents).filter(isDrawableDatedJourney),
  );
  const clockBoard = boards.reduce<StopEventBoard | null>(
    (newest, board) => (!newest || board.receivedAt > newest.receivedAt ? board : newest),
    null,
  );
  return { datedJourneyStopEvents, clockBoard };
}
