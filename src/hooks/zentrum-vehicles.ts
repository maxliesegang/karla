import { useMemo } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import { getZentrumRunObservation } from "../lib/zentrum-run-observation";
import { useLineRunDepartures } from "./line-run-departures";

/** The retention these vehicles accumulate under: the Zentrum, not any one line running through it. */
const ZENTRUM_VEHICLE_RETENTION_KEY = "zentrum";

/**
 * The vehicles the Zentrum's plan draws, on the two clocks that place them.
 *
 * The observation posts name which runs are out there, on their own slow cadence. The marks are
 * placed from the runs' own readings, which `useLineRunDepartures` re-reads for every run it
 * follows, so the feed's revision of where a vehicle is reaches the plan within a minute, between
 * two boards that are minutes apart.
 *
 * One retention for the whole Zentrum rather than one per line, so following a line does not throw
 * away what has been observed of the others and re-learn it on the next refresh.
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
