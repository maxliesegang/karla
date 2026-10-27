import type { StopEvent, StopEventBoard } from "../data/transit-types";

/**
 * Times against the feed's clock, not the device's: the offset is fixed when a board arrives and
 * advances with the device. *Feed time* is the source's clock now, *board age* how long ago the
 * board was read, and the *countdown* is derived from the schedule and deviation.
 */

/** The feed's server time when the board was read, advanced by the time since. */
export function getFeedNow(stopEventBoard: StopEventBoard | null, now: number): number {
  if (!stopEventBoard || stopEventBoard.dataStatus !== "live") return now;
  const serverTime = Date.parse(stopEventBoard.feedUpdatedAt);
  if (!Number.isFinite(serverTime)) return now;
  return serverTime + (now - stopEventBoard.receivedAt);
}

/** The feed's clock minus the device's, as fixed by the board. */
export const getFeedOffsetMs = (stopEventBoard: StopEventBoard | null): number =>
  getFeedNow(stopEventBoard, 0);

/** How long ago the board was read, on the feed's clock, so a wrong device clock cancels out. */
export function getBoardAgeMs(stopEventBoard: StopEventBoard | null, feedNow: number): number {
  if (!stopEventBoard || stopEventBoard.dataStatus !== "live") return 0;
  const feedUpdatedAt = Date.parse(stopEventBoard.feedUpdatedAt);
  return Number.isFinite(feedUpdatedAt) ? Math.max(0, feedNow - feedUpdatedAt) : 0;
}

/**
 * The instant a departure is expected at, so countdown and printed time agree. The prediction
 * (`realDateTime`) wins; the truncated deviation disagrees on about one row in twenty. Without a
 * prediction, schedule plus deviation; else the schedule.
 */
export function findExpectedDepartureInstant(
  timetabledDepartureTime: string,
  estimatedDepartureTime: string | undefined,
  delayMinutes: number | undefined,
): number | undefined {
  const estimated = estimatedDepartureTime ? Date.parse(estimatedDepartureTime) : Number.NaN;
  if (Number.isFinite(estimated)) return estimated;
  const timetabled = Date.parse(timetabledDepartureTime);
  return Number.isFinite(timetabled) ? timetabled + (delayMinutes ?? 0) * 60_000 : undefined;
}

/**
 * The feed's clock truncated to the minute: KVV's own displays count whole minutes.
 */
const truncateToFeedMinute = (feedNow: number): number => Math.floor(feedNow / 60_000) * 60_000;

/** Seconds left until a prediction stated to the second; `undefined` for any other row. */
export function getCountdownSeconds(stopEvent: StopEvent, feedNow: number): number | undefined {
  if (!stopEvent.isEstimatedToTheSecond || !stopEvent.estimatedDepartureTime) return undefined;
  const due = Date.parse(stopEvent.estimatedDepartureTime);
  return Number.isFinite(due) ? Math.max(0, Math.floor((due - feedNow) / 1_000)) : undefined;
}

/**
 * Minutes left until the expected instant, counted live rather than from the feed's stale
 * countdown.
 */
export function getCountdownMinutes(stopEvent: StopEvent, feedNow: number): number {
  const due = findExpectedDepartureInstant(
    stopEvent.timetabledDepartureTime,
    stopEvent.estimatedDepartureTime,
    stopEvent.delayMinutes,
  );
  // Without a time to count from, the feed's own countdown.
  if (due === undefined) return stopEvent.minutesUntilDeparture;
  return Math.max(0, Math.floor((due - truncateToFeedMinute(feedNow)) / 60_000));
}
