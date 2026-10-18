import type { TripCall } from "../data/transit-types";

export type TimedRunCall = { call: TripCall; arrival: number; departure: number };
type CallEnd = "arrival" | "departure";

function getOwnShiftMs(call: TripCall, end: CallEnd): number | undefined {
  const scheduled = Date.parse(
    (end === "arrival"
      ? (call.scheduledArrivalTime ?? call.scheduledDepartureTime)
      : (call.scheduledDepartureTime ?? call.scheduledArrivalTime)) ?? "",
  );
  const predicted = Date.parse(
    (end === "arrival" ? call.predictedArrivalTime : call.predictedDepartureTime) ?? "",
  );
  if (Number.isFinite(predicted) && Number.isFinite(scheduled)) return predicted - scheduled;
  const minutes = end === "arrival" ? call.arrivalDelayMinutes : call.delayMinutes;
  return minutes === undefined ? undefined : minutes * 60_000;
}

/**
 * A call end's deviation: its own prediction or delay, else the other end's. `undefined`: the call
 * is not monitored.
 */
export const getCallShiftMs = (call: TripCall, end: CallEnd): number | undefined =>
  getOwnShiftMs(call, end) ?? getOwnShiftMs(call, end === "arrival" ? "departure" : "arrival");

/** Missing deviations inherit the nearest stated one; expected calls never run backwards. */
export function getRunTimeline(calls: readonly TripCall[]): TimedRunCall[] {
  const scheduled = calls.flatMap((call) => {
    const arrival = Date.parse(call.scheduledArrivalTime ?? call.scheduledDepartureTime ?? "");
    const departure = Date.parse(call.scheduledDepartureTime ?? call.scheduledArrivalTime ?? "");
    if (!Number.isFinite(arrival) || !Number.isFinite(departure)) return [];
    const arrivalShift = getCallShiftMs(call, "arrival");
    const departureShift = getCallShiftMs(call, "departure");
    return [{ call, arrival, departure, arrivalShift, departureShift }];
  });
  const firstStated = scheduled.findIndex((call) => call.departureShift !== undefined);
  let carried = scheduled[firstStated]?.departureShift ?? 0;
  let earliest = Number.NEGATIVE_INFINITY;
  return scheduled.map((entry, index) => {
    const arrivalShift =
      entry.arrivalShift ??
      (index < firstStated ? scheduled[firstStated].arrivalShift : carried) ??
      0;
    const departureShift = entry.departureShift ?? carried;
    carried = departureShift;
    const arrival = Math.max(earliest, entry.arrival + arrivalShift);
    const departure = Math.max(arrival, entry.departure + departureShift);
    earliest = departure;
    return { call: entry.call, arrival, departure };
  });
}
