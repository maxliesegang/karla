import type { Departure, DepartureBoard } from "../data/transit-types";

/**
 * Times against the feed's clock, not the device's: the offset is fixed when a board arrives and
 * advances with the device. *Feed time* is the source's clock now, *board age* how long ago the
 * board was read, and the *countdown* is derived from the schedule and deviation.
 */

/** The feed's server time when the board was read, advanced by the time since. */
export function getFeedNow(departureBoard: DepartureBoard | null, now: number): number {
  if (!departureBoard || departureBoard.dataStatus !== "live") return now;
  const serverTime = Date.parse(departureBoard.feedUpdatedAt);
  if (!Number.isFinite(serverTime)) return now;
  return serverTime + (now - departureBoard.receivedAt);
}

/** The feed's clock minus the device's, as fixed by the board. */
export const getFeedOffsetMs = (departureBoard: DepartureBoard | null): number =>
  getFeedNow(departureBoard, 0);

/** How long ago the board was read, on the feed's clock, so a wrong device clock cancels out. */
export function getBoardAgeMs(departureBoard: DepartureBoard | null, feedNow: number): number {
  if (!departureBoard || departureBoard.dataStatus !== "live") return 0;
  const feedUpdatedAt = Date.parse(departureBoard.feedUpdatedAt);
  return Number.isFinite(feedUpdatedAt) ? Math.max(0, feedNow - feedUpdatedAt) : 0;
}

/**
 * The instant a departure is expected at, so countdown and printed time agree. The prediction
 * (`realDateTime`) wins; the truncated deviation disagrees on about one row in twenty. Without a
 * prediction, schedule plus deviation; else the schedule.
 */
export function findExpectedDepartureInstant(
  scheduledDepartureTime: string,
  predictedDepartureTime: string | undefined,
  delayMinutes: number | undefined,
): number | undefined {
  const predicted = predictedDepartureTime ? Date.parse(predictedDepartureTime) : Number.NaN;
  if (Number.isFinite(predicted)) return predicted;
  const scheduled = Date.parse(scheduledDepartureTime);
  return Number.isFinite(scheduled) ? scheduled + (delayMinutes ?? 0) * 60_000 : undefined;
}

/**
 * The feed's clock truncated to the minute: EFA's `countdown` subtracts whole minutes, and KVV's
 * own displays show that number.
 */
const truncateToFeedMinute = (feedNow: number): number => Math.floor(feedNow / 60_000) * 60_000;

/**
 * Minutes left until the expected instant, counted live rather than from the feed's stale
 * countdown.
 */
export function getCountdownMinutes(departure: Departure, feedNow: number): number {
  const due = findExpectedDepartureInstant(
    departure.scheduledDepartureTime,
    departure.predictedDepartureTime,
    departure.delayMinutes,
  );
  // Without a time to count from, the feed's own countdown.
  if (due === undefined) return departure.minutesUntilDeparture;
  return Math.max(0, Math.floor((due - truncateToFeedMinute(feedNow)) / 60_000));
}
