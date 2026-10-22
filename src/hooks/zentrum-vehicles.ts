import { useMemo } from "react";
import type { StopEvent, StopEventBoard } from "../data/transit-types";
import { runsEveryDay } from "../lib/daily-lines";
import { getZentrumDatedJourneyObservation } from "../lib/zentrum-dated-journey-observation";
import { useLineDatedJourneyStopEvents } from "./line-dated-journey-stop-events";
import { useDatedJourneyDiscovery } from "./dated-journey-discovery";
import { zentrumStopIds } from "../data/zentrum-stops";
import { isDatedJourneyInArea } from "../lib/dated-journey-discovery";
import { getDistinctDatedJourneys } from "../lib/journeys";
import { STOP_EVENT_BOARD_REFRESH_MS } from "./stop-event-board";

const areaStops = new Set(zentrumStopIds);
const includesZentrumDatedJourney = (datedJourney: StopEvent, feedNow: number) =>
  isDatedJourneyInArea(datedJourney, feedNow, areaStops);

/** One retention for the whole Zentrum, so following a line keeps what was observed of the others. */
const ZENTRUM_VEHICLE_RETENTION_KEY = "zentrum";

export type ZentrumDatedJourneyReading = {
  /** The dated journeys to draw. */
  datedJourneyStopEvents: readonly StopEvent[];
  /**
   * The drawn dated journeys and every other dated journey the posts name, including those not near
   * the plan yet.
   */
  travelDatedJourneys: readonly StopEvent[];
  feedNow: number;
};

/** Discover area exits and termini, then place each dated journey from its shared reading. */
export function useZentrumVehicles(
  stopEventBoards: readonly StopEventBoard[],
  { scopeToArea = true, animatesVehicles = true } = {},
): ZentrumDatedJourneyReading & { isLoading: boolean } {
  const observation = useMemo(
    () => getZentrumDatedJourneyObservation(stopEventBoards),
    [stopEventBoards],
  );
  const discovery = useDatedJourneyDiscovery(zentrumStopIds, stopEventBoards);
  const datedJourneys = useMemo(
    () =>
      getDistinctDatedJourneys([
        ...observation.datedJourneyStopEvents,
        ...(discovery?.datedJourneyStopEvents ?? []),
      ]),
    [observation.datedJourneyStopEvents, discovery?.datedJourneyStopEvents],
  );
  const clockBoard =
    discovery?.clockBoard &&
    (!observation.clockBoard || discovery.clockBoard.receivedAt > observation.clockBoard.receivedAt)
      ? discovery.clockBoard
      : observation.clockBoard;
  const reading = useLineDatedJourneyStopEvents(
    ZENTRUM_VEHICLE_RETENTION_KEY,
    datedJourneys,
    clockBoard,
    false,
    {
      includesDatedJourney: scopeToArea ? includesZentrumDatedJourney : undefined,
      refreshOnEntry: false,
      datedJourneyMaxAgeMs: animatesVehicles ? STOP_EVENT_BOARD_REFRESH_MS : undefined,
      animatesVehicles,
      readsBeforeMerges: animatesVehicles,
    },
  );
  const travelDatedJourneys = useMemo(
    () => getDistinctDatedJourneys([...reading.datedJourneyStopEvents, ...datedJourneys]),
    [reading.datedJourneyStopEvents, datedJourneys],
  );
  return { ...reading, travelDatedJourneys, isLoading: discovery === null };
}

/**
 * The Zentrum's dated journeys on lines that run every day: the network maps leave out the rest.
 */
export function useDailyZentrumVehicles(stopEventBoards: readonly StopEventBoard[]): {
  datedJourneyStopEvents: readonly StopEvent[];
  feedNow: number;
} {
  const { datedJourneyStopEvents, feedNow } = useZentrumVehicles(stopEventBoards, {
    scopeToArea: false,
    animatesVehicles: false,
  });
  const dailyDatedJourneys = useMemo(
    () => datedJourneyStopEvents.filter(({ lineId }) => runsEveryDay(lineId)),
    [datedJourneyStopEvents],
  );
  return { datedJourneyStopEvents: dailyDatedJourneys, feedNow };
}
