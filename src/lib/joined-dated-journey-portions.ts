import type { StopEvent, Call } from "../data/transit-types";
import { getCallKey } from "./calls";
import { getDatedJourneyMarkKey, isSameDatedJourney } from "./journeys";

/**
 * Two separately addressed journeys running as one consist until the shorter ends. The feed states no
 * coupling, so pairing is strict: same line and departure point, the shorter route a prefix of the
 * longer, and every shared schedule time equal.
 */
export type JoinedDatedJourneyPortionPair = {
  terminating: StopEvent;
  continuing: StopEvent;
  sharedUntil: Call;
};

const MINIMUM_SHARED_CALLS = 4;

const getBucketKey = (stopEvent: StopEvent): string =>
  JSON.stringify([
    stopEvent.lineId,
    stopEvent.boardingLocalStopId,
    stopEvent.bay,
    stopEvent.timetabledDepartureTime,
  ]);

const getComparableTimetabledTimes = (left: Call, right: Call) =>
  [
    [left.timetabledArrivalTime, right.timetabledArrivalTime],
    [left.timetabledDepartureTime, right.timetabledDepartureTime],
  ].filter((pair): pair is [string, string] => pair[0] !== undefined && pair[1] !== undefined);

function findJoinedPair(
  first: StopEvent,
  second: StopEvent,
): JoinedDatedJourneyPortionPair | undefined {
  if (
    first.status === "cancelled" ||
    second.status === "cancelled" ||
    !first.publishedJourneyNumber ||
    first.publishedJourneyNumber !== second.publishedJourneyNumber ||
    getDatedJourneyMarkKey(first) === getDatedJourneyMarkKey(second) ||
    first.destinationText === second.destinationText
  )
    return undefined;

  const firstCalls = first.calls ?? [];
  const secondCalls = second.calls ?? [];
  const [terminating, continuing, shorterCalls, longerCalls] =
    firstCalls.length < secondCalls.length
      ? [first, second, firstCalls, secondCalls]
      : [second, first, secondCalls, firstCalls];
  const comparableTimes = shorterCalls.flatMap((call, index) =>
    getComparableTimetabledTimes(call, longerCalls[index]),
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
export function getJoinedDatedJourneyPortionPairs(
  stopEvents: readonly StopEvent[],
): readonly JoinedDatedJourneyPortionPair[] {
  const byStopEventFact = new Map<string, StopEvent[]>();
  for (const stopEvent of stopEvents) {
    const bucket = byStopEventFact.get(getBucketKey(stopEvent)) ?? [];
    bucket.push(stopEvent);
    byStopEventFact.set(getBucketKey(stopEvent), bucket);
  }

  return [...byStopEventFact.values()].flatMap((bucket) => {
    if (bucket.length !== 2) return [];
    const joined = findJoinedPair(bucket[0], bucket[1]);
    return joined ? [joined] : [];
  });
}

/** The pair a possibly basic board row belongs to. */
export function findJoinedDatedJourneyPortionPair(
  stopEvent: StopEvent,
  joinedPortionPairs: readonly JoinedDatedJourneyPortionPair[],
): JoinedDatedJourneyPortionPair | undefined {
  return joinedPortionPairs.find(
    ({ terminating, continuing }) =>
      isSameDatedJourney(stopEvent, terminating) || isSameDatedJourney(stopEvent, continuing),
  );
}
