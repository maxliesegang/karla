import { useMemo } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import { runsEveryDay } from "../lib/daily-lines";
import { getZentrumRunObservation } from "../lib/zentrum-run-observation";
import { useLineRunDepartures } from "./line-run-departures";
import { useRunDiscovery } from "./run-discovery";
import { zentrumStopIds } from "../data/zentrum-stops";
import { isRunInArea } from "../lib/run-discovery";
import { getDistinctRuns } from "../lib/trips";

const areaStops = new Set(zentrumStopIds);
const includesZentrumRun = (run: Departure, feedNow: number) =>
  isRunInArea(run, feedNow, areaStops);

/** One retention for the whole Zentrum, so following a line keeps what was observed of the others. */
const ZENTRUM_VEHICLE_RETENTION_KEY = "zentrum";

/** Discover area exits and termini, then place each run from its shared reading. */
export function useZentrumVehicles(
  departureBoards: readonly DepartureBoard[],
  scopeToArea = true,
): {
  runDepartures: readonly Departure[];
  feedNow: number;
  isLoading: boolean;
} {
  const observation = useMemo(() => getZentrumRunObservation(departureBoards), [departureBoards]);
  const discovery = useRunDiscovery(zentrumStopIds, departureBoards);
  const runs = useMemo(
    () => getDistinctRuns([...observation.runDepartures, ...(discovery?.runDepartures ?? [])]),
    [observation.runDepartures, discovery?.runDepartures],
  );
  const clockBoard =
    discovery?.clockBoard &&
    (!observation.clockBoard || discovery.clockBoard.receivedAt > observation.clockBoard.receivedAt)
      ? discovery.clockBoard
      : observation.clockBoard;
  const reading = useLineRunDepartures(ZENTRUM_VEHICLE_RETENTION_KEY, runs, clockBoard, false, {
    includesRun: scopeToArea ? includesZentrumRun : undefined,
    refreshOnEntry: false,
  });
  return { ...reading, isLoading: discovery === null };
}

/** The Zentrum's runs on lines that run every day: the network maps leave out the rest. */
export function useDailyZentrumVehicles(departureBoards: readonly DepartureBoard[]): {
  runDepartures: readonly Departure[];
  feedNow: number;
} {
  const { runDepartures, feedNow } = useZentrumVehicles(departureBoards, false);
  const dailyRuns = useMemo(
    () => runDepartures.filter(({ lineId }) => runsEveryDay(lineId)),
    [runDepartures],
  );
  return { runDepartures: dailyRuns, feedNow };
}
