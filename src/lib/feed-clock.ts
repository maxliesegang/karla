import type { Departure, DepartureBoard } from "../data/transit-types";

/**
 * Reading times against the feed's clock rather than the device's.
 *
 * A board states the feed's own server time, and the countdown a rider reads has to be counted from
 * that clock: a station board left running for a week drifts, a phone that has just woken has not
 * refreshed, and neither should turn into a wrong number of minutes. The board is read once and
 * then shown until the next refresh, so the offset between the two clocks is fixed at the moment it
 * arrives and the reading advances with the device from there.
 *
 * Three times are kept apart here, and the module says which is which: the *feed time* is what the
 * source's clock says now, the *board age* is how long ago the board in hand was read, and the
 * *countdown* is the minutes a rider has left, derived from the schedule and its deviation rather
 * than from the number the feed happened to state when the board was fetched.
 */

/** The feed's clock now: its server time when the board was read, advanced by the time since. */
export function getFeedNow(departureBoard: DepartureBoard | null, now: number): number {
  if (!departureBoard || departureBoard.dataStatus !== "live") return now;
  const serverTime = Date.parse(departureBoard.feedUpdatedAt);
  if (!Number.isFinite(serverTime)) return now;
  return serverTime + (now - departureBoard.receivedAt);
}

/**
 * How long ago the board in view was read. This is what a stale board has to be able to state.
 *
 * Counted on the feed's clock, against the feed's own timestamp, so a device whose clock is wrong
 * still reports the right age — the two errors are the same error and cancel.
 */
export function getBoardAgeMs(departureBoard: DepartureBoard | null, feedNow: number): number {
  if (!departureBoard || departureBoard.dataStatus !== "live") return 0;
  const feedUpdatedAt = Date.parse(departureBoard.feedUpdatedAt);
  return Number.isFinite(feedUpdatedAt) ? Math.max(0, feedNow - feedUpdatedAt) : 0;
}

/**
 * The instant a departure is expected at, as one function, so a countdown and a printed time can
 * never disagree about what it is.
 *
 * The feed publishes two accounts of it: `realDateTime`, its own prediction, and a deviation in
 * whole minutes stated beside the schedule. They usually agree, but not always — the deviation is
 * truncated where the prediction is not, so about one monitored row in twenty is published a minute
 * early by the sum and on time by the prediction. The prediction is the operator's own statement of
 * when the vehicle will be here, so it is what gets read; the deviation is the only account there
 * is where the feed published no prediction, and the schedule stands alone where it published
 * neither.
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
 * The feed's clock at the minute it is showing, which is the clock its own board is counted against.
 *
 * EFA states `countdown` as the difference between two whole minutes — 17:34 less 17:27, not less
 * 17:27:24 — and a rider standing under a KVV display is comparing that number with this one
 * directly. Counted to the second instead, every row here reads a minute lower than the platform
 * beside it for as long as the feed's clock has any seconds on it, which is nearly always. Nothing
 * is lost to the coarser reading: the exact time the vehicle is expected at is printed beside the
 * countdown, so the minutes are the approximation and the clock time is the fact.
 */
const truncateToFeedMinute = (feedNow: number): number => Math.floor(feedNow / 60_000) * 60_000;

/**
 * The minutes a rider has left, counted from the time the vehicle is expected at.
 *
 * The feed states a countdown of its own, but only as of the moment the board was fetched: between
 * refreshes it is up to a whole refresh interval stale, and a vehicle that is overdue keeps
 * reporting the zero it was floored to. Counted here, a departure runs down every tick and passes.
 */
export function getCountdownMinutes(departure: Departure, feedNow: number): number {
  const due = findExpectedDepartureInstant(
    departure.scheduledDepartureTime,
    departure.predictedDepartureTime,
    departure.delayMinutes,
  );
  // Without a time of its own there is nothing to count from, so the feed's own reading is all
  // there is.
  if (due === undefined) return departure.minutesUntilDeparture;
  return Math.max(0, Math.floor((due - truncateToFeedMinute(feedNow)) / 60_000));
}
