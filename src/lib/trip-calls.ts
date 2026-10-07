import { getRunTimeline } from "./run-timeline";
import type {
  Departure,
  DepartureReadingTimes,
  DepartureStatus,
  RunSequence,
  TripCall,
} from "../data/transit-types";

/**
 * Calling sequences, read outwards from one stop. Calls compare by resolved local stop id, or by
 * the feed's place and name where none resolved.
 */

/** How a calling point is identified, including where the feed resolved no local stop of ours. */
export const getCallKey = (call: TripCall): string =>
  call.localStopId ?? `${call.placeName ?? ""}:${call.stopName}`;

const getCallPlatform = (call: TripCall): string | undefined =>
  call.platformCode ?? call.platformLabel;

/** One stop's consecutive calls on a route: a single call, or travel between its platforms. */
type StopVisit = { callCount: number; platforms: ReadonlySet<string> };

/** The visit each call belongs to. */
function getStopVisits(calls: readonly TripCall[]): StopVisit[] {
  const visits: StopVisit[] = [];
  for (let start = 0; start < calls.length; ) {
    let end = start + 1;
    while (end < calls.length && getCallKey(calls[end]) === getCallKey(calls[start])) end += 1;
    const visitCalls = calls.slice(start, end);
    const visit = {
      callCount: visitCalls.length,
      platforms: new Set(visitCalls.flatMap((call) => getCallPlatform(call) ?? [])),
    };
    for (let index = start; index < end; index += 1) visits.push(visit);
    start = end;
  }
  return visits;
}

/**
 * Whether platform tells two visits' calls apart: only where the stop repeats and both readings
 * use the same platforms. Opposite directions stop at their own platforms (Europaplatz: `3`, `5`
 * one way, `6`, `4` the other), so read the same way up, their calls pair by order.
 */
const isPlatformDecisive = (left: StopVisit, right: StopVisit): boolean =>
  (left.callCount > 1 || right.callCount > 1) &&
  [...left.platforms].some((platform) => right.platforms.has(platform));

/**
 * Whether two readings' calls are the same call of the route. Platform is compared only where it
 * is decisive; elsewhere a diverted working's different platform must still match.
 */
function isSameRouteCall(left: TripCall, right: TripCall, comparesPlatforms: boolean): boolean {
  if (getCallKey(left) !== getCallKey(right)) return false;
  if (!comparesPlatforms) return true;
  const leftPlatform = getCallPlatform(left);
  const rightPlatform = getCallPlatform(right);
  // Without a platform on both sides, the stop is the best answer.
  return !leftPlatform || !rightPlatform || leftPlatform === rightPlatform;
}

/**
 * Which calls of two readings of one route correspond, as a longest common subsequence, so each
 * call of a repeated stop gets its own anchor. Routes are tens of calls, so the matrix is small.
 */
export function alignSameRouteCalls(
  left: readonly TripCall[],
  right: readonly TripCall[],
): readonly (readonly [leftIndex: number, rightIndex: number])[] {
  const leftVisits = getStopVisits(left);
  const rightVisits = getStopVisits(right);
  const isSameCall = (leftIndex: number, rightIndex: number) =>
    isSameRouteCall(
      left[leftIndex],
      right[rightIndex],
      isPlatformDecisive(leftVisits[leftIndex], rightVisits[rightIndex]),
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
  calls: readonly TripCall[],
  reference: readonly TripCall[],
): boolean | undefined {
  const indexByKey = new Map(calls.map((call, index) => [getCallKey(call), index]));
  const sharedIndices = reference.flatMap((call) => indexByKey.get(getCallKey(call)) ?? []);
  const first = sharedIndices[0];
  const next = sharedIndices.find((index) => index !== first);
  return first === undefined || next === undefined ? undefined : next > first;
}

/** One string for a whole route. */
export const getCallSequenceKey = (calls: readonly TripCall[]): string =>
  calls.map(getCallKey).join(">");

export const getCallsAfterStop = (departure: Departure, stopId: string): readonly TripCall[] =>
  getCallsPastIndex(departure.tripCalls ?? [], findStopCallIndex(departure, stopId));

/**
 * The index of a departure's call at a stop, or -1. A run is merged into every stop's row, so the
 * current-stop marker counts only at this stop, or where its call resolved to no local stop.
 */
export function findStopCallIndex(departure: Departure, stopId: string): number {
  const calls = departure.tripCalls ?? [];
  const markedCurrentIndex =
    departure.boardingLocalStopId === stopId ? calls.findIndex((call) => call.isCurrentStop) : -1;
  const markedStopId = calls[markedCurrentIndex]?.localStopId;
  const isMarkedHere =
    markedCurrentIndex >= 0 && (markedStopId === undefined || markedStopId === stopId);
  return isMarkedHere ? markedCurrentIndex : calls.findIndex((call) => call.localStopId === stopId);
}

/**
 * The calls past one call of a sequence, for callers holding a sequence rather than a departure.
 */
export function getCallsPastIndex(
  calls: readonly TripCall[],
  currentIndex: number,
): readonly TripCall[] {
  if (currentIndex < 0 || currentIndex >= calls.length) return [];
  return calls.slice(currentIndex + 1);
}

export const findFirstCallBeyondStop = (
  calls: readonly TripCall[],
  stopId: string,
): TripCall | undefined => calls.find((call) => call.localStopId !== stopId);

/** The stops a route visits in order, consecutive calls of one stop counted once. */
export function getVisitedStopKeys(calls: readonly TripCall[]): string[] {
  const keys: string[] = [];
  for (const call of calls) {
    const key = getCallKey(call);
    if (keys.at(-1) !== key) keys.push(key);
  }
  return keys;
}

/**
 * The calls with each turnaround pair (a run's start or end, reported at the turning track and the
 * public platform) folded into the public call. Other repeats are real travel (Europaplatz's two
 * platforms, Marktplatz's tunnels) and stay.
 *
 * At a start the public call's arrival (the pull forward) is dropped, so a waiting trip stands for
 * its whole lead; at an end its published departure is kept, as the row counts down to it.
 * Hirtenweg: line 4 is timed out of Gleis 3 and boards at Gleis 1. Run-end readers use the raw
 * `tripCalls`, not this chain.
 */
export function collapseTurnaroundCalls(calls: readonly TripCall[]): readonly TripCall[] {
  const kept: TripCall[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const next = calls[index + 1];
    if (!next || !isTurnaroundPair(call, next)) {
      kept.push(call);
      continue;
    }

    // Diagrams may read the trip reversed, so the boundary may be on either side of the pair.
    const boundary = statesRunBoundary(call) ? call : next;
    const publicCall = boundary === call ? next : call;
    let merged: TripCall;
    if (statesRunStart(boundary)) {
      merged = { ...publicCall, scheduledArrivalTime: undefined };
      delete merged.arrivalDelayMinutes;
    } else {
      // Without a departure the arrival is the headline; with one the public call is kept whole.
      merged =
        publicCall.scheduledDepartureTime === undefined
          ? {
              ...publicCall,
              delayMinutes: publicCall.arrivalDelayMinutes ?? publicCall.delayMinutes,
            }
          : publicCall;
    }
    if (call.isCurrentStop || next.isCurrentStop) merged.isCurrentStop = true;
    else delete merged.isCurrentStop;
    kept.push(merged);
    index += 1;
  }
  return kept;
}

/**
 * Whether two consecutive calls of one stop are a vehicle turning: only a pair straddling a run
 * boundary the feed marks. Two fully timed calls are travel (Europaplatz `Gleis 3` 08:57/08:58,
 * `Gleis 5` 08:58/08:59). The board's own call looks like a run origin on every reading, so it is
 * never a boundary.
 */
export function isTurnaroundPair(previous: TripCall, call: TripCall): boolean {
  if (getCallKey(previous) !== getCallKey(call)) return false;
  return statesRunBoundary(previous) || statesRunBoundary(call);
}

/** A run boundary marked by the feed on a call that is not the board's own. */
const statesRunBoundary = (call: TripCall): boolean =>
  !call.isCurrentStop && (statesRunStart(call) || statesRunEnd(call));

/**
 * Whether the feed says a run begins (`arrValid=0`) or ends (`depValid=0`) here; the parser drops
 * the invalidated time. The end of the calls in hand is not a run end: a cut-short reading stops
 * mid-route.
 */
export const statesRunStart = (call: TripCall | undefined): boolean =>
  call?.scheduledDepartureTime !== undefined && call.scheduledArrivalTime === undefined;

export const statesRunEnd = (call: TripCall | undefined): boolean =>
  call?.scheduledArrivalTime !== undefined && call.scheduledDepartureTime === undefined;

/**
 * When the run is expected to be over: the last call's time plus its deviation. No grace period;
 * each caller decides how long a finished run is worth holding.
 */
export function findFinalCallInstant(calls: readonly TripCall[] | undefined): number | undefined {
  const last = getRunTimeline(calls ?? []).at(-1);
  return last?.call === calls?.at(-1) ? last?.departure : undefined;
}

/**
 * The instant a call is expected at: its published time plus its deviation. Arrival and departure
 * ends differ only where the feed states them apart.
 */
export function getTripCallInstant(
  call: TripCall | undefined,
  end: "arrival" | "departure" = "departure",
): number | undefined {
  if (!call) return undefined;
  const scheduled =
    end === "arrival"
      ? (call.scheduledArrivalTime ?? call.scheduledDepartureTime)
      : (call.scheduledDepartureTime ?? call.scheduledArrivalTime);
  const scheduledInstant = scheduled ? Date.parse(scheduled) : Number.NaN;
  if (!Number.isFinite(scheduledInstant)) return undefined;
  const delayMinutes =
    (end === "arrival" ? (call.arrivalDelayMinutes ?? call.delayMinutes) : call.delayMinutes) ?? 0;
  return scheduledInstant + delayMinutes * 60_000;
}

/** The calls ahead of the board this departure was read from. */
export const getCallsAfterCurrentStop = (departure: Departure): readonly TripCall[] =>
  getCallsAfterStop(departure, departure.boardingLocalStopId);

/** The stretch all these routes share; a route that stops short ends it. */
export type CommonCallPrefixAlignment = {
  /** The shared calls, keeping the most calls any sequence published at a repeated stop. */
  calls: readonly TripCall[];
  /** How many calls of each input sequence the shared prefix consumed. */
  consumedCallCounts: readonly number[];
};

/**
 * The shared prefix of several routes, aligned by stop rather than position. Consecutive calls of
 * one stop compare as one visit (two platforms at Marktplatz on one line, one on another), and the
 * sequence with the most calls there is kept.
 */
export function getCommonCallPrefixAlignment(
  sequences: readonly (readonly TripCall[])[],
): CommonCallPrefixAlignment {
  const consumedCallCounts = sequences.map(() => 0);
  const calls: TripCall[] = [];
  while (sequences.length > 0) {
    const nextCalls = sequences.map((sequence, index) => sequence[consumedCallCounts[index]]);
    const first = nextCalls[0];
    if (!first || nextCalls.some((call) => !call || getCallKey(call) !== getCallKey(first))) break;

    const key = getCallKey(first);
    const runs = sequences.map((sequence, index) => {
      const start = consumedCallCounts[index];
      let end = start;
      while (sequence[end] && getCallKey(sequence[end]) === key) end += 1;
      consumedCallCounts[index] = end;
      return sequence.slice(start, end);
    });
    const longest = runs.reduce((kept, run) => (run.length > kept.length ? run : kept), runs[0]);
    calls.push(...longest);
  }
  return { calls, consumedCallCounts };
}

export function getCommonCallPrefix(
  sequences: readonly (readonly TripCall[])[],
): readonly TripCall[] {
  return getCommonCallPrefixAlignment(sequences).calls;
}

/** Only a whole-trip exception overrules the stop's own row. */
const isExceptionalStatus = (status: DepartureStatus): boolean =>
  status === "cancelled" || status === "diverted";

/**
 * One stop's row completed by another reading of the same run, as a `Departure`. That reading adds
 * its sequence, dated identity and any whole-run exception; its stop facts are dropped
 * (`toRunSequence`).
 */
export function mergeRunReading(row: Departure, reading: Departure | undefined): Departure {
  if (!reading) return row;
  const merged = mergeRunSequence(row, toRunSequence(reading));
  return {
    ...merged,
    tripInstanceId: reading.tripInstanceId ?? merged.tripInstanceId,
    status: isExceptionalStatus(reading.status) ? reading.status : merged.status,
  };
}

/**
 * The sequence a departure carries, without its stop facts; nothing where it has no calls.
 */
export function toRunSequence(departure: Departure): RunSequence | undefined {
  if (!departure.tripCalls?.length) return undefined;
  return {
    tripCalls: departure.tripCalls,
    ...(departure.tripInstanceId ? { tripInstanceId: departure.tripInstanceId } : {}),
    status: departure.status,
    ...(departure.readAt?.coverageReadAt !== undefined
      ? { coverageReadAt: departure.readAt.coverageReadAt }
      : {}),
    ...(departure.readAt?.sequenceReadAt !== undefined
      ? { readAt: departure.readAt.sequenceReadAt }
      : {}),
  };
}

/**
 * A stop row completed by a separately read run. The row keeps its countdown, platform and delay;
 * the sequence adds calls, dated identity and whole-run cancellation or diversion. Each half keeps
 * its own read time (`Departure.readAt`).
 */
export function mergeRunSequence(row: Departure, sequence: RunSequence | undefined): Departure {
  if (!sequence) return row;
  const readAt = resolveMergedReadingTimes(row, sequence);
  return {
    ...row,
    tripInstanceId: sequence.tripInstanceId ?? row.tripInstanceId,
    status: isExceptionalStatus(sequence.status) ? sequence.status : row.status,
    tripCalls: sequence.tripCalls,
    ...(readAt ? { readAt } : {}),
  };
}

/**
 * Each half's read time. A row without one takes the sequence's; nothing where neither was stamped
 * (fixtures).
 */
function resolveMergedReadingTimes(
  row: Departure,
  sequence: RunSequence,
): DepartureReadingTimes | undefined {
  const rowReadAt = row.readAt?.rowReadAt ?? sequence.readAt;
  if (rowReadAt === undefined) return undefined;
  return {
    rowReadAt,
    ...(sequence.readAt !== undefined ? { sequenceReadAt: sequence.readAt } : {}),
    ...(sequence.coverageReadAt !== undefined ? { coverageReadAt: sequence.coverageReadAt } : {}),
  };
}

/** An unconfirmed contiguous excerpt updates its calls without deleting known route coverage. */
export function retainRunCoverage(
  previous: RunSequence | undefined,
  incoming: RunSequence,
): RunSequence {
  if (!previous || statesRunEnd(incoming.tripCalls.at(-1))) return incoming;
  const anchors = alignSameRouteCalls(previous.tripCalls, incoming.tripCalls);
  if (anchors.length !== incoming.tripCalls.length || anchors.length === 0) return incoming;
  const first = anchors[0][0];
  const last = anchors.at(-1)![0];
  if (
    last - first + 1 !== incoming.tripCalls.length ||
    incoming.tripCalls.length >= previous.tripCalls.length
  )
    return incoming;
  const coverageReadAt = previous.coverageReadAt ?? previous.readAt;
  return {
    ...incoming,
    ...(first > 0 && previous.tripInstanceId ? { tripInstanceId: previous.tripInstanceId } : {}),
    tripCalls: [
      ...previous.tripCalls.slice(0, first),
      ...incoming.tripCalls,
      ...previous.tripCalls.slice(last + 1),
    ],
    ...(coverageReadAt !== undefined ? { coverageReadAt } : {}),
  };
}
