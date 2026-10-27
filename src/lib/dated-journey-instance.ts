import type { StopEvent, DatedJourneyCalls } from "../data/transit-types";

/** Codes recur daily; a working can cross midnight but cannot span four hours between readings. */
const INSTANCE_WINDOW_MS = 4 * 60 * 60_000;

export function getDatedJourneyScheduleInstant(
  reading: StopEvent | DatedJourneyCalls,
): number | undefined {
  const first = reading.calls?.find(
    (call) => call.timetabledDepartureTime || call.timetabledArrivalTime,
  );
  const value =
    first?.timetabledDepartureTime ??
    first?.timetabledArrivalTime ??
    ("timetabledDepartureTime" in reading ? reading.timetabledDepartureTime : undefined);
  const instant = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(instant) ? instant : undefined;
}

/** The same operating day where both name one; otherwise close enough in the timetable. */
export function isSameDatedJourneyInstance(
  left: StopEvent | DatedJourneyCalls,
  right: StopEvent | DatedJourneyCalls,
): boolean {
  if (left.datedJourneyId && right.datedJourneyId)
    return left.datedJourneyId === right.datedJourneyId;
  const a = getDatedJourneyScheduleInstant(left);
  const b = getDatedJourneyScheduleInstant(right);
  return a === undefined || b === undefined || Math.abs(a - b) < INSTANCE_WINDOW_MS;
}
