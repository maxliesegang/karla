import { getCallShiftMs, getDatedJourneyTimeline } from "./dated-journey-timeline";
import { withoutDatedJourneyCalls } from "./journeys";
import type {
  StopEvent,
  StopEventReadingTimes,
  StopEventStatus,
  DatedJourneyCalls,
  Call,
} from "../data/transit-types";

/**
 * Calling sequences, read outwards from one stop. Calls compare by resolved stop place id, or by
 * the feed's place and name where none resolved.
 */

/** How a calling point is identified, including where the feed resolved no stop place of ours. */
export const getCallKey = (call: Call): string =>
  call.stopPlaceId ?? `${call.placeName ?? ""}:${call.stopName}`;

const getCallBay = (call: Call): string | undefined => call.bay ?? call.bayText;

/** One stop's consecutive calls on a route: a single call, or travel between its bays. */
type StopVisit = { callCount: number; bays: ReadonlySet<string> };

/** The visit each call belongs to. */
function getStopVisits(calls: readonly Call[]): StopVisit[] {
  const visits: StopVisit[] = [];
  for (let start = 0; start < calls.length; ) {
    let end = start + 1;
    while (end < calls.length && getCallKey(calls[end]) === getCallKey(calls[start])) end += 1;
    const visitCalls = calls.slice(start, end);
    const visit = {
      callCount: visitCalls.length,
      bays: new Set(visitCalls.flatMap((call) => getCallBay(call) ?? [])),
    };
    for (let index = start; index < end; index += 1) visits.push(visit);
    start = end;
  }
  return visits;
}

/**
 * Whether bay tells two visits' calls apart: only where the stop repeats and both readings
 * use the same bays. Opposite directions stop at their own bays (Europaplatz: `3`, `5`
 * one way, `6`, `4` the other), so read the same way up, their calls pair by order.
 */
const isBayDecisive = (left: StopVisit, right: StopVisit): boolean =>
  (left.callCount > 1 || right.callCount > 1) && [...left.bays].some((bay) => right.bays.has(bay));

/**
 * Whether two readings' calls are the same call of the route. Bay is compared only where it
 * is decisive; elsewhere a diverted working's different bay must still match.
 */
function isSameRouteCall(left: Call, right: Call, comparesBays: boolean): boolean {
  if (getCallKey(left) !== getCallKey(right)) return false;
  if (!comparesBays) return true;
  const leftBay = getCallBay(left);
  const rightBay = getCallBay(right);
  // Without a bay on both sides, the stop is the best answer.
  return !leftBay || !rightBay || leftBay === rightBay;
}

/**
 * Which calls of two readings of one route correspond, as a longest common subsequence, so each
 * call of a repeated stop gets its own anchor. Routes are tens of calls, so the matrix is small.
 */
export function alignSameRouteCalls(
  left: readonly Call[],
  right: readonly Call[],
): readonly (readonly [leftIndex: number, rightIndex: number])[] {
  const leftVisits = getStopVisits(left);
  const rightVisits = getStopVisits(right);
  const isSameCall = (leftIndex: number, rightIndex: number) =>
    isSameRouteCall(
      left[leftIndex],
      right[rightIndex],
      isBayDecisive(leftVisits[leftIndex], rightVisits[rightIndex]),
    );

  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex][rightIndex] = isSameCall(leftIndex, rightIndex)
        ? 1 + lengths[leftIndex + 1][rightIndex + 1]
        : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
    }
  }

  const anchors: [number, number][] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (isSameCall(leftIndex, rightIndex)) {
      anchors.push([leftIndex, rightIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (lengths[leftIndex + 1][rightIndex] > lengths[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return anchors;
}

/**
 * Whether `calls` run in the same order as `reference`, read from the first two stops they share;
 * `undefined` where they share fewer.
 */
export function runsInOrderOf(
  calls: readonly Call[],
  reference: readonly Call[],
): boolean | undefined {
  const indexByKey = new Map(calls.map((call, index) => [getCallKey(call), index]));
  const sharedIndices = reference.flatMap((call) => indexByKey.get(getCallKey(call)) ?? []);
  const first = sharedIndices[0];
  const next = sharedIndices.find((index) => index !== first);
  return first === undefined || next === undefined ? undefined : next > first;
}

/** One string for a whole route. */
export const getCallSequenceKey = (calls: readonly Call[]): string =>
  calls.map(getCallKey).join(">");

export const getCallsAfterStop = (stopEvent: StopEvent, stopId: string): readonly Call[] =>
  getCallsPastIndex(stopEvent.calls ?? [], findStopCallIndex(stopEvent, stopId));

/**
 * The index of a departure's call at a stop, or -1. A dated journey is merged into every stop's
 * row, so the current-stop marker counts only at this stop, or where its call resolved to no local
 * stop.
 */
export function findStopCallIndex(stopEvent: StopEvent, stopId: string): number {
  const calls = stopEvent.calls ?? [];
  const markedCurrentIndex =
    stopEvent.boardingStopPlaceId === stopId ? calls.findIndex((call) => call.isThisCall) : -1;
  const markedStopId = calls[markedCurrentIndex]?.stopPlaceId;
  const isMarkedHere =
    markedCurrentIndex >= 0 && (markedStopId === undefined || markedStopId === stopId);
  return isMarkedHere ? markedCurrentIndex : calls.findIndex((call) => call.stopPlaceId === stopId);
}

/**
 * The calls past one call of a sequence, for callers holding a sequence rather than a departure.
 */
export function getCallsPastIndex(calls: readonly Call[], currentIndex: number): readonly Call[] {
  if (currentIndex < 0 || currentIndex >= calls.length) return [];
  return calls.slice(currentIndex + 1);
}

export const findFirstCallBeyondStop = (calls: readonly Call[], stopId: string): Call | undefined =>
  calls.find((call) => call.stopPlaceId !== stopId);

/** The stops a route visits in order, consecutive calls of one stop counted once. */
export function getVisitedStopKeys(calls: readonly Call[]): string[] {
  const keys: string[] = [];
  for (const call of calls) {
    const key = getCallKey(call);
    if (keys.at(-1) !== key) keys.push(key);
  }
  return keys;
}

/**
 * The calls with each turnaround pair (a dated journey's start or end, reported at the turning
 * track and the public bay) folded into the public call. Other repeats are real travel
 * (Europaplatz's two bays, Marktplatz's tunnels) and stay.
 *
 * At a start the public call's arrival (the pull forward) is dropped, so a waiting journey stands
 * for its whole lead; at an end its published departure is kept, as the row counts down to it.
 * Hirtenweg: line 4 is timed out of Gleis 3 and boards at Gleis 1. Run-end readers use the raw
 * `calls`, not this chain.
 */
export function collapseTurnaroundCalls(calls: readonly Call[]): readonly Call[] {
  const kept: Call[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const next = calls[index + 1];
    if (!next || !isTurnaroundPair(call, next)) {
      kept.push(call);
      continue;
    }

    // Diagrams may read the journey reversed, so the boundary may be on either side of the pair.
    const boundary = statesDatedJourneyBoundary(call) ? call : next;
    const publicCall = boundary === call ? next : call;
    let merged: Call;
    if (statesDatedJourneyStart(boundary)) {
      merged = { ...publicCall, timetabledArrivalTime: undefined };
      delete merged.arrivalDelayMinutes;
      delete merged.estimatedArrivalTime;
    } else {
      // Without a departure the arrival is the headline; with one the public call is kept whole.
      merged =
        publicCall.timetabledDepartureTime === undefined
          ? {
              ...publicCall,
              delayMinutes: publicCall.arrivalDelayMinutes ?? publicCall.delayMinutes,
              ...(publicCall.estimatedArrivalTime
                ? { estimatedDepartureTime: publicCall.estimatedArrivalTime }
                : {}),
            }
          : publicCall;
    }
    if (call.isThisCall || next.isThisCall) merged.isThisCall = true;
    else delete merged.isThisCall;
    kept.push(merged);
    index += 1;
  }
  return kept;
}

/**
 * Whether two consecutive calls of one stop are a vehicle turning: only a pair straddling a dated
 * journey boundary the feed marks. Two fully timed calls are travel (Europaplatz `Gleis 3`
 * 08:57/08:58, `Gleis 5` 08:58/08:59). The board's own call looks like a dated journey origin on
 * every reading, so it is never a boundary.
 */
export function isTurnaroundPair(previous: Call, call: Call): boolean {
  if (getCallKey(previous) !== getCallKey(call)) return false;
  return statesDatedJourneyBoundary(previous) || statesDatedJourneyBoundary(call);
}

/** A dated journey boundary marked by the feed on a call that is not the board's own. */
const statesDatedJourneyBoundary = (call: Call): boolean =>
  !call.isThisCall && (statesDatedJourneyStart(call) || statesDatedJourneyEnd(call));

/**
 * Whether the feed says a dated journey begins (`arrValid=0`) or ends (`depValid=0`) here; the
 * parser drops the invalidated time. The end of the calls in hand is not a dated journey end: a
 * cut-short reading stops mid-route.
 */
export const statesDatedJourneyStart = (call: Call | undefined): boolean =>
  call?.timetabledDepartureTime !== undefined && call.timetabledArrivalTime === undefined;

export const statesDatedJourneyEnd = (call: Call | undefined): boolean =>
  call?.timetabledArrivalTime !== undefined && call.timetabledDepartureTime === undefined;

/**
 * When the dated journey is expected to be over: the last call's time plus its deviation. No grace
 * period; each caller decides how long a finished dated journey is worth holding.
 */
export function findFinalCallInstant(calls: readonly Call[] | undefined): number | undefined {
  const last = getDatedJourneyTimeline(calls ?? []).at(-1);
  return last?.call === calls?.at(-1) ? last?.departure : undefined;
}

/**
 * The instant a call is expected at: its prediction, else its published time plus its deviation.
 * Arrival and departure ends differ only where the feed states them apart.
 */
export function getCallInstant(
  call: Call | undefined,
  end: "arrival" | "departure" = "departure",
): number | undefined {
  if (!call) return undefined;
  const timetabled =
    end === "arrival"
      ? (call.timetabledArrivalTime ?? call.timetabledDepartureTime)
      : (call.timetabledDepartureTime ?? call.timetabledArrivalTime);
  const timetabledInstant = timetabled ? Date.parse(timetabled) : Number.NaN;
  if (!Number.isFinite(timetabledInstant)) return undefined;
  return timetabledInstant + (getCallShiftMs(call, end) ?? 0);
}

/** The calls ahead of the board this departure was read from. */
export const getCallsAfterCurrentStop = (stopEvent: StopEvent): readonly Call[] =>
  getCallsAfterStop(stopEvent, stopEvent.boardingStopPlaceId);

/** The stretch all these routes share; a route that stops short ends it. */
export type CommonCallPrefixAlignment = {
  /** The shared calls, keeping the most calls any sequence published at a repeated stop. */
  calls: readonly Call[];
  /** How many calls of each input sequence the shared prefix consumed. */
  consumedCallCounts: readonly number[];
};

/**
 * The shared prefix of several routes, aligned by stop rather than position. Consecutive calls of
 * one stop compare as one visit (two bays at Marktplatz on one line, one on another), and the
 * sequence with the most calls there is kept.
 */
export function getCommonCallPrefixAlignment(
  sequences: readonly (readonly Call[])[],
): CommonCallPrefixAlignment {
  const consumedCallCounts = sequences.map(() => 0);
  const calls: Call[] = [];
  while (sequences.length > 0) {
    const nextCalls = sequences.map((sequence, index) => sequence[consumedCallCounts[index]]);
    const first = nextCalls[0];
    if (!first || nextCalls.some((call) => !call || getCallKey(call) !== getCallKey(first))) break;

    const key = getCallKey(first);
    const datedJourneys = sequences.map((sequence, index) => {
      const start = consumedCallCounts[index];
      let end = start;
      while (sequence[end] && getCallKey(sequence[end]) === key) end += 1;
      consumedCallCounts[index] = end;
      return sequence.slice(start, end);
    });
    const longest = datedJourneys.reduce(
      (kept, datedJourney) => (datedJourney.length > kept.length ? datedJourney : kept),
      datedJourneys[0],
    );
    calls.push(...longest);
  }
  return { calls, consumedCallCounts };
}

export function getCommonCallPrefix(sequences: readonly (readonly Call[])[]): readonly Call[] {
  return getCommonCallPrefixAlignment(sequences).calls;
}

/** Only a whole-journey exception overrules the stop's own row. */
const isExceptionalStatus = (status: StopEventStatus): boolean =>
  status === "cancelled" || status === "diverted";

/**
 * One stop's row completed by another reading of the same dated journey, as a `StopEvent`. That
 * reading adds its sequence, dated identity and any whole-journey exception; its stop facts are
 * dropped (`toDatedJourneySequence`).
 */
export function mergeDatedJourneyReading(
  row: StopEvent,
  reading: StopEvent | undefined,
): StopEvent {
  if (!reading) return row;
  const merged = mergeDatedJourneySequence(row, toDatedJourneySequence(reading));
  return {
    ...merged,
    datedJourneyId: reading.datedJourneyId ?? merged.datedJourneyId,
    status: isExceptionalStatus(reading.status) ? reading.status : merged.status,
  };
}

/**
 * The addressed dated journey: the stop's row, completed only by the dated journey's own reading.
 * Board calls on the row or the observed copy never stand in for it.
 */
export function mergeAddressedDatedJourney(
  row: StopEvent | undefined,
  observed: StopEvent | undefined,
  reading: StopEvent | undefined,
): StopEvent | undefined {
  const datedJourney = reading ?? (observed && withoutDatedJourneyCalls(observed));
  return row ? mergeDatedJourneyReading(withoutDatedJourneyCalls(row), datedJourney) : datedJourney;
}

/**
 * The sequence a departure carries, without its stop facts; nothing where it has no calls.
 */
export function toDatedJourneySequence(stopEvent: StopEvent): DatedJourneyCalls | undefined {
  if (!stopEvent.calls?.length) return undefined;
  return {
    calls: stopEvent.calls,
    ...(stopEvent.datedJourneyId ? { datedJourneyId: stopEvent.datedJourneyId } : {}),
    status: stopEvent.status,
    ...(stopEvent.readAt?.coverageReadAt !== undefined
      ? { coverageReadAt: stopEvent.readAt.coverageReadAt }
      : {}),
    ...(stopEvent.readAt?.sequenceReadAt !== undefined
      ? { readAt: stopEvent.readAt.sequenceReadAt }
      : {}),
  };
}

/**
 * A stop row completed by a separately read dated journey. The row keeps its countdown, bay and
 * delay; the sequence adds calls, dated identity and whole-journey cancellation or diversion. Each
 * half keeps its own read time (`StopEvent.readAt`).
 */
export function mergeDatedJourneySequence(
  row: StopEvent,
  sequence: DatedJourneyCalls | undefined,
): StopEvent {
  if (!sequence) return row;
  const readAt = resolveMergedReadingTimes(row, sequence);
  return {
    ...row,
    datedJourneyId: sequence.datedJourneyId ?? row.datedJourneyId,
    status: isExceptionalStatus(sequence.status) ? sequence.status : row.status,
    calls: sequence.calls,
    ...(readAt ? { readAt } : {}),
  };
}

/**
 * Each half's read time. A row without one takes the sequence's; nothing where neither was stamped
 * (fixtures).
 */
function resolveMergedReadingTimes(
  row: StopEvent,
  sequence: DatedJourneyCalls,
): StopEventReadingTimes | undefined {
  const rowReadAt = row.readAt?.rowReadAt ?? sequence.readAt;
  if (rowReadAt === undefined) return undefined;
  return {
    rowReadAt,
    ...(sequence.readAt !== undefined ? { sequenceReadAt: sequence.readAt } : {}),
    ...(sequence.coverageReadAt !== undefined ? { coverageReadAt: sequence.coverageReadAt } : {}),
  };
}

/** An unconfirmed contiguous excerpt updates its calls without deleting known route coverage. */
export function retainDatedJourneyCoverage(
  previous: DatedJourneyCalls | undefined,
  incoming: DatedJourneyCalls,
): DatedJourneyCalls {
  if (!previous || statesDatedJourneyEnd(incoming.calls.at(-1))) return incoming;
  const anchors = alignSameRouteCalls(previous.calls, incoming.calls);
  if (anchors.length !== incoming.calls.length || anchors.length === 0) return incoming;
  const first = anchors[0][0];
  const last = anchors.at(-1)![0];
  if (last - first + 1 !== incoming.calls.length || incoming.calls.length >= previous.calls.length)
    return incoming;
  const coverageReadAt = previous.coverageReadAt ?? previous.readAt;
  return {
    ...incoming,
    ...(first > 0 && previous.datedJourneyId ? { datedJourneyId: previous.datedJourneyId } : {}),
    calls: [
      ...previous.calls.slice(0, first),
      ...incoming.calls,
      ...previous.calls.slice(last + 1),
    ],
    ...(coverageReadAt !== undefined ? { coverageReadAt } : {}),
  };
}
