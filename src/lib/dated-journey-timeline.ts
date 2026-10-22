import type { Call } from "../data/transit-types";

export type TimedDatedJourneyCall = { call: Call; arrival: number; departure: number };
type CallEnd = "arrival" | "departure";

function getOwnShiftMs(call: Call, end: CallEnd): number | undefined {
  const timetabled = Date.parse(
    (end === "arrival"
      ? (call.timetabledArrivalTime ?? call.timetabledDepartureTime)
      : (call.timetabledDepartureTime ?? call.timetabledArrivalTime)) ?? "",
  );
  const estimated = Date.parse(
    (end === "arrival" ? call.estimatedArrivalTime : call.estimatedDepartureTime) ?? "",
  );
  if (Number.isFinite(estimated) && Number.isFinite(timetabled)) return estimated - timetabled;
  const minutes = end === "arrival" ? call.arrivalDelayMinutes : call.delayMinutes;
  return minutes === undefined ? undefined : minutes * 60_000;
}

/**
 * A call end's deviation: its own prediction or delay, else the other end's. `undefined`: the call
 * is not monitored.
 */
export const getCallShiftMs = (call: Call, end: CallEnd): number | undefined =>
  getOwnShiftMs(call, end) ?? getOwnShiftMs(call, end === "arrival" ? "departure" : "arrival");

/** Missing deviations inherit the nearest stated one; expected calls never run backwards. */
export function getDatedJourneyTimeline(calls: readonly Call[]): TimedDatedJourneyCall[] {
  const timetabled = calls.flatMap((call) => {
    const arrival = Date.parse(call.timetabledArrivalTime ?? call.timetabledDepartureTime ?? "");
    const departure = Date.parse(call.timetabledDepartureTime ?? call.timetabledArrivalTime ?? "");
    if (!Number.isFinite(arrival) || !Number.isFinite(departure)) return [];
    const arrivalShift = getCallShiftMs(call, "arrival");
    const departureShift = getCallShiftMs(call, "departure");
    return [{ call, arrival, departure, arrivalShift, departureShift }];
  });
  const firstStated = timetabled.findIndex((call) => call.departureShift !== undefined);
  let carried = timetabled[firstStated]?.departureShift ?? 0;
  let earliest = Number.NEGATIVE_INFINITY;
  return timetabled.map((entry, index) => {
    const arrivalShift =
      entry.arrivalShift ??
      (index < firstStated ? timetabled[firstStated].arrivalShift : carried) ??
      0;
    const departureShift = entry.departureShift ?? carried;
    carried = departureShift;
    const arrival = Math.max(earliest, entry.arrival + arrivalShift);
    const departure = Math.max(arrival, entry.departure + departureShift);
    earliest = departure;
    return { call: entry.call, arrival, departure };
  });
}
