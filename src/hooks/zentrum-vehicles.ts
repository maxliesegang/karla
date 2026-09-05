import { useCallback, useMemo } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import { mergeTripSequences } from "../lib/trip-calls";
import { getZentrumVehicleObservation } from "../lib/zentrum-vehicles";
import { useLineVehicleDepartures } from "./line-vehicle-departures";
import { useTripDepartures } from "./trip-departures";

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
  vehicleDepartures: readonly Departure[];
  feedNow: number;
} {
  const observation = useMemo(
    () => getZentrumVehicleObservation(departureBoards),
    [departureBoards],
  );
  // Only the runs actually drawn are read, so a plan with no vehicles on it asks for nothing.
  const tripReadings = useTripDepartures(observation.departures);
  const observedTrips = useMemo(
    () => mergeTripSequences(observation.departures, tripReadings),
    [observation.departures, tripReadings],
  );
  const observedAt = useCallback(
    (departure: Departure) => observation.observedAtByRowId.get(departure.id) ?? 0,
    [observation.observedAtByRowId],
  );
  return useLineVehicleDepartures(
    ZENTRUM_VEHICLE_RETENTION_KEY,
    observedTrips,
    observedAt,
    observation.clockBoard,
    false,
  );
}
