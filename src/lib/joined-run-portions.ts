import type { Departure, TripCall } from "../data/transit-types";
import { getCallKey } from "./trip-calls";
import { getRunMarkKey, isSameRun } from "./trips";

/**
 * Two separately addressed trips running as one consist until the shorter ends. EFA publishes no
 * coupling, so pairing is strict: same line and departure point, the shorter route a prefix of the
 * longer, and every shared schedule time equal.
 */
export type JoinedRunPortionPair = {
  terminating: Departure;
  continuing: Departure;
  sharedUntil: TripCall;
};

const MINIMUM_SHARED_CALLS = 4;

const getBucketKey = (departure: Departure): string =>
  JSON.stringify([
    departure.lineId,
    departure.boardingLocalStopId,
    departure.platformCode,
    departure.scheduledDepartureTime,
  ]);

const getComparableScheduledTimes = (left: TripCall, right: TripCall) =>
  [
    [left.scheduledArrivalTime, right.scheduledArrivalTime],
    [left.scheduledDepartureTime, right.scheduledDepartureTime],
  ].filter((pair): pair is [string, string] => pair[0] !== undefined && pair[1] !== undefined);

function findJoinedPair(first: Departure, second: Departure): JoinedRunPortionPair | undefined {
  if (
    first.status === "cancelled" ||
    second.status === "cancelled" ||
    !first.trainNumber ||
    first.trainNumber !== second.trainNumber ||
    getRunMarkKey(first) === getRunMarkKey(second) ||
    first.destination === second.destination
  )
    return undefined;

  const firstCalls = first.tripCalls ?? [];
  const secondCalls = second.tripCalls ?? [];
  const [terminating, continuing, shorterCalls, longerCalls] =
    firstCalls.length < secondCalls.length
      ? [first, second, firstCalls, secondCalls]
      : [second, first, secondCalls, firstCalls];
  const comparableTimes = shorterCalls.flatMap((call, index) =>
    getComparableScheduledTimes(call, longerCalls[index]),
  );

  if (
    shorterCalls.length < MINIMUM_SHARED_CALLS ||
    shorterCalls.length >= longerCalls.length ||
    !shorterCalls.every((call, index) => getCallKey(call) === getCallKey(longerCalls[index])) ||
    comparableTimes.some(([first, second]) => first !== second)
  )
    return undefined;

  const sharedUntil = shorterCalls.at(-1);
  return sharedUntil ? { terminating, continuing, sharedUntil } : undefined;
}

/** Unambiguous pairs only; a bucket of three portions is left alone. */
export function getJoinedRunPortionPairs(
  departures: readonly Departure[],
): readonly JoinedRunPortionPair[] {
  const byDepartureFact = new Map<string, Departure[]>();
  for (const departure of departures) {
    const bucket = byDepartureFact.get(getBucketKey(departure)) ?? [];
    bucket.push(departure);
    byDepartureFact.set(getBucketKey(departure), bucket);
  }

  return [...byDepartureFact.values()].flatMap((bucket) => {
    if (bucket.length !== 2) return [];
    const joined = findJoinedPair(bucket[0], bucket[1]);
    return joined ? [joined] : [];
  });
}

/** The pair a possibly basic board row belongs to. */
export function findJoinedRunPortionPair(
  departure: Departure,
  joinedPortionPairs: readonly JoinedRunPortionPair[],
): JoinedRunPortionPair | undefined {
  return joinedPortionPairs.find(
    ({ terminating, continuing }) =>
      isSameRun(departure, terminating) || isSameRun(departure, continuing),
  );
}
