import type { Call } from "../../src/data/transit-types.ts";

/**
 * A call `minute` minutes after the reading's `start`, named for its stop; shared by placement,
 * turnaround and diagram tests.
 */
export const createCall =
  (start: number) =>
  (stopId: string, minute: number, delayMinutes = 0): Call => {
    const time = new Date(start + minute * 60_000).toISOString();
    return {
      stopName: stopId.toUpperCase(),
      stopPlaceId: stopId,
      timetabledArrivalTime: time,
      timetabledDepartureTime: time,
      delayMinutes,
    };
  };

/**
 * A whole journey as the feed publishes it: no arrival at its first stop, no departure at its last.
 * Only such a reading may stand at its ends; build cut-short readings without `datedJourney`.
 */
export const datedJourney = (calls: readonly Call[]): Call[] =>
  calls.map((call, index) => ({
    ...call,
    timetabledArrivalTime: index === 0 ? undefined : call.timetabledArrivalTime,
    timetabledDepartureTime: index === calls.length - 1 ? undefined : call.timetabledDepartureTime,
  }));
