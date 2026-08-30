import type { Departure } from "../data/transit-types";
import { getVehicleTripKey } from "./trips";

/**
 * Placing a vehicle mark, and moving it.
 *
 * Every departure carries its whole trip: each calling point with a scheduled time to the second
 * and its own realtime deviation. A mark is therefore not guessed from a single prediction and an
 * assumed running time — it is read off the trip, between the last call the vehicle has left and
 * the next one it is due at. Where the trip says nothing — a call with no realtime, a gap between
 * boards — no mark is placed. An absent mark is honest; an invented one is not.
 *
 * How a mark *moves* is a second question, and a presentational one. The feed states times, not
 * motion, and those times are revised: a refresh can add three minutes to a call the mark has
 * already run most of the way towards, and the device's own clock reading of the feed's clock steps
 * back a little every time a fresher board arrives. Following such a revision literally drags the
 * mark backwards down the track, which is the one thing a train never does and the one thing a
 * rider reads instantly as the diagram being unsure of itself.
 *
 * So the mark travels forward only. It stands at calls, spends each link's estimated running time
 * on it, and catches a forward correction up at a bounded pace rather than teleporting. A backward
 * correction is not followed at all — the mark simply waits where it is until the revised trip
 * catches up with it, which is what the vehicle it stands for is doing too.
 *
 * Two words, kept apart on purpose: a *call position* is one continuous coordinate along the trip's
 * calls — the form the motion works in — and a *placement* is what a diagram draws, the two stops
 * with the progress between them.
 */

/** Where a vehicle is: between two calling points, and how far along. */
export type TripPlacement = {
  fromStopId: string;
  toStopId: string;
  /** 0 at the stop behind, 1 at the stop ahead. Stays at 0 while the vehicle is standing. */
  progress: number;
};

/**
 * A train stands at a stop. Feeds routinely give a call one time for both arrival and departure, so
 * taking them literally would run every train through every platform without pausing.
 */
const MIN_DWELL_MS = 20_000;
/** …but a stand invented on a short link would eat the run, so it never takes more than this of it. */
const MAX_DWELL_SHARE = 0.3;
/** A correction may catch up, but never at more than this multiple of the trip's estimated pace. */
const MAX_FORWARD_SPEED_RATIO = 1.15;
/** A trip unseen for this long has stopped being tracked; its next position starts fresh. */
const TRIP_MOTION_STALE_MS = 120_000;
/** Trips remembered for smoothing before the untouched ones are swept out. */
const TRIP_MOTION_CAPACITY = 256;
/** This close to the trip's own position, the mark has arrived and stops trailing it. */
const SETTLED_TOLERANCE = 0.005;

const toInstant = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

type TimedCall = { stopId: string; arrival: number; departure: number };

/** Shifts in milliseconds: one pair per calling point, one number for each end of the call. */
type CallShift = { arrival: number; departure: number };

/** One calling point before its deviations are resolved: the schedule, and what the feed said. */
type ScheduledCall = {
  stopId: string;
  scheduledArrival: number;
  scheduledDeparture: number;
  /**
   * What the feed states for this call, or nothing where it monitors none of it. The two ends are
   * one fact or no fact: a call the feed says anything about states both, because a deviation
   * given for one end describes the other until the feed itself separates them.
   */
  statedShift?: CallShift;
  /** The one call this departure was actually read at, whose row is the freshest fact in hand. */
  isBoardingCall: boolean;
};

/**
 * The call the board row itself describes: the one the producing board marked, or failing that the
 * one that resolves to the stop the row was read at.
 */
function findBoardingCallIndex(departure: Departure): number {
  const calls = departure.tripCalls ?? [];
  const marked = calls.findIndex((call) => call.isCurrentStop);
  return marked >= 0
    ? marked
    : calls.findIndex((call) => call.localStopId === departure.boardingStopId);
}

/** Calls that can carry a mark: a known stop, a known row in the diagram, and a known time. */
function getScheduledCalls(departure: Departure): ScheduledCall[] {
  const boardingIndex = findBoardingCallIndex(departure);
  return (departure.tripCalls ?? []).flatMap((call, index) => {
    if (!call.localStopId) return [];
    const arrival = toInstant(call.scheduledArrivalTime);
    const departureTime = toInstant(call.scheduledDepartureTime);
    const time = departureTime ?? arrival;
    if (time === undefined) return [];
    // A call stating one deviation states it about both of its ends; two are only ever kept apart
    // where the feed itself keeps them apart.
    const arrivalDelay = call.arrivalDelayMinutes ?? call.delayMinutes;
    const departureDelay = call.delayMinutes ?? call.arrivalDelayMinutes;
    return [
      {
        stopId: call.localStopId,
        scheduledArrival: arrival ?? time,
        scheduledDeparture: departureTime ?? time,
        statedShift:
          arrivalDelay === undefined || departureDelay === undefined
            ? undefined
            : { arrival: arrivalDelay * 60_000, departure: departureDelay * 60_000 },
        isBoardingCall: index === boardingIndex,
      },
    ];
  });
}

/**
 * A deviation for every call, carried across the ones the feed does not monitor.
 *
 * Only part of a run is monitored: a sequence routinely states a deviation for the calls near the
 * vehicle and nothing at all for the rest. Reading an unmonitored call as *on time* is not the
 * neutral choice it looks like — it is a claim that the vehicle makes up its whole delay on the
 * next link, and the times it produces run backwards, which had a mark cross those links at the
 * dwell floor and sprint away down the line. A delay in fact persists until it is recovered, and
 * the feed says so by restating it, so the last stated deviation is carried forward and the first
 * one is carried back over the calls before it.
 */
function resolveCallShifts(calls: readonly ScheduledCall[]): CallShift[] {
  const shifts: CallShift[] = [];
  let carried = 0;
  for (const call of calls) {
    const shift = call.statedShift ?? { arrival: carried, departure: carried };
    carried = shift.departure;
    shifts.push({ ...shift });
  }
  const firstStated = calls.findIndex((call) => call.statedShift !== undefined);
  for (let index = 0; index < firstStated; index += 1) {
    shifts[index] = { ...shifts[firstStated] };
  }
  return shifts;
}

/**
 * The deviation the board row states at its own stop, which is the freshest fact about this vehicle
 * that exists anywhere in the reading.
 *
 * A row is re-read on the board's own cadence; the calling sequence behind it is a separate reading
 * on a slower one, so on most refreshes the row knows something the sequence does not yet. The same
 * rule the rest of the app follows — the stop row is the statement about when this vehicle leaves
 * *here* — decides it, and the difference is carried down the rest of the run, exactly as an
 * unmonitored call carries the last stated deviation.
 *
 * It holds only while that departure is still ahead. A row is a *prediction* about a vehicle that
 * has not left yet, which is the only kind of row a departure board carries; once the vehicle has
 * gone, the same fields are a record of something that already happened, and a retained trip keeps
 * restating them long after. Carrying that down the rest of the run would let a reading from four
 * stops back overrule the deviations the sequence states ahead of the vehicle — worst exactly where
 * the sequence is freshest, on a ride being re-read on its own.
 */
function getRowDepartureShift(
  departure: Departure,
  boardingCall: ScheduledCall | undefined,
  sequenceShift: CallShift | undefined,
  feedNow: number,
): number | undefined {
  if (!boardingCall || !sequenceShift) return undefined;
  const predicted = toInstant(departure.predictedDepartureTime);
  const scheduled = toInstant(departure.scheduledDepartureTime);
  const stated =
    predicted ??
    (scheduled === undefined || departure.delayMinutes === undefined
      ? undefined
      : scheduled + departure.delayMinutes * 60_000);
  if (stated === undefined) return undefined;
  // Both accounts have to put the departure behind us before the row is treated as history: a row
  // saying the vehicle is still here is precisely the correction worth having when the sequence has
  // already let it go.
  const sequenceDeparture = boardingCall.scheduledDeparture + sequenceShift.departure;
  if (Math.max(stated, sequenceDeparture) < feedNow) return undefined;
  // Counted against the row's own published time rather than the call's: a stop complex can publish
  // the row at one of its stop points and time the sequence at another.
  return stated - boardingCall.scheduledDeparture;
}

/**
 * The calls a mark travels along: real times, in order, and never running backwards.
 *
 * The clamp is the last step and it is not cosmetic. Deviations arrive per call and per end, from
 * readings of different ages, and nothing in the feed guarantees that they compose into a sequence
 * a vehicle could actually run: a call revised later than the one behind it can be timed before it.
 * A link of negative length has no pace to travel at, so the mark would cover it at the dwell
 * floor. Held to the call behind it, such a link becomes what it really is — no time at all — and
 * the mark stands where it is until the next call is due.
 */
function getTimedCalls(departure: Departure, feedNow: number): TimedCall[] {
  const calls = getScheduledCalls(departure);
  const shifts = resolveCallShifts(calls);
  const boardingIndex = calls.findIndex((call) => call.isBoardingCall);
  const rowShift = getRowDepartureShift(
    departure,
    calls[boardingIndex],
    shifts[boardingIndex],
    feedNow,
  );
  if (rowShift !== undefined) {
    const correction = rowShift - shifts[boardingIndex].departure;
    for (let index = boardingIndex; index < shifts.length; index += 1) {
      shifts[index] = {
        // The row says when the vehicle leaves this stop, not when it reached it: the call it is
        // already standing at keeps its own arrival, and every call ahead takes the correction.
        arrival: shifts[index].arrival + (index === boardingIndex ? 0 : correction),
        departure: shifts[index].departure + correction,
      };
    }
  }

  const timed: TimedCall[] = [];
  let earliest = Number.NEGATIVE_INFINITY;
  for (const [index, call] of calls.entries()) {
    const arrival = Math.max(earliest, call.scheduledArrival + shifts[index].arrival);
    const callDeparture = Math.max(arrival, call.scheduledDeparture + shifts[index].departure);
    earliest = callDeparture;
    const previous = timed[timed.length - 1];
    if (previous?.stopId === call.stopId) {
      // A detailed sequence and the board row can describe the same physical stop twice. Keep
      // the first arrival and last departure so a turning terminus still retains its dwell, but
      // never make the duplicate platform observation into a link the diagram could traverse.
      previous.arrival = Math.min(previous.arrival, arrival);
      previous.departure = Math.max(previous.departure, callDeparture);
    } else {
      timed.push({ stopId: call.stopId, arrival, departure: callDeparture });
    }
  }
  return timed;
}

/**
 * When the vehicle is taken to pull out of `here`: never before the trip says it departs, never the
 * same instant it arrived, and never so late that it has no time left to reach `next`.
 */
function getStandingEnd(here: TimedCall, next: TimedCall): number {
  const gap = Math.max(0, next.arrival - here.arrival);
  return Math.max(here.departure, here.arrival + Math.min(MIN_DWELL_MS, gap * MAX_DWELL_SHARE));
}

/** How long the vehicle has to cover the link that starts at `index`, standing time excluded. */
function getLinkDuration(calls: readonly TimedCall[], index: number): number {
  const here = calls[Math.min(calls.length - 2, Math.max(0, index))];
  const next = calls[Math.min(calls.length - 1, Math.max(1, index + 1))];
  return Math.max(MIN_DWELL_MS, next.arrival - getStandingEnd(here, next));
}

/** Where the trip itself says the vehicle is, as one coordinate along its calls. */
function findCallPosition(calls: readonly TimedCall[], feedNow: number): number | null {
  if (calls.length < 2) return null;
  if (feedNow < calls[0].arrival || feedNow > calls[calls.length - 1].departure) return null;

  for (let index = 0; index < calls.length - 1; index += 1) {
    const here = calls[index];
    const next = calls[index + 1];
    if (feedNow > next.arrival) continue;

    // Standing at the stop: the mark belongs on the stop, not part-way down the next link.
    const standingEnd = getStandingEnd(here, next);
    if (feedNow <= standingEnd) return index;

    // The timetable gives the best speed estimate in hand. Keeping this linear makes the mark spend
    // the whole available running time on the link; CSS supplies the visual easing between clock
    // ticks without making it race through the middle of the link.
    const run = next.arrival - standingEnd;
    return index + (run > 0 ? clampUnit((feedNow - standingEnd) / run) : 1);
  }

  return null;
}

/** A call position read back as the link it falls on. */
function getPlacementAtCallPosition(
  calls: readonly TimedCall[],
  callPosition: number,
): TripPlacement {
  const index = Math.min(calls.length - 2, Math.max(0, Math.floor(callPosition)));
  return {
    fromStopId: calls[index].stopId,
    toStopId: calls[index + 1].stopId,
    progress: clampUnit(callPosition - index),
  };
}

type TripMotion = {
  /** The stop the mark was last measured from, so a re-cut sequence of calls can be rebased. */
  anchorStopId: string;
  /** The other end of that link, so a repeated stop id or a trimmed trip can still be rebased. */
  anchorNextStopId: string;
  /**
   * How far along *that link* the mark stood: 0 at the stop behind, 1 at the stop ahead.
   *
   * Kept as a place on the named link rather than as a coordinate along one particular reading's
   * calls, because it is read back against a sequence that may have been re-cut in between — which
   * is exactly when a bare number stops meaning what it meant.
   */
  linkProgress: number;
  /** The latest feed clock this mark has been drawn against. Never runs backwards. */
  shownAt: number;
  shown: TripPlacement;
};

/**
 * One record per train, shared by every diagram on screen: the same vehicle must not brake into
 * Marktplatz in one of them while still running towards it in another.
 */
const tripMotions = new Map<string, TripMotion>();

function sweepTripMotions(feedNow: number) {
  if (tripMotions.size <= TRIP_MOTION_CAPACITY) return;
  for (const [key, motion] of tripMotions) {
    if (feedNow - motion.shownAt > TRIP_MOTION_STALE_MS) tripMotions.delete(key);
  }
}

/**
 * The remembered position, read against the calls in hand.
 *
 * A board refresh can cut the trip short, extend it, or state calls the last reading ran straight
 * through, so the position is rebased onto the link it was actually measured on rather than onto
 * the number that link happened to have. What is carried across is the ground the mark stood on:
 * a mark half-way from Europaplatz to Kronenplatz is still half-way from Europaplatz to
 * Kronenplatz when a fresher reading times the Marktplatz call between them — half a link in the
 * old reading and a whole one in the new. Carrying the number instead put it back at Marktplatz,
 * which is a train reversing between two stops it is running between.
 *
 * Where neither end of the link survives there is nothing to move from.
 */
function rebaseCallPosition(calls: readonly TimedCall[], motion: TripMotion): number | null {
  const { linkProgress, anchorStopId, anchorNextStopId } = motion;
  const linkIndex = calls.findIndex(
    (call, index) => call.stopId === anchorStopId && calls[index + 1]?.stopId === anchorNextStopId,
  );
  if (linkIndex >= 0) return linkIndex + linkProgress;

  const anchorIndex = calls.findIndex((call) => call.stopId === anchorStopId);
  if (anchorIndex >= 0) {
    // The same two stops with calls now timed between them: the link the mark is on has become
    // several, and the mark keeps its share of the whole of it.
    const farIndex = calls.findIndex(
      (call, index) => index > anchorIndex && call.stopId === anchorNextStopId,
    );
    const span = farIndex > anchorIndex ? farIndex - anchorIndex : 1;
    return anchorIndex + linkProgress * span;
  }

  // The link begins outside this trimmed observation. Only its far end is left, and only once the
  // mark is nearer to that end than to the one that is gone; never retain a negative coordinate.
  if (linkProgress <= 0.5) return null;
  const nextIndex = calls.findIndex((call) => call.stopId === anchorNextStopId);
  return nextIndex < 0 ? null : Math.max(0, nextIndex - (1 - linkProgress));
}

/**
 * Walk forward towards a revised estimate, each link's estimated duration setting the pace. Unlike
 * an interpolation this can cross any number of calls without teleporting over the ones between.
 */
function advanceCallPosition(
  calls: readonly TimedCall[],
  from: number,
  target: number,
  elapsed: number,
): number {
  let position = from;
  let remaining = elapsed * MAX_FORWARD_SPEED_RATIO;

  while (remaining > 0 && position < target - SETTLED_TOLERANCE) {
    // `Math.floor(position) + 1` is always strictly ahead, so every pass covers ground and the walk
    // terminates.
    const index = Math.min(calls.length - 2, Math.floor(position));
    const boundary = Math.min(target, Math.floor(position) + 1);
    const duration = getLinkDuration(calls, index);
    const required = (boundary - position) * duration;
    if (required > remaining) return position + remaining / duration;
    position = boundary;
    remaining -= required;
  }

  return position >= target - SETTLED_TOLERANCE ? target : position;
}

/** The position to show: the trip's own, approached from where the mark was last drawn — forward only. */
function getShownCallPosition(
  calls: readonly TimedCall[],
  target: number,
  previous: TripMotion | undefined,
  feedNow: number,
): number {
  // Nothing to move from, or the mark has been out of sight long enough that where it stood says
  // nothing about where it is: the trip's own reading is the honest place to start.
  if (!previous || feedNow - previous.shownAt >= TRIP_MOTION_STALE_MS) return target;

  const from = rebaseCallPosition(calls, previous);
  if (from === null) return target;
  // A revision that puts the vehicle behind the mark — a fresh delay, or simply a newer board
  // stating a feed clock a few seconds earlier than the one extrapolated from the last — is served
  // by standing still. The mark keeps its ground and the trip catches up with it.
  if (target <= from) return from;
  return advanceCallPosition(calls, from, target, Math.max(0, feedNow - previous.shownAt));
}

/**
 * The placement as it should be *shown* at `feedNow`: the trip's own position, approached rather than
 * snapped to, so a revised deviation moves the mark into its new place at a plausible pace.
 *
 * Repeated calls for the same trip at the same `feedNow` give the same answer, so several diagrams — or
 * a re-render — read one motion instead of each advancing it.
 */
export function getSmoothTripPlacement(
  departure: Departure,
  feedNow: number,
): TripPlacement | null {
  const key = getVehicleTripKey(departure);
  const previous = tripMotions.get(key);
  if (previous && previous.shownAt === feedNow) return previous.shown;

  if (departure.status === "cancelled") {
    tripMotions.delete(key);
    return null;
  }

  const calls = getTimedCalls(departure, feedNow);
  const target = findCallPosition(calls, feedNow);
  if (target === null) {
    tripMotions.delete(key);
    return null;
  }

  const callPosition = getShownCallPosition(calls, target, previous, feedNow);
  const shown = getPlacementAtCallPosition(calls, callPosition);
  const anchorIndex = Math.min(calls.length - 2, Math.max(0, Math.floor(callPosition)));
  tripMotions.set(key, {
    anchorStopId: calls[anchorIndex].stopId,
    anchorNextStopId: calls[anchorIndex + 1].stopId,
    // Measured against the link that is being remembered, which at the end of the sequence is the
    // last one rather than the one the coordinate's own whole number would name.
    linkProgress: callPosition - anchorIndex,
    // The clock a mark is drawn against only ever moves on, so a board that arrives stating a
    // slightly earlier feed time cannot hand the next tick a longer step to travel.
    shownAt: Math.max(previous?.shownAt ?? feedNow, feedNow),
    shown,
  });
  sweepTripMotions(feedNow);

  return shown;
}

/** Soonest passage first, so a capped diagram keeps the marks a rider is about to care about. */
export function createSoonestPassageComparator(feedNow: number) {
  const wait = (departure: Departure) =>
    Math.abs(Date.parse(departure.scheduledDepartureTime) - feedNow);
  return (a: Departure, b: Departure) => wait(a) - wait(b);
}
