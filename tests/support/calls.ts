import type { TripCall } from "../../src/data/transit-types.ts";

/**
 * A call `minute` minutes after the reading's `start`, named for its stop; shared by placement,
 * turnaround and diagram tests.
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
 * A whole run as the feed publishes it: no arrival at its first stop, no departure at its last.
 * Only such a reading may stand at its ends; build cut-short readings without `run`.
 */
export const run = (calls: readonly TripCall[]): TripCall[] =>
  calls.map((tripCall, index) => ({
    ...tripCall,
    scheduledArrivalTime: index === 0 ? undefined : tripCall.scheduledArrivalTime,
    scheduledDepartureTime:
      index === calls.length - 1 ? undefined : tripCall.scheduledDepartureTime,
  }));
