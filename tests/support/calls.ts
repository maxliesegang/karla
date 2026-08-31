import type { TripCall } from "../../src/data/transit-types.ts";

/**
 * One calling point, timed `minute` minutes after the reading's own `start`, named for the stop it
 * resolves to.
 *
 * The placement, turnaround and diagram tests all read trips the same way — a sequence of such
 * calls — so they share one maker rather than three drift-prone copies. `start` is per reading: two
 * tests that need the same wall-clock minute still mean different epochs.
 */
export const createCall =
  (start: number) =>
  (stopId: string, minute: number, delayMinutes = 0): TripCall => {
    const time = new Date(start + minute * 60_000).toISOString();
    return {
      stopName: stopId.toUpperCase(),
      localStopId: stopId,
      scheduledArrivalTime: time,
      scheduledDepartureTime: time,
      delayMinutes,
    };
  };

/**
 * A whole run as the feed publishes one: no arrival at the stop it starts from and no departure at
 * the one it ends at.
 *
 * That is how the feed says the run begins and ends there rather than merely being read from there,
 * and only such a reading may be drawn standing at either of its ends. A sequence with two times at
 * both ends is a reading that stops short of the vehicle, which is a different thing — the tests
 * that need one build it without `run`.
 */
export const run = (calls: readonly TripCall[]): TripCall[] =>
  calls.map((tripCall, index) => ({
    ...tripCall,
    scheduledArrivalTime: index === 0 ? undefined : tripCall.scheduledArrivalTime,
    scheduledDepartureTime:
      index === calls.length - 1 ? undefined : tripCall.scheduledDepartureTime,
  }));
