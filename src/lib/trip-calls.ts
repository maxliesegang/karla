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
    departure.boardingStopId === stopId ? calls.findIndex((call) => call.isCurrentStop) : -1;
  return getCallsPastIndex(
    calls,
    markedCurrentIndex >= 0
      ? markedCurrentIndex
      : calls.findIndex((call) => call.localStopId === stopId),
  );
}

/**
 * The onward calls past one call of a sequence, with the repeats a stop complex reports removed.
 *
 * Split out from the departure-shaped reading above because a sequence is not always held by a
 * departure: a corridor pattern and a drawn diagram both ask what a trip does past a stop, and the
 * two answers are only comparable if the same repeats were dropped from each.
 */
export function getCallsPastIndex(
  calls: readonly TripCall[],
  currentIndex: number,
): readonly TripCall[] {
  if (currentIndex < 0 || currentIndex >= calls.length) return [];
  const stopId = calls[currentIndex].localStopId;

  // A stop complex can occur as several consecutive provider stop points in one sequence. They all
  // resolve to the same local stop, so none is an outgoing link: Hauptfriedhof currently reports
  // the marked platform followed by another Hauptfriedhof entry in both directions.
  let nextIndex = currentIndex + 1;
  while (calls[nextIndex]?.localStopId === stopId) nextIndex += 1;
  // The same happens everywhere ahead of it, and it is loudest at a terminus: a trip that turns
  // back is reported at the platform it arrives on and again at the one it leaves from. Those are
  // one call of the route, and left as two they make a short working stop looking like a prefix of
  // the through service it turns back out of — the two ends of S2 read as one nameless corridor
  // pointing at the place they part rather than as Rheinstrandsiedlung and Rheinstetten.
  return calls
    .slice(nextIndex)
    .filter(
      (call, index, onward) => index === 0 || getCallKey(onward[index - 1]) !== getCallKey(call),
    );
}

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
  getCallsAfterStop(departure, departure.boardingStopId);

/**
 * The stretch every one of these routes runs in common, which is how far trips grouped together are
 * known to stay together. A route that stops short of the others ends the common stretch there.
 */
export function getCommonCallPrefix(
  sequences: readonly (readonly TripCall[])[],
): readonly TripCall[] {
  const first = sequences[0] ?? [];
  const divergenceIndex = first.findIndex((call, index) =>
    sequences.some((sequence) => {
      const other = sequence[index];
      return !other || getCallKey(other) !== getCallKey(call);
    }),
  );
  return divergenceIndex < 0 ? first : first.slice(0, divergenceIndex);
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
