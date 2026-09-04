import type { Departure, DepartureStatus, TripCall } from "../data/transit-types";

/**
 * A trip's remaining calling points, read from the stop it was read at.
 *
 * Every question this app asks of a calling sequence — are these two trips taking the same route,
 * how far do they run together, which way does this one leave — is asked from one stop looking
 * outwards, so a sequence here always begins at the call after that stop. Comparing two of them is
 * comparing what the feed calls their stops, which is a resolved local id where we have one and the
 * feed's own place and name where we do not.
 */

/** How a calling point is identified, including where the feed resolved no local stop of ours. */
export const getCallKey = (call: TripCall): string =>
  call.localStopId ?? `${call.placeName ?? ""}:${call.stopName}`;

/**
 * How many calls of one stop each call belongs to — one nearly everywhere, more where a route
 * reaches a stop twice in a row.
 *
 * The number is what says whether the platform on a call means anything to a comparison. At a stop
 * a route passes once, the platform is a fact about the trip that happened to be read: two trips
 * of one line may use two platforms there, and neither is more the line's than the other. At a
 * stop a route calls at twice, it is the only thing that says which of the two calls this is.
 */
function getRepeatedCallCounts(calls: readonly TripCall[]): number[] {
  const lengths = Array<number>(calls.length).fill(1);
  for (let start = 0; start < calls.length; ) {
    let end = start + 1;
    while (end < calls.length && getCallKey(calls[end]) === getCallKey(calls[start])) end += 1;
    for (let index = start; index < end; index += 1) lengths[index] = end - start;
    start = end;
  }
  return lengths;
}

/**
 * Whether a call of one reading and a call of another are the same call of the route.
 *
 * The stop is the whole of the question until a route reaches one stop twice, and then it is not
 * enough: Europaplatz publishes its two street platforms under one stop point and one name, so
 * nothing on the calls tells `Gleis 3` from `Gleis 5` a minute later. Matched on the stop alone, a
 * reading holding one of them anchors to whichever came first and the other is read in beside it —
 * the stop drawn twice, both times as the same platform.
 *
 * So the platform is consulted, and only where one of the two readings really does repeat the stop.
 * Everywhere else it would be the wrong question asked of a true answer: a diverted working leaves
 * from another platform than the timetabled one, and a stop both readings agree on would stop
 * matching itself.
 */
function isSameRouteCall(
  left: TripCall,
  right: TripCall,
  /** Whether either reading reaches this stop more than once, which is the only time it matters. */
  hasRepeatedCalls: boolean,
): boolean {
  if (getCallKey(left) !== getCallKey(right)) return false;
  if (!hasRepeatedCalls) return true;
  const leftPlatform = left.platformCode ?? left.platformLabel;
  const rightPlatform = right.platformCode ?? right.platformLabel;
  // Where either reading states no platform there is nothing to tell them apart by, and the stop
  // is the best answer there is.
  return !leftPlatform || !rightPlatform || leftPlatform === rightPlatform;
}

/**
 * Which calls of two readings of one route are the same call, in order.
 *
 * A longest common subsequence rather than a lookup keyed to the physical stop, because such a key
 * holds only one call per stop: where a route reaches one stop twice — Marktplatz's Kaiserstraße
 * and Pyramide, a loop passing the same stop on the way back — the earlier call answers for both,
 * and the two readings anchor to each other in the wrong place. Aligning the sequences instead
 * gives every call of a repeated stop its own anchor, or none.
 *
 * The sequences are one route's calls, so both are tens of entries long and the matrix is small.
 */
export function alignSameRouteCalls(
  left: readonly TripCall[],
  right: readonly TripCall[],
): readonly (readonly [leftIndex: number, rightIndex: number])[] {
  const leftRepeatCounts = getRepeatedCallCounts(left);
  const rightRepeatCounts = getRepeatedCallCounts(right);
  const isSameCall = (leftIndex: number, rightIndex: number) =>
    isSameRouteCall(
      left[leftIndex],
      right[rightIndex],
      leftRepeatCounts[leftIndex] > 1 || rightRepeatCounts[rightIndex] > 1,
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

/** One string standing for a whole route, so two routes are compared in a single operation. */
export const getCallSequenceKey = (calls: readonly TripCall[]): string =>
  calls.map(getCallKey).join(">");

/**
 * The calls a trip makes after the given stop, or none where this reading does not reach it.
 *
 * The board that produced a departure marks its own call, and a departure read elsewhere is located
 * by the local id instead — the same trip seen from two boards must yield the same route onwards.
 */
export function getCallsAfterStop(departure: Departure, stopId: string): readonly TripCall[] {
  const calls = departure.tripCalls ?? [];
  const markedCurrentIndex =
    departure.boardingLocalStopId === stopId ? calls.findIndex((call) => call.isCurrentStop) : -1;
  return getCallsPastIndex(
    calls,
    markedCurrentIndex >= 0
      ? markedCurrentIndex
      : calls.findIndex((call) => call.localStopId === stopId),
  );
}

/**
 * The published calls past one call of a sequence, without rewriting the provider's sequence.
 *
 * Split out from the departure-shaped reading above because a sequence is not always held by a
 * departure: corridor comparison and a drawn diagram both ask what a trip does past a stop.
 */
export function getCallsPastIndex(
  calls: readonly TripCall[],
  currentIndex: number,
): readonly TripCall[] {
  if (currentIndex < 0 || currentIndex >= calls.length) return [];
  return calls.slice(currentIndex + 1);
}

/** The first call that leaves a stop complex, without removing any calls from the sequence. */
export const findFirstCallBeyondStop = (
  calls: readonly TripCall[],
  stopId: string,
): TripCall | undefined => calls.find((call) => call.localStopId !== stopId);

/**
 * The stops a route visits, in order, with a stop stated over several consecutive calls counted
 * once — the shape of the route rather than its published calls, which is what topology compares.
 */
export function getVisitedStopKeys(calls: readonly TripCall[]): string[] {
  const keys: string[] = [];
  for (const call of calls) {
    const key = getCallKey(call);
    if (keys.at(-1) !== key) keys.push(key);
  }
  return keys;
}

/**
 * The same calls with a turnaround's two halves read as the one call they are.
 *
 * A vehicle that begins or ends a run is reported at the track it stands on and again at the
 * platform the public uses, which is one call of the route stated twice and no link a rider
 * travels. Every other repeat of a stop is a real one — Europaplatz's two street platforms are a
 * minute of driving apart, and the S1 crosses between Marktplatz's two tunnels — so only the pair
 * the feed itself marks as a run boundary is folded.
 *
 * The call on the route-facing side is the one kept: at a start that is the second call, where the
 * public departure happens; at an end it is the first, where passengers arrive. The outer call is
 * the turning track. Its missing arrival/departure is copied onto the kept call so it remains an
 * honest run boundary for any reader of the collapsed sequence. This is visible at Hirtenweg:
 * line 4 is timed out of non-boarding Gleis 3, then departs for passengers from Gleis 1. Keeping the
 * boundary-bearing half printed Gleis 3 and 08:46 for a board row that says Gleis 1 and 08:47.
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

    // Diagrams read a trip in the opposite direction from its published sequence, so neither the
    // boundary nor the public half is assumed to be on one particular side of the pair.
    const boundary = statesRunBoundary(call) ? call : next;
    const publicCall = boundary === call ? next : call;
    const merged: TripCall = statesRunStart(boundary)
      ? // Keep the public departure, but also the feed's statement that the run begins here.
        { ...publicCall, scheduledArrivalTime: undefined }
      : // Keep the public arrival, but also the feed's statement that the run ends here.
        {
          ...publicCall,
          scheduledDepartureTime: undefined,
          delayMinutes: publicCall.arrivalDelayMinutes ?? publicCall.delayMinutes,
        };
    delete merged.arrivalDelayMinutes;
    if (call.isCurrentStop || next.isCurrentStop) merged.isCurrentStop = true;
    else delete merged.isCurrentStop;
    kept.push(merged);
    index += 1;
  }
  return kept;
}

/**
 * Whether two consecutive calls of one stop are a vehicle turning round rather than travelling.
 *
 * The pair the feed itself marks, and only that pair. A run that begins somewhere is timed out of
 * its origin and into nothing (`statesRunStart`); one that ends is timed in and out of nothing. Any
 * pair straddling such a mark is one call of the route reported at the track the vehicle stands on
 * and at the platform the public uses.
 *
 * Two calls both fully timed are the opposite statement: the vehicle arrived at the first, left it,
 * and arrived at the second, which is a minute of driving and two places to stand. Europaplatz's
 * `Gleis 3` at 08:57/08:58 and `Gleis 5` at 08:58/08:59 are that, and so — 147 m apart — are
 * Entenfang's `Gleis 5` and `Gleis 3`.
 *
 * The board's own call is never read as a boundary. The sequence omits it entirely and the row
 * completes only its departure, so it arrives at every reading looking exactly like the origin of a
 * run whether or not it is one. Read as one it would part a stop in two from one side and not from
 * the other, so the same pair would separate or not by which of its two rows was read. An unknown
 * is not a mark, and the marks are what this is about.
 */
export function isTurnaroundPair(previous: TripCall, call: TripCall): boolean {
  if (getCallKey(previous) !== getCallKey(call)) return false;
  return statesRunBoundary(previous) || statesRunBoundary(call);
}

/** A mark of a run boundary the feed made, on a call whose own reading did not swallow it. */
const statesRunBoundary = (call: TripCall): boolean =>
  !call.isCurrentStop && (statesRunStart(call) || statesRunEnd(call));

/**
 * Whether the feed itself says a run begins or ends at this call, rather than our reading of it.
 *
 * A vehicle that terminates somewhere is timed into the stop and out of nothing: EFA marks that
 * call `depValid=0` and publishes no departure time for it, and the origin of a run is the same
 * statement the other way round (`arrValid=0`, no arrival time — see `docs/kvv-efa-api.md`). The
 * parser drops the time it invalidates, so a missing end here *is* the feed's statement.
 *
 * The distinction matters wherever a view is about to call something an end of a line. The end of
 * the calls in hand is not one: a sequence read without `depType=stopEvents`, one cut short, one
 * whose remaining calls carry no usable time — each of those stops mid-route while the vehicle
 * keeps going, and treated as a terminus it puts a standing mark, or an inferred turnaround, at a
 * stop no service ends at. Only the two calls the feed marks are ends of a run.
 */
export const statesRunStart = (call: TripCall | undefined): boolean =>
  call?.scheduledDepartureTime !== undefined && call.scheduledArrivalTime === undefined;

export const statesRunEnd = (call: TripCall | undefined): boolean =>
  call?.scheduledArrivalTime !== undefined && call.scheduledDepartureTime === undefined;

/**
 * When the run these calls describe is expected to be over, or nothing where they carry no time.
 *
 * The last call's published time shifted by the deviation reported there — the feed states no
 * separate end of service, so the end of the sequence is the end of the run. Stated without a
 * grace period on purpose: how long a finished run is still worth holding is a judgement each
 * caller makes for itself, and they do not agree. A vehicle marker lets go two minutes after the
 * final call; the ride a passenger is reading is theirs for an hour more; a cached sequence is
 * worth keeping only while some view might still ask for it.
 */
export function findFinalCallInstant(calls: readonly TripCall[] | undefined): number | undefined {
  return getTripCallInstant(calls?.[calls.length - 1]);
}

/**
 * The instant one call is expected at: its published time with the deviation reported for it added
 * in. One definition, because a call the diagram calls past and one the ride counts down to must be
 * the same call — an arrival end is only read apart from a departure end where the feed itself
 * separates the two.
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

/**
 * The stretch every one of these routes runs in common, which is how far trips grouped together are
 * known to stay together. A route that stops short of the others ends the common stretch there.
 */
export type CommonCallPrefixAlignment = {
  /** The shared calls, keeping the most calls any sequence published where one stop repeats. */
  calls: readonly TripCall[];
  /** How many calls of each input sequence the shared prefix consumed. */
  consumedCallCounts: readonly number[];
};

/**
 * The shared prefix of several routes, aligned by stop rather than by array position.
 *
 * Consecutive calls resolving to the same stop remain distinct published calls. They are compared
 * as one visit, however, so a line stating two platforms at Marktplatz and another stating one can
 * still share every stop after it. Whichever sequence published the most calls at that stop is the
 * one kept, preserving both calls in a combined diagram instead of erasing one to make the
 * comparison work.
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

/** Only a whole-trip exception may overrule what the stop's own row says about this departure. */
const isExceptionalStatus = (status: DepartureStatus): boolean =>
  status === "cancelled" || status === "diverted";

/**
 * One published departure fact, completed by a trip read separately from it.
 *
 * The stop row stays the departure: its countdown, platform and delay are the freshest statement of
 * when this vehicle leaves *here*, and a trip reading is not allowed to replace them with its own
 * older copy. What the trip contributes is what a board row cannot state — the whole sequence
 * behind it, the dated identity that sequence's first call refines, and a cancellation or diversion
 * of the run as a whole.
 */
export function mergeTripSequence(row: Departure, trip: Departure | undefined): Departure {
  if (!trip) return row;
  return {
    ...row,
    tripInstanceId: trip.tripInstanceId ?? row.tripInstanceId,
    status: isExceptionalStatus(trip.status) ? trip.status : row.status,
    tripCalls: trip.tripCalls ?? row.tripCalls,
  };
}
