import type { Departure, TripCall } from "../data/transit-types";
import { getCallKey } from "./trip-calls";
import { getVehicleTripKey, isSameVehicleTrip } from "./trips";

/**
 * Two separately addressed timetable trips that run as one consist until the shorter one ends.
 *
 * EFA does not publish a formation or coupling field. This relationship is therefore deliberately
 * narrower than "two rows at the same time": both trips must leave as the same line from the same
 * physical point, every call of the shorter trip must prefix the longer route, and every schedule
 * time both publish must agree. Branches, duplicate trips and uncertain readings remain separate.
 */
export type JoinedTripPortionPair = {
  terminating: Departure;
  continuing: Departure;
  sharedUntil: TripCall;
};

const MINIMUM_SHARED_CALLS = 4;

const getBucketKey = (departure: Departure): string =>
  JSON.stringify([
    departure.lineId,
    departure.boardingStopId,
    departure.platformName,
    departure.scheduledDepartureTime,
  ]);

const getComparableScheduledTimes = (left: TripCall, right: TripCall) =>
  [
    [left.scheduledArrivalTime, right.scheduledArrivalTime],
    [left.scheduledDepartureTime, right.scheduledDepartureTime],
  ].filter((pair): pair is [string, string] => pair[0] !== undefined && pair[1] !== undefined);

function findJoinedPair(first: Departure, second: Departure): JoinedTripPortionPair | undefined {
  if (
    first.status === "cancelled" ||
    second.status === "cancelled" ||
    !first.trainNumber ||
    first.trainNumber !== second.trainNumber ||
    getVehicleTripKey(first) === getVehicleTripKey(second) ||
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

/**
 * Finds only unambiguous pairs. A bucket containing three portions is left alone until the product
 * has a truthful way to describe and draw more than one split.
 */
export function getJoinedTripPortionPairs(
  departures: readonly Departure[],
): readonly JoinedTripPortionPair[] {
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

/** Finds the completed trip reading that belongs to a possibly basic board row. */
export function findJoinedTripPortionPair(
  departure: Departure,
  joinedPairs: readonly JoinedTripPortionPair[],
): JoinedTripPortionPair | undefined {
  return joinedPairs.find(
    ({ terminating, continuing }) =>
      isSameVehicleTrip(departure, terminating) || isSameVehicleTrip(departure, continuing),
  );
}
