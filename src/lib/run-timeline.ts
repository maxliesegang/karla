import type { TripCall } from "../data/transit-types";

export type TimedRunCall = { call: TripCall; arrival: number; departure: number };

/** Missing deviations inherit the nearest stated delay; expected calls never run backwards. */
export function getRunTimeline(calls: readonly TripCall[]): TimedRunCall[] {
  const scheduled = calls.flatMap((call) => {
    const arrival = Date.parse(call.scheduledArrivalTime ?? call.scheduledDepartureTime ?? "");
    const departure = Date.parse(call.scheduledDepartureTime ?? call.scheduledArrivalTime ?? "");
    if (!Number.isFinite(arrival) || !Number.isFinite(departure)) return [];
    const arrivalDelay = call.arrivalDelayMinutes ?? call.delayMinutes;
    const departureDelay = call.delayMinutes ?? call.arrivalDelayMinutes;
    return [{ call, arrival, departure, arrivalDelay, departureDelay }];
  });
  const firstStated = scheduled.findIndex((call) => call.departureDelay !== undefined);
  let carried = scheduled[firstStated]?.departureDelay ?? 0;
  let earliest = Number.NEGATIVE_INFINITY;
  return scheduled.map((entry, index) => {
    const arrivalDelay =
      entry.arrivalDelay ??
      (index < firstStated ? scheduled[firstStated].arrivalDelay : carried) ??
      0;
    const departureDelay = entry.departureDelay ?? carried;
    carried = departureDelay;
    const arrival = Math.max(earliest, entry.arrival + arrivalDelay * 60_000);
    const departure = Math.max(arrival, entry.departure + departureDelay * 60_000);
    earliest = departure;
    return { call: entry.call, arrival, departure };
  });
}
