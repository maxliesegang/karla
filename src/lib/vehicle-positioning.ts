import type { Departure, TripCall } from "../data/transit-types";
import { collapseTurnaroundCalls, statesRunEnd, statesRunStart } from "./trip-calls";
import { getVehicleTripKey } from "./trips";

/**
 * Turns timed calls into event-driven vehicle trajectories.
 *
 * A marker has one appointment: leave the last stop after its departure and reach the next at its
 * expected arrival. Time merely evaluates that stable segment. When a refresh changes the arrival,
 * the remaining segment is re-planned from the ground already covered; no target is chased and no
 * marker moves backwards. A marker is placed back at a stop only when that stop's own realtime fact
 * says its departure is still ahead. Placements are never animated as journeys.
 */

/**
 * What a mark is doing where it stands.
 *
 * A running mark is read off the link the trip says the vehicle is on. The two standing phases are
 * the ends of the run, and they are kept apart from running because they are a weaker statement:
 * neither says a vehicle was measured anywhere. `beforeStart` is a trip the feed monitors and has
 * not begun — its terminus is where it is due out from; `afterEnd` is a trip whose own calls have
 * run out at its final one. Which vehicle turns back into which departure is not published
 * anywhere (see docs/kvv-efa-api.md), so the two are never joined into one standing vehicle.
 */
export type TripPlacementPhase = "running" | "beforeStart" | "afterEnd";

/** Where a vehicle is: between two calling points, and how far along. */
export type TripPlacement = {
  fromStopId: string;
  toStopId: string;
  /** 0 at the stop behind, 1 at the stop ahead. Stays at 0 while the vehicle is standing. */
  progress: number;
  phase: TripPlacementPhase;
  /**
   * Whether the mark got here by travelling or by being put here.
   *
   * Stated rather than inferred, because only this module knows which it was. A diagram comparing
   * two painted coordinates can see that a mark moved a long way, but not whether it moved because
   * a vehicle is making up time — which should be animated — or because the reading found it
   * somewhere else, a trip came back after a gap, or this is its first paint — none of which is a
   * journey, and all of which look like a train sliding across the diagram when animated.
   */
  motion: TripPlacementMotion;
  /**
   * The current link's motion as one appointment with its next stop.
   *
   * The renderer follows one acceleration–cruise–braking plan from `startProgress` at `startsAt`
   * and reaches the next stop at `arrivesAt`. The plan is stable while time passes; only a new feed
   * reading or the handover to the following link replaces it.
   */
  trajectory?: TripSegmentTrajectory;
};

/** See `TripPlacement.motion`. */
export type TripPlacementMotion = "travelled" | "placed";

export type TripSegmentTrajectory = {
  startProgress: number;
  startsAt: number;
  arrivesAt: number;
  /** Progress per millisecond at the start of this plan. Preserved when a prediction is revised. */
  startVelocity: number;
  /** Progress per millisecond through the long, steady middle of the link. */
  cruiseVelocity: number;
  /** End of the gentle change from `startVelocity` to `cruiseVelocity`. */
  acceleratesUntil: number;
  /** Beginning of the gentle change from `cruiseVelocity` to rest at the next stop. */
  brakesFrom: number;
  /** Feed-clock instant at which the accompanying placement was evaluated. */
  sampledAt: number;
};

/** A trip unseen for this long has stopped being tracked; its next position starts fresh. */
const TRIP_MOTION_STALE_MS = 120_000;
/** Trips remembered for smoothing before the untouched ones are swept out. */
const TRIP_MOTION_CAPACITY = 256;
/**
 * This close to the trip's own position, the mark has arrived and stops trailing it — and this
 * close to a call, it is standing at that call rather than running away from it.
 */
const SETTLED_TOLERANCE = 0.005;
/** Share of a link's available running time used to change speed at either end. */
const SEGMENT_SPEED_RAMP_SHARE = 0.15;
/**
 * How far apart two accounts of one departure must be before the newer one is information.
 *
 * A stop row publishes its times to the minute and a sequence to the second, so the same departure
 * read both ways disagrees by up to a minute without either account being wrong. Within that
 * rounding the row says nothing the sequence does not, and reading it as a correction made the
 * reading flip between "departed" and "not yet departed" across the minute boundary — the mark
 * leaping back to its terminus and away again on every refresh.
 */
const ROW_DEPARTURE_PRECISION_MS = 60_000;
/**
 * How long before a trip is due out of its first stop it is drawn standing there *on its own*.
 *
 * A terminus spends much of its day with no mark on it at all: the run that arrived has ended and
 * the next has not begun, which is exactly the turnaround a rider watching the line wants to see.
 * The trip that is due out is the one fact published about it, so it is drawn — and drawn as
 * standing, because a monitored trip that has not started is not a vehicle anybody has placed.
 *
 * The lead is measured against the departure as the feed times it, delay included, so it is the
 * real stand rather than the timetable's. It is long enough to cover an ordinary turn end to end:
 * line 3 turns at Forststraße on eleven scheduled minutes, and a turn that long is drawn from this
 * lead alone wherever no pairing was found for it — a reading that has caught only one run starting
 * at that terminus cannot measure the headway a pairing is bounded by, and falls back on a window
 * shorter than the turn (`lib/line-turnarounds.ts`). Held at six minutes the diagram
 * showed nothing at all standing at the terminus for the middle of every such turn, while a rider
 * on the platform was looking straight at the tram. A trip the feed monitors and times out of a
 * stop it is due away from within nine minutes is standing there, and that is drawn without
 * needing to know which arrival it came in on.
 *
 * A longer stand than the lead needs a second fact, and `standFrom` is it: a caller that has found
 * the arrival this departure turns out of states when that stand began, and the mark is drawn from
 * then rather than from this lead.
 *
 * Either way the stand belongs to the stop the run *starts* from, as the feed states it, and to no
 * other: see `findRunEndStops`. And a lead this long will reach back past an unrelated arrival
 * still standing at the same terminus, which is one platform holding two marks — the diagram drops
 * one of them rather than claiming two vehicles (`lib/line-diagram.ts`).
 */
const DEPARTURE_STAND_LEAD_MS = 9 * 60_000;
/**
 * How long a trip keeps its mark at its final call.
 *
 * Its calls say the vehicle is due there and say nothing after it, so the mark stands at the
 * terminus rather than vanishing at the minute it pulls in. Kept inside the grace the observation
 * itself is retained for (`lib/line-vehicle-observations.ts`), so a mark never outlives the trip
 * behind it — and only where the feed says the run ends there, since a reading that merely stops
 * short says nothing about a vehicle standing anywhere.
 */
const TERMINUS_STAND_MS = 90_000;

const toInstant = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

type TimedCall = {
  stopId: string;
  arrival: number;
  departure: number;
  /** The departure was stated at this call, rather than copied from another monitored call. */
  departureIsExplicit: boolean;
  /** The board row repeated beside a detailed sequence's copy of this same call. */
  isPublishedCurrentCall: boolean;
};

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
  /** Explicit provider marker distinguishing a duplicate board call from real same-stop travel. */
  isPublishedCurrentCall: boolean;
};

/**
 * The call the board row itself describes: the one the producing board marked, or failing that the
 * one that resolves to the stop the row was read at.
 */
function findBoardingCallIndex(departure: Departure, calls: readonly TripCall[]): number {
  const marked = calls.findIndex((call) => call.isCurrentStop);
  return marked >= 0
    ? marked
    : calls.findIndex((call) => call.localStopId === departure.boardingLocalStopId);
}

/** Calls that can carry a mark: a known stop, a known row in the diagram, and a known time. */
function getScheduledCalls(departure: Departure): ScheduledCall[] {
  // Only a repeated call explicitly marked as a run boundary is one physical stand reported twice.
  // Other consecutive calls of the same local stop can be real travel between platforms, and the
  // diagram draws that link, so the vehicle timeline must preserve it as well.
  const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
  const boardingIndex = findBoardingCallIndex(departure, calls);
  return calls.flatMap((call, index) => {
    if (!call.localStopId) return [];
    const arrival = toInstant(call.scheduledArrivalTime);
    const departureTime = toInstant(call.scheduledDepartureTime);
    const time = departureTime ?? arrival;
    if (time === undefined) return [];
    // A call stating one deviation states it about both of its ends; two are only ever kept apart
    // where the feed itself keeps them apart. The ends of a run are the exception from the other
    // side: the feed states no arrival for a run's first call and no departure for its last, so
    // there the one stated side is the whole statement — dropping it read a departure the feed was
    // tracking as one it was not, and a held-at-the-terminus vehicle read as unmonitored.
    const arrivalDelay = call.arrivalDelayMinutes ?? call.delayMinutes;
    const departureDelay = call.delayMinutes ?? call.arrivalDelayMinutes;
    return [
      {
        stopId: call.localStopId,
        scheduledArrival: arrival ?? time,
        scheduledDeparture: departureTime ?? time,
        statedShift:
          arrivalDelay === undefined && departureDelay === undefined
            ? undefined
            : {
                arrival: (arrivalDelay ?? departureDelay ?? 0) * 60_000,
                departure: (departureDelay ?? arrivalDelay ?? 0) * 60_000,
              },
        isBoardingCall: index === boardingIndex,
        isPublishedCurrentCall: call.isCurrentStop === true,
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
  const rowShift = stated - boardingCall.scheduledDeparture;
  // Below the row's own resolution a disagreement is rounding, not news: a row publishing 09:15 for
  // a departure the sequence times at 09:14:48 has not said the vehicle is late. Repeated as a
  // correction it re-timed the departure across the minute boundary and back again, which is the
  // flip the reading must not make.
  if (Math.abs(rowShift) < ROW_DEPARTURE_PRECISION_MS) return undefined;
  return rowShift;
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
 *
 * Alongside the calls it answers one question about the origin: how far the reading's own first
 * call was re-timed *there*, by the feed stating a deviation for it or by the row at the stop it
 * leaves from — and nothing where the re-timing came from a deviation stated further along the run
 * and carried back over the calls the feed does not monitor (`resolveCallShifts`). The two readings
 * of a late origin are very different claims — one says the vehicle is standing at its terminus,
 * the other says nothing about where it is at all — and which mark may be drawn for each is decided
 * on it.
 */
function getTimedCalls(
  departure: Departure,
  feedNow: number,
): { calls: TimedCall[]; originStatedShift: number | undefined } {
  const calls = getScheduledCalls(departure);
  const shifts = resolveCallShifts(calls);
  const boardingIndex = calls.findIndex((call) => call.isBoardingCall);
  const rowShift = getRowDepartureShift(
    departure,
    calls[boardingIndex],
    shifts[boardingIndex],
    feedNow,
  );
  // Read before the row's correction lands: a correction applied at the boarding call is the row's
  // own statement about the origin, and only a *later* one says the vehicle is still there.
  const statedSequenceShift =
    calls[0]?.statedShift !== undefined ? (shifts[0]?.departure ?? 0) : undefined;
  const originStatedShift =
    statedSequenceShift !== undefined && statedSequenceShift > 0
      ? statedSequenceShift
      : rowShift !== undefined && rowShift > 0 && boardingIndex === 0
        ? rowShift
        : undefined;
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
    const isDuplicateBoardCall =
      previous?.stopId === call.stopId &&
      (previous.isPublishedCurrentCall || call.isPublishedCurrentCall);
    if (isDuplicateBoardCall) {
      previous.arrival = Math.min(previous.arrival, arrival);
      previous.departure = Math.max(previous.departure, callDeparture);
      previous.departureIsExplicit ||=
        call.statedShift !== undefined || (rowShift !== undefined && index === boardingIndex);
      previous.isPublishedCurrentCall ||= call.isPublishedCurrentCall;
    } else {
      timed.push({
        stopId: call.stopId,
        arrival,
        departure: callDeparture,
        departureIsExplicit:
          call.statedShift !== undefined || (rowShift !== undefined && index === boardingIndex),
        isPublishedCurrentCall: call.isPublishedCurrentCall,
      });
    }
  }
  return { calls: timed, originStatedShift };
}

/** The feed's departure is the start of motion; no extra dwell or speed is invented. */
function getStandingEnd(here: TimedCall): number {
  return Math.max(here.arrival, here.departure);
}

/**
 * Whether the feed is watching this run at all.
 *
 * It decides one thing only: whether a trip that has not started is drawn standing at the stop it
 * is due out of. A monitored trip is one the operator's own system is following; an unmonitored one
 * is a line in a timetable, and a timetable is not evidence that anything is at that terminus.
 */
function isMonitoredTrip(departure: Departure): boolean {
  return (
    departure.status === "realtime" ||
    departure.predictedDepartureTime !== undefined ||
    departure.delayMinutes !== undefined ||
    (departure.tripCalls ?? []).some(
      (call) => call.delayMinutes !== undefined || call.arrivalDelayMinutes !== undefined,
    )
  );
}

/** Where the feed says a run begins and ends, as the stops those two calls resolve to. */
type RunEndStops = { startStopId?: string; endStopId?: string };

/**
 * The ends of the run among the calls a mark travels along, as the feed states them.
 *
 * Both stands a diagram draws are claims about a *line*: one says a vehicle is waiting to set out
 * from here, the other that a run finishes here. Neither may be made from the fact that our copy of
 * a sequence happens to begin or end at a call — a reading cut short stops mid-route while the
 * vehicle keeps going, and a stand drawn there parks a mark at a stop nothing terminates at. So the
 * feed has to say it (`statesRunStart` / `statesRunEnd`), and the stop it said it about is returned
 * rather than a flag, so the chain a mark actually travels has to still end there: calls with no
 * usable time or no stop of ours are dropped on the way, and a chain that lost its last call ends
 * mid-route exactly as a cut reading does.
 */
function findRunEndStops(departure: Departure): RunEndStops {
  const tripCalls = departure.tripCalls ?? [];
  const firstCall = tripCalls[0];
  const lastCall = tripCalls[tripCalls.length - 1];
  return {
    startStopId: statesRunStart(firstCall) ? firstCall?.localStopId : undefined,
    endStopId: statesRunEnd(lastCall) ? lastCall?.localStopId : undefined,
  };
}

/** What placing a mark knows beyond its calls and the clock: the facts about the run around it. */
type CallPositionContext = {
  /** Whether the feed is watching this run, which is what lets a not-yet-started trip stand. */
  isMonitored: boolean;
  /** When the stand at the first stop began, where a turnaround has been found for it. */
  standFrom: number | undefined;
  /** The ends of the run, which alone may carry a standing mark. */
  runEnds: RunEndStops;
  /**
   * How far the feed has re-stated the origin's own departure, where it has: the one deviation
   * that says the vehicle is standing where the run starts from rather than anywhere along it.
   */
  originStatedShift: number | undefined;
};

/**
 * Where the trip itself says the vehicle is, as one coordinate along its calls, and what that is.
 *
 * The phase is the whole of what the reading claims about a stand: `beforeStart` is only ever read
 * at the stop the run starts from, and whether that stand was found from an observed arrival
 * (`lib/line-turnarounds.ts`), from a re-stated origin or merely from the lead before the departure
 * does not change what it says — the run has not begun, so the vehicle is at that stop and on no
 * link. `getTripPlacement` reads it that way against a mark already drawn travelling.
 */
type TripCallPosition = {
  position: number;
  phase: TripPlacementPhase;
};

/**
 * A reading that places nothing, and why — because the two are answered very differently.
 *
 * `unplaceable` is a reading with nothing in it: a sequence of one call, one trimmed past the
 * vehicle, a trip not yet due to stand anywhere. It says nothing about where the vehicle is, so a
 * mark already drawn keeps the ground it stood on while the next refreshes are waited for.
 *
 * `finished` is a statement rather than a silence: this run is over. Holding a mark through it is
 * how a tram came to sit at the stop its trip ended at for as long as a board kept listing that
 * trip, so the mark is let go on the spot.
 */
type EmptyReading = "unplaceable" | "finished";

function findCallPosition(
  calls: readonly TimedCall[],
  feedNow: number,
  { isMonitored, standFrom, runEnds, originStatedShift }: CallPositionContext,
): TripCallPosition | EmptyReading {
  if (calls.length < 2) return "unplaceable";
  const first = calls[0];
  const last = calls[calls.length - 1];
  // Standing at the stop it is due out of: for the last few minutes before it leaves, or — where
  // the arrival it turns out of has been found — for the whole of the stand since that arrival.
  // Only ever at the stop the run itself starts from; anywhere else the vehicle is simply not here
  // yet, and drawing it standing would put a departure mark mid-route.
  //
  // A departure the feed has re-stated later keeps its stand: the vehicle is standing there — that
  // is what the re-statement is a measurement of — and letting the stand lapse because the lead is
  // now measured against the later time would blink the mark off and on across the revision. The
  // stand is still bounded by the lead, measured against the departure it was published for, so a
  // delay planned long ahead does not stand a mark at the terminus hours early.
  if (feedNow < first.arrival) {
    if (first.stopId !== runEnds.startStopId) return "unplaceable";
    const isDueOut = isMonitored && first.departure - feedNow <= DEPARTURE_STAND_LEAD_MS;
    const isTurning = standFrom !== undefined && feedNow >= standFrom;
    const isStatedStand =
      isMonitored &&
      originStatedShift !== undefined &&
      first.departure - originStatedShift - feedNow <= DEPARTURE_STAND_LEAD_MS;
    return isDueOut || isTurning || isStatedStand
      ? { position: 0, phase: "beforeStart" }
      : "unplaceable";
  }
  // Whether the feed says the run ends at the last call in hand. Where it does not, a reading past
  // that call has merely run out ahead of a vehicle still on the line, which says nothing about a
  // vehicle standing anywhere and holds nothing.
  const runEndsHere = last.stopId === runEnds.endStopId;

  // Past the stand the final call is held for: the run is over and the vehicle has gone off the
  // line.
  if (feedNow > last.departure + TERMINUS_STAND_MS) {
    return runEndsHere ? "finished" : "unplaceable";
  }

  // The arrival instant belongs to the terminus already. This inclusive boundary matters when a
  // second trip departs at exactly the same instant: the arrival is then a finished half of the
  // turnaround and can be replaced by the outgoing trip's single mark.
  if (feedNow >= last.arrival && runEndsHere) {
    return { position: calls.length - 1, phase: "afterEnd" };
  }

  for (let index = 0; index < calls.length - 1; index += 1) {
    const here = calls[index];
    const next = calls[index + 1];
    if (feedNow > next.arrival) continue;

    // Standing at the stop: the mark belongs on the stop, not part-way down the next link.
    const standingEnd = getStandingEnd(here);
    if (feedNow <= standingEnd) return { position: index, phase: "running" };

    // The timetable gives the best average speed estimate in hand. This locates the timed link;
    // `getSegmentForPosition` evaluates the shared motion curve within it so the domain and browser
    // agree about the gentle acceleration and braking around that average.
    const run = next.arrival - standingEnd;
    return {
      position: index + (run > 0 ? clampUnit((feedNow - standingEnd) / run) : 1),
      phase: "running",
    };
  }

  // Every link has been passed, so the reading is past the last call the trip states. A run that
  // ends there was already answered as a stand at its terminus above; this is the other case — the
  // calls ran out before the vehicle did, and there is nothing honest left to draw.
  return "unplaceable";
}

type SegmentAnchor = {
  fromStopId: string;
  toStopId: string;
  startProgress: number;
  startsAt: number;
  arrivesAt: number;
  startVelocity: number;
  cruiseVelocity: number;
  acceleratesUntil: number;
  brakesFrom: number;
};

type TripMotion = {
  timelineKey: string;
  segment: SegmentAnchor;
  shownAt: number;
  /**
   * When the trip itself last said where the vehicle was.
   *
   * Kept apart from `shownAt` — when the mark was last *drawn* — because only this one can bound
   * how long a mark is held over readings that place nothing. A diagram asks for its marks every
   * second, so a gap measured from the last drawing is closed again by the very tick that widened
   * it and never expires at all: a mark held that way outlived its trip by as long as anything
   * kept asking for it.
   */
  readAt: number;
  shown: TripPlacement;
};

/** One event-driven trajectory per vehicle, shared by every diagram that paints it. */
const tripMotions = new Map<string, TripMotion>();

function sweepTripMotions(feedNow: number) {
  if (tripMotions.size <= TRIP_MOTION_CAPACITY) return;
  for (const [key, motion] of tripMotions) {
    if (feedNow - motion.shownAt > TRIP_MOTION_STALE_MS) tripMotions.delete(key);
  }
  for (const key of tripMotions.keys()) {
    if (tripMotions.size <= TRIP_MOTION_CAPACITY) break;
    tripMotions.delete(key);
  }
}

const getTimelineKey = (calls: readonly TimedCall[]) =>
  calls
    .map(
      ({ stopId, arrival, departure, departureIsExplicit }) =>
        `${stopId}:${arrival}:${departure}:${departureIsExplicit ? 1 : 0}`,
    )
    .join("|");

type MotionCurve = Pick<
  SegmentAnchor,
  | "startProgress"
  | "startsAt"
  | "arrivesAt"
  | "startVelocity"
  | "cruiseVelocity"
  | "acceleratesUntil"
  | "brakesFrom"
>;

const getSegmentProgress = (segment: MotionCurve, feedNow: number): number => {
  if (feedNow <= segment.startsAt) return segment.startProgress;
  if (feedNow >= segment.arrivesAt) return 1;
  if (feedNow < segment.acceleratesUntil) {
    const elapsed = feedNow - segment.startsAt;
    const ramp = segment.acceleratesUntil - segment.startsAt;
    const acceleration = ramp > 0 ? (segment.cruiseVelocity - segment.startVelocity) / ramp : 0;
    return clampUnit(
      segment.startProgress +
        segment.startVelocity * elapsed +
        0.5 * acceleration * elapsed * elapsed,
    );
  }
  if (feedNow <= segment.brakesFrom) {
    const ramp = segment.acceleratesUntil - segment.startsAt;
    const rampDistance = 0.5 * (segment.startVelocity + segment.cruiseVelocity) * ramp;
    return clampUnit(
      segment.startProgress +
        rampDistance +
        segment.cruiseVelocity * (feedNow - segment.acceleratesUntil),
    );
  }
  const remaining = segment.arrivesAt - feedNow;
  const braking = segment.arrivesAt - segment.brakesFrom;
  return clampUnit(1 - (0.5 * segment.cruiseVelocity * remaining * remaining) / braking);
};

/** The shared domain/browser reading of one acceleration–cruise–braking trajectory. */
export const getTripTrajectoryProgress = (
  trajectory: TripSegmentTrajectory,
  feedNow: number,
): number => getSegmentProgress(trajectory, feedNow);

const getSegmentVelocity = (segment: SegmentAnchor, feedNow: number): number => {
  if (feedNow < segment.startsAt || feedNow >= segment.arrivesAt) return 0;
  if (feedNow < segment.acceleratesUntil) {
    const ramp = segment.acceleratesUntil - segment.startsAt;
    return ramp <= 0
      ? segment.cruiseVelocity
      : segment.startVelocity +
          (segment.cruiseVelocity - segment.startVelocity) * ((feedNow - segment.startsAt) / ramp);
  }
  if (feedNow <= segment.brakesFrom) return segment.cruiseVelocity;
  const braking = segment.arrivesAt - segment.brakesFrom;
  return braking <= 0 ? 0 : segment.cruiseVelocity * ((segment.arrivesAt - feedNow) / braking);
};

function findSegmentIndex(calls: readonly TimedCall[], segment: SegmentAnchor): number {
  return calls.findIndex(
    (call, index) =>
      call.stopId === segment.fromStopId && calls[index + 1]?.stopId === segment.toStopId,
  );
}

function createMotionSegment(
  fromStopId: string,
  toStopId: string,
  startProgress: number,
  startsAt: number,
  arrivesAt: number,
  requestedStartVelocity = 0,
): SegmentAnchor {
  const duration = Math.max(0, arrivesAt - startsAt);
  const distance = Math.max(0, 1 - startProgress);
  if (duration <= 0 || distance <= 0) {
    return {
      fromStopId,
      toStopId,
      startProgress,
      startsAt,
      arrivesAt,
      startVelocity: 0,
      cruiseVelocity: 0,
      acceleratesUntil: startsAt,
      brakesFrom: arrivesAt,
    };
  }
  const ramp = duration * SEGMENT_SPEED_RAMP_SHARE;
  // The inherited velocity has to leave enough distance for the ramp and final braking phase. A
  // very late revision can otherwise ask the polynomial to run backwards in order to arrive.
  // Keep half the remaining ground for the cruise and braking phases. Allowing the inherited
  // speed to consume all of it during the first ramp made a heavily delayed vehicle reach the
  // stop early and then sit at 100% until the revised arrival.
  const startVelocity = Math.min(Math.max(0, requestedStartVelocity), distance / ramp);
  const cruiseVelocity = (distance - 0.5 * ramp * startVelocity) / (duration - ramp);
  return {
    fromStopId,
    toStopId,
    startProgress,
    startsAt,
    arrivesAt,
    startVelocity,
    cruiseVelocity,
    acceleratesUntil: startsAt + ramp,
    brakesFrom: arrivesAt - ramp,
  };
}

function createScheduledSegment(calls: readonly TimedCall[], index: number): SegmentAnchor {
  const here = calls[index];
  const next = calls[index + 1];
  return createMotionSegment(here.stopId, next.stopId, 0, getStandingEnd(here), next.arrival);
}

function createRemainingSegment(
  calls: readonly TimedCall[],
  index: number,
  progress: number,
  feedNow: number,
  startVelocity = 0,
): SegmentAnchor {
  const scheduled = createScheduledSegment(calls, index);
  return createMotionSegment(
    scheduled.fromStopId,
    scheduled.toStopId,
    progress,
    feedNow,
    // A broken or already elapsed appointment contains no motion worth inventing.
    Math.max(feedNow, scheduled.arrivesAt),
    startVelocity,
  );
}

function getSegmentForPosition(
  calls: readonly TimedCall[],
  position: TripCallPosition,
  feedNow: number,
): { index: number; segment: SegmentAnchor; progress: number } {
  const index = Math.min(calls.length - 2, Math.max(0, Math.floor(position.position)));
  const scheduled = createScheduledSegment(calls, index);
  // `findCallPosition` identifies the timed link. Once it has, read progress from the same motion
  // curve the browser will paint rather than from a second, linear interpolation. Otherwise the
  // first sight of a vehicle and the following animation disagree about where that clock places it.
  const readProgress = clampUnit(position.position - index);
  const progress =
    readProgress > SETTLED_TOLERANCE && readProgress < 1 - SETTLED_TOLERANCE
      ? getSegmentProgress(scheduled, feedNow)
      : readProgress;
  return {
    index,
    segment:
      progress > SETTLED_TOLERANCE && progress < 1 - SETTLED_TOLERANCE
        ? createRemainingSegment(
            calls,
            index,
            progress,
            feedNow,
            getSegmentVelocity(scheduled, feedNow),
          )
        : scheduled,
    progress,
  };
}

function placementFromSegment(
  segment: SegmentAnchor,
  feedNow: number,
  phase: TripPlacementPhase,
  motion: TripPlacementMotion,
): TripPlacement {
  const progress = getSegmentProgress(segment, feedNow);
  const trajectory =
    phase === "running" && segment.arrivesAt > segment.startsAt
      ? {
          startProgress: segment.startProgress,
          startsAt: segment.startsAt,
          arrivesAt: segment.arrivesAt,
          startVelocity: segment.startVelocity,
          cruiseVelocity: segment.cruiseVelocity,
          acceleratesUntil: segment.acceleratesUntil,
          brakesFrom: segment.brakesFrom,
          sampledAt: feedNow,
        }
      : undefined;
  return {
    fromStopId: segment.fromStopId,
    toStopId: segment.toStopId,
    progress,
    phase,
    motion,
    ...(trajectory ? { trajectory } : {}),
  };
}

/** What a refresh decided to draw: the link a mark is on, and how it came to be there. */
type DrawnMotion = {
  segment: SegmentAnchor;
  phase: TripPlacementPhase;
  motion: TripPlacementMotion;
};

/**
 * The new reading, read against the mark already on the screen.
 *
 * A reading alone says where the trip is; it does not say whether the mark may travel there. That
 * is the whole of what this decides, and every answer is one of three: keep the appointment the
 * mark is already keeping, re-plan the current link from the ground it has covered, or state that
 * the mark was *put* somewhere — never animated across stops no vehicle was observed traversing.
 *
 * The one rule underneath all of them: a mark never moves backwards. A carried deviation can
 * re-time a sequence so the computed reading lands behind the mark, and that is a revision of the
 * clock, not evidence that a tram reversed.
 */
function reconcileWithDrawnMark(
  calls: readonly TimedCall[],
  reading: TripCallPosition,
  read: { index: number; segment: SegmentAnchor; progress: number },
  previous: TripMotion,
  timelineKey: string,
  feedNow: number,
): DrawnMotion {
  const asRead: DrawnMotion = { segment: read.segment, phase: reading.phase, motion: "travelled" };
  const placed: DrawnMotion = { ...asRead, motion: "placed" };
  const previousIndex = findSegmentIndex(calls, previous.segment);
  const previousProgress = getSegmentProgress(previous.segment, feedNow);
  const previousVelocity = getSegmentVelocity(previous.segment, feedNow);
  // The braking curve deliberately spends its last moments very close to the stop. Proximity is
  // not arrival: treating 99.5% as attained let a refresh bypass forward-only reconciliation and
  // place the mark backwards during precisely the gentle approach this curve introduces.
  const hasReachedStop = feedNow >= previous.segment.arrivesAt;
  const continuing = (segment: SegmentAnchor): DrawnMotion => ({
    segment,
    phase: "running",
    motion: "travelled",
  });

  // The reading says the vehicle has not left this call yet: a run the feed says has not begun
  // (`beforeStart` is only ever read at the stop the run starts from), or a departure the call
  // itself states is still ahead. Either way the vehicle is standing, not on the link — and that
  // holds whatever the mark was doing, which is what keeps a re-timed sequence from turning a stand
  // into a journey. Every branch below re-plans the *current* link from the ground the mark has
  // covered, which is the right answer for a vehicle under way and an invented departure for one
  // still at its stop: a waiting terminus mark, re-planned on each refresh, set off down the first
  // link minutes before its vehicle did.
  const standsAtCall =
    reading.phase === "beforeStart" ||
    (read.progress <= SETTLED_TOLERANCE &&
      calls[read.index].departureIsExplicit &&
      calls[read.index].departure > feedNow);
  if (standsAtCall) {
    return {
      segment: createScheduledSegment(calls, read.index),
      phase: reading.phase,
      // A direct platform fact outweighs the interpolated journey that had already been drawn; a
      // mark that never left the stop has nothing to be corrected about and simply stays put.
      motion: previousProgress > SETTLED_TOLERANCE ? "placed" : "travelled",
    };
  }

  if (previous.timelineKey === timelineKey) {
    // No observation changed: keep one trajectory instead of rebuilding it on every clock tick.
    if (previousIndex === read.index) return { ...asRead, segment: previous.segment };
    // The previous appointment finished and the trip handed over to its following link.
    if (read.index > previousIndex && hasReachedStop) return asRead;
    // The same reading cannot move a vehicle to an earlier link. Keep its current appointment,
    // including an attained stop, until the reading itself reaches that ground.
    return previousIndex >= 0 ? continuing(previous.segment) : placed;
  }

  if (previousIndex === read.index) {
    // The arrival moved: cancel the old appointment and spend the new remaining time from the exact
    // ground already covered.
    if (!hasReachedStop) {
      return continuing(
        createRemainingSegment(calls, read.index, previousProgress, feedNow, previousVelocity),
      );
    }
    // The old appointment has reached the stop but a carried delay now puts the interpolation
    // behind it. Hold the attained stop until the revised reading catches up; never reverse.
    if (!calls[read.index].departureIsExplicit) {
      return continuing({
        ...createRemainingSegment(calls, read.index, 1, feedNow),
        arrivesAt: Math.max(feedNow, calls[read.index + 1].arrival),
      });
    }
    return asRead;
  }

  // A carried delay may put the computed reading on an earlier link. It is not evidence that the
  // vehicle reversed, so finish the link it was already traversing on the revised clock — while
  // that link still has an arrival ahead of it. (Whether the reading itself says the vehicle is
  // still standing at that stop is already answered above: it can only say so about `read.index`,
  // and this is the branch where the mark is on some other link.)
  if (previousIndex >= 0 && !hasReachedStop && calls[previousIndex + 1].arrival > feedNow) {
    return continuing(
      createRemainingSegment(calls, previousIndex, previousProgress, feedNow, previousVelocity),
    );
  }
  // A genuinely different account of the vehicle's link is a placement, never animated across stops
  // the vehicle was not observed traversing.
  return placed;
}

/** Newest last, so the sweep's eviction order is the order the marks were last spoken for. */
function rememberMotion(key: string, motion: TripMotion) {
  tripMotions.delete(key);
  tripMotions.set(key, motion);
}

/**
 * The vehicle's current segment as an appointment with the next stop.
 *
 * Time passing merely evaluates the stable appointment. A refresh re-plans the remaining part of
 * the same link from the marker's present position. It never reverses to follow a later estimate.
 * The sole exception is direct evidence that the departure behind it is still in the future; that
 * corrects the estimate by placing the marker back at the stop, without animating a reverse trip.
 */
export function getTripPlacement(
  departure: Departure,
  feedNow: number,
  standFrom?: number,
): TripPlacement | null {
  const key = getVehicleTripKey(departure);
  const previous = tripMotions.get(key);
  if (previous?.shownAt === feedNow) return previous.shown;
  if (departure.status === "cancelled") {
    tripMotions.delete(key);
    return null;
  }

  const { calls, originStatedShift } = getTimedCalls(departure, feedNow);
  const reading = findCallPosition(calls, feedNow, {
    isMonitored: isMonitoredTrip(departure),
    standFrom,
    runEnds: findRunEndStops(departure),
    originStatedShift,
  });
  const timelineKey = getTimelineKey(calls);
  // A run the feed says is over takes its mark with it, and its trajectory: whatever was drawn for
  // it, there is no vehicle there to draw any more.
  if (reading === "finished") {
    tripMotions.delete(key);
    return null;
  }
  if (reading === "unplaceable") {
    const previousIndex = previous ? findSegmentIndex(calls, previous.segment) : -1;
    if (
      !previous ||
      feedNow < previous.shownAt ||
      feedNow - previous.readAt >= TRIP_MOTION_STALE_MS ||
      previousIndex < 0
    ) {
      return null;
    }
    const progress = getSegmentProgress(previous.segment, feedNow);
    const segment =
      progress < 1 - SETTLED_TOLERANCE
        ? createRemainingSegment(
            calls,
            previousIndex,
            progress,
            feedNow,
            getSegmentVelocity(previous.segment, feedNow),
          )
        : previous.segment;
    const shown = placementFromSegment(segment, feedNow, "running", "travelled");
    // `readAt` deliberately stays where it was: this reading placed nothing, and the grace a held
    // mark is kept for is measured from the last reading that did.
    rememberMotion(key, { ...previous, timelineKey, segment, shownAt: feedNow, shown });
    return shown;
  }

  const read = getSegmentForPosition(calls, reading, feedNow);
  const previousIsFresh =
    previous !== undefined && feedNow - previous.shownAt < TRIP_MOTION_STALE_MS;
  const drawn: DrawnMotion = previousIsFresh
    ? reconcileWithDrawnMark(calls, reading, read, previous, timelineKey, feedNow)
    : { segment: read.segment, phase: reading.phase, motion: "placed" };

  const shown = placementFromSegment(drawn.segment, feedNow, drawn.phase, drawn.motion);
  rememberMotion(key, {
    timelineKey,
    segment: drawn.segment,
    shownAt: Math.max(previous?.shownAt ?? feedNow, feedNow),
    readAt: feedNow,
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
