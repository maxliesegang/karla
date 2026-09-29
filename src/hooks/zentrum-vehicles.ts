import { useMemo } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import { mergeRunSequences } from "../lib/trip-calls";
import { getZentrumRunObservation } from "../lib/zentrum-run-observation";
import { useLineRunDepartures } from "./line-run-departures";
import { useRunReadings } from "./run-reading-loader";

/** The retention these vehicles accumulate under: the Zentrum, not any one line running through it. */
const ZENTRUM_VEHICLE_RETENTION_KEY = "zentrum";

/**
 * The vehicles the Zentrum's plan draws, on the two clocks that place them.
 *
 * The observation posts name which runs are out there, on their own slow cadence. The marks
 * themselves are placed from the runs' own readings: every visible run is re-read at the line trip
 * tolerance — no run is chosen here, so none reads faster than the others — and the feed's revision
 * of where a vehicle is reaches the plan within a minute, between two boards that are minutes
 * apart. A row that no reading has answered yet stands as its board stated it, and a reading that
 * failed is not evidence that the run is gone.
 *
 * One retention for the whole Zentrum rather than one per line, so following a line does not throw
 * away what has been observed of the others and re-learn it on the next refresh.
 */
export function useZentrumVehicles(departureBoards: readonly DepartureBoard[]): {
  runDepartures: readonly Departure[];
  feedNow: number;
} {
  const observation = useMemo(() => getZentrumRunObservation(departureBoards), [departureBoards]);
  // Only the runs actually drawn are read, so a plan with no vehicles on it asks for nothing. Here
  // the run's own reading is much the fresher of the two — five minutes against one — and a mark
  // placed as though the post's row were fresher was hauled back to the post it had left and held
  // there until the stale prediction elapsed. Each merged departure states both clocks, so the
  // placement reads which half is the later evidence off the departure itself.
  const runReadings = useRunReadings(observation.runDepartures);
  const observedRuns = useMemo(
    () => mergeRunSequences(observation.runDepartures, runReadings),
    [observation.runDepartures, runReadings],
  );
  return useLineRunDepartures(
    ZENTRUM_VEHICLE_RETENTION_KEY,
    observedRuns,
    observation.clockBoard,
    false,
  );
}
