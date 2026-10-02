import { useMemo } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
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
