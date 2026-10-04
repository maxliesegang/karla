import { useMemo } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import { runsEveryDay } from "../lib/daily-lines";
import { getZentrumRunObservation } from "../lib/zentrum-run-observation";
import { useLineRunDepartures } from "./line-run-departures";

/** One retention for the whole Zentrum, so following a line keeps what was observed of the others. */
const ZENTRUM_VEHICLE_RETENTION_KEY = "zentrum";

/**
 * The vehicles the Zentrum's plan draws. The posts' slow boards name the runs; each run's own
 * reading (`useLineRunDepartures`) says where it is, so a revised position arrives within a minute.
 */
export function useZentrumVehicles(departureBoards: readonly DepartureBoard[]): {
  runDepartures: readonly Departure[];
  feedNow: number;
} {
  const observation = useMemo(() => getZentrumRunObservation(departureBoards), [departureBoards]);
  return useLineRunDepartures(
    ZENTRUM_VEHICLE_RETENTION_KEY,
    observation.runDepartures,
    observation.clockBoard,
    false,
  );
}

/** The Zentrum's runs on lines that run every day: the network maps leave out the rest. */
export function useDailyZentrumVehicles(departureBoards: readonly DepartureBoard[]): {
  runDepartures: readonly Departure[];
  feedNow: number;
} {
  const { runDepartures, feedNow } = useZentrumVehicles(departureBoards);
  const dailyRuns = useMemo(
    () => runDepartures.filter(({ lineId }) => runsEveryDay(lineId)),
    [runDepartures],
  );
  return { runDepartures: dailyRuns, feedNow };
}
