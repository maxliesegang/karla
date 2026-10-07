import type { Departure, RunSequence } from "../data/transit-types";

/** Codes recur daily; a working can cross midnight but cannot span four hours between readings. */
const INSTANCE_WINDOW_MS = 4 * 60 * 60_000;

export function getRunScheduleInstant(reading: Departure | RunSequence): number | undefined {
  const first = reading.tripCalls?.find(
    (call) => call.scheduledDepartureTime || call.scheduledArrivalTime,
  );
  const value =
    first?.scheduledDepartureTime ??
    first?.scheduledArrivalTime ??
    ("scheduledDepartureTime" in reading ? reading.scheduledDepartureTime : undefined);
  const instant = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(instant) ? instant : undefined;
}

export function isSameRunInstance(
  left: Departure | RunSequence,
  right: Departure | RunSequence,
): boolean {
  const a = getRunScheduleInstant(left);
  const b = getRunScheduleInstant(right);
  return a === undefined || b === undefined || Math.abs(a - b) < INSTANCE_WINDOW_MS;
}
