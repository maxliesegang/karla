import type { Departure } from "../data/transit-types";
import { collapseTurnaroundCalls, statesRunEnd, statesRunStart } from "./trip-calls";
import { getRunMarkKey } from "./trips";

/**
 * Turns a run's timed calls into vehicle trajectories.
 *
 * Placement reads only the run's own calls and the clock, never a board row: the same run is merged
 * into a different row on every board, and every view must draw it in one place. A mark keeps one
 * appointment per link (leave a stop, reach the next on time); a refresh re-plans the rest of the
 * link from the ground covered. Marks never move backwards and placements are never animated.
 */

/**
 * What a mark is doing where it stands. `beforeStart` (a monitored run due out of its first stop)
 * and `afterEnd` (a run at its final stop) are weaker than `running`: no vehicle was measured.
 * Arrivals and their turning departures are never joined; the feed does not publish that link.
 */
export type RunPlacementPhase = "running" | "beforeStart" | "afterEnd";

/** Where a vehicle is: between two calling points, and how far along. */
export type RunPlacement = {
  fromStopId: string;
  toStopId: string;
  /** 0 at the stop behind, 1 at the stop ahead. Stays at 0 while the vehicle is standing. */
  progress: number;
  phase: RunPlacementPhase;
  /**
   * Whether the mark got here by travelling or by being put here (a first paint, a gap, a reading
   * elsewhere). Only travel is animated.
   */
  motion: RunPlacementMotion;
  /**
   * How far a placement moved the drawn mark, in links. Stated only where the drawn segment still
   * exists, so a drawing can correct a small placement instead of snapping it.
   */
  placedAfterLinks?: number;
  /**
   * The current link as one appointment with the next stop: an acceleration–cruise–braking plan
   * from `startProgress` at `startsAt` to arrival at `arrivesAt`. Replaced only by a new reading or
   * the next link.
   */
  trajectory?: RunSegmentTrajectory;
};

/** See `RunPlacement.motion`. */
export type RunPlacementMotion = "travelled" | "placed";

export type RunSegmentTrajectory = {
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

/** A run unseen for this long has stopped being tracked; its next position starts fresh. */
const RUN_MOTION_STALE_MS = 120_000;
/** Runs remembered for smoothing before the untouched ones are swept out. */
const RUN_MOTION_CAPACITY = 256;
/** Progress within this of a target or a call counts as reaching it. */
const SETTLED_TOLERANCE = 0.005;
/** Share of a link's available running time used to change speed at either end. */
const SEGMENT_SPEED_RAMP_SHARE = 0.15;
/**
 * How long before a monitored run is due out of its first stop it is drawn standing there without
 * a known arrival. Measured against the delayed departure, and long enough for line 3's
 * eleven-minute turn at Forststraße. A found turnaround (`standFrom`) can stand it longer.
 */
const DEPARTURE_STAND_LEAD_MS = 9 * 60_000;
/**
 * How long a run keeps its mark at its final call, where the feed says it ends there. Within the
 * grace its observation is retained for (`lib/line-run-departures.ts`).
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
  /** Repeated beside the sequence's own copy of the boarding call. */
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
   * What the feed states for this call. A deviation for one end applies to both until the feed
   * separates them.
   */
  statedShift?: CallShift;
  /** Marks a duplicate board call, as opposed to real travel between platforms of one stop. */
  isPublishedCurrentCall: boolean;
};

/** Calls with a known stop and a known time. */
function getScheduledCalls(departure: Departure): ScheduledCall[] {
  // Only a repeated call marked as a run boundary is one stand reported twice; other repeats of a
  // stop can be real travel between its platforms.
  const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
  return calls.flatMap((call) => {
    if (!call.localStopId) return [];
    const arrival = toInstant(call.scheduledArrivalTime);
    const departureTime = toInstant(call.scheduledDepartureTime);
    const time = departureTime ?? arrival;
    if (time === undefined) return [];
    // One stated end applies to both. A run's first call has no arrival and its last no departure,
    // so there the one side is the whole statement.
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
        isPublishedCurrentCall: call.isCurrentStop === true,
      },
    ];
  });
}

/**
 * A deviation for every call: the feed monitors only calls near the vehicle, and a delay persists
 * until recovered, so the last stated deviation carries forward and the first carries back.
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
 * The calls a mark travels along, clamped so times never run backwards: deviations from readings of
 * different ages can time a call before the one behind it.
 *
 * `originStatedShift` is the delay the feed states for the first call itself, not one carried back
 * from further along; only that says the vehicle is standing at its terminus.
 */
function getTimedCalls(departure: Departure): {
  calls: TimedCall[];
  originStatedShift: number | undefined;
} {
  const calls = getScheduledCalls(departure);
  const shifts = resolveCallShifts(calls);
  const originShift = calls[0]?.statedShift?.departure;
  const originStatedShift = originShift !== undefined && originShift > 0 ? originShift : undefined;

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
      previous.departureIsExplicit ||= call.statedShift !== undefined;
      previous.isPublishedCurrentCall ||= call.isPublishedCurrentCall;
    } else {
      timed.push({
        stopId: call.stopId,
        arrival,
        departure: callDeparture,
        departureIsExplicit: call.statedShift !== undefined,
        isPublishedCurrentCall: call.isPublishedCurrentCall,
      });
    }
  }
  return { calls: timed, originStatedShift };
}

function getStandingEnd(here: TimedCall): number {
  return Math.max(here.arrival, here.departure);
}

/**
 * Whether any call states a deviation, as a monitored call does even when on time. Only a
 * monitored run that has not started is drawn standing at its terminus.
 */
const isMonitoredRun = (departure: Departure): boolean =>
  (departure.tripCalls ?? []).some(
    (call) => call.delayMinutes !== undefined || call.arrivalDelayMinutes !== undefined,
  );

/** Where the feed says a run begins and ends, as the stops those two calls resolve to. */
type RunEndStops = { startStopId?: string; endStopId?: string };

/**
 * The run's ends among the travelled calls, only where the feed states them: a reading cut short
 * ends mid-route, and a stand drawn there would park a mark where nothing terminates.
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

type CallPositionContext = {
  isMonitored: boolean;
  /** When the stand at the first stop began, where a turnaround has been found for it. */
  standFrom: number | undefined;
  /** Only the ends of the run may carry a standing mark. */
  runEnds: RunEndStops;
  /** The delay the feed states for the first call itself; see `getTimedCalls`. */
  originStatedShift: number | undefined;
};

/** Where the run says the vehicle is, as one coordinate along its calls, and in which phase. */
type RunCallPosition = {
  position: number;
  phase: RunPlacementPhase;
};

/**
 * Why a reading places nothing. `unplaceable` says nothing about the vehicle, so a drawn mark is
 * held; `finished` says the run is over, so the mark is dropped.
 */
type EmptyReading = "unplaceable" | "finished";

function findCallPosition(
  calls: readonly TimedCall[],
  feedNow: number,
  { isMonitored, standFrom, runEnds, originStatedShift }: CallPositionContext,
): RunCallPosition | EmptyReading {
  if (calls.length < 2) return "unplaceable";
  const first = calls[0];
  const last = calls[calls.length - 1];
  // Standing at the first stop: within the lead before departure, or since its turnaround arrival.
  // A later re-stated departure keeps the stand, still bounded by the lead from the published
  // time, so the mark does not blink across the revision.
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
  // Past a last call the feed does not call the run's end, the reading has only run out.
  const runEndsHere = last.stopId === runEnds.endStopId;

  if (feedNow > last.departure + TERMINUS_STAND_MS) {
    return runEndsHere ? "finished" : "unplaceable";
  }

  // Inclusive, so a trip departing at this very instant can replace the arrival's mark.
  if (feedNow >= last.arrival && runEndsHere) {
    return { position: calls.length - 1, phase: "afterEnd" };
  }

  for (let index = 0; index < calls.length - 1; index += 1) {
    const here = calls[index];
    const next = calls[index + 1];
    if (feedNow > next.arrival) continue;

    const standingEnd = getStandingEnd(here);
    if (feedNow <= standingEnd) return { position: index, phase: "running" };

    // The timed link; progress within it follows the shared motion curve.
    const run = next.arrival - standingEnd;
    return {
      position: index + (run > 0 ? clampUnit((feedNow - standingEnd) / run) : 1),
      phase: "running",
    };
  }

  // Past every link of a run that does not end here: the calls ran out before the vehicle did.
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

type RunMotion = {
  timelineKey: string;
  segment: SegmentAnchor;
  shownAt: number;
  /**
   * When the run last placed the vehicle. Bounds how long a mark is held over empty readings, which
   * `shownAt` cannot: it advances every tick.
   */
  readAt: number;
  shown: RunPlacement;
};

/**
 * The trajectories one drawing has painted, keyed by mark, so a refresh continues a mark's motion.
 * Owned by the drawing (`createRunMotions`) and shared by every placement in one paint.
 */
export type RunMotions = Map<string, RunMotion>;

export const createRunMotions = (): RunMotions => new Map();

function sweepRunMotions(motions: RunMotions, feedNow: number) {
  if (motions.size <= RUN_MOTION_CAPACITY) return;
  for (const [key, motion] of motions) {
    if (feedNow - motion.shownAt > RUN_MOTION_STALE_MS) motions.delete(key);
  }
  for (const key of motions.keys()) {
    if (motions.size <= RUN_MOTION_CAPACITY) break;
    motions.delete(key);
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
export const getRunTrajectoryProgress = (
  trajectory: RunSegmentTrajectory,
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
  // Keep half the remaining ground for cruise and braking, so a late revision neither runs the
  // curve backwards nor arrives early and waits.
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
  position: RunCallPosition,
  feedNow: number,
): { index: number; segment: SegmentAnchor; progress: number } {
  const index = Math.min(calls.length - 2, Math.max(0, Math.floor(position.position)));
  const scheduled = createScheduledSegment(calls, index);
  // Read progress from the same curve the browser paints, so first sight and animation agree.
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
  phase: RunPlacementPhase,
  motion: RunPlacementMotion,
  placedAfterLinks?: number,
): RunPlacement {
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
    ...(placedAfterLinks !== undefined ? { placedAfterLinks } : {}),
    ...(trajectory ? { trajectory } : {}),
  };
}

type DrawnMotion = {
  segment: SegmentAnchor;
  phase: RunPlacementPhase;
  motion: RunPlacementMotion;
};

/**
 * The new reading against the mark already drawn: keep the current appointment, re-plan the link
 * from the ground covered, or place the mark. A mark never moves backwards; a carried deviation
 * that puts the reading behind it re-times the clock, it does not reverse the tram.
 */
function reconcileWithDrawnMark(
  calls: readonly TimedCall[],
  reading: RunCallPosition,
  read: { index: number; segment: SegmentAnchor; progress: number },
  previous: RunMotion,
  timelineKey: string,
  feedNow: number,
): DrawnMotion {
  const asRead: DrawnMotion = { segment: read.segment, phase: reading.phase, motion: "travelled" };
  const placed: DrawnMotion = { ...asRead, motion: "placed" };
  const previousIndex = findSegmentIndex(calls, previous.segment);
  const previousProgress = getSegmentProgress(previous.segment, feedNow);
  const previousVelocity = getSegmentVelocity(previous.segment, feedNow);
  // The braking curve lingers near the stop; only the arrival instant counts as arrived.
  const hasReachedStop = feedNow >= previous.segment.arrivesAt;
  const continuing = (segment: SegmentAnchor): DrawnMotion => ({
    segment,
    phase: "running",
    motion: "travelled",
  });

  // The vehicle has not left this call: the run has not begun, or the call states its departure is
  // still ahead. It is standing, whatever the mark was doing, so it is not re-planned down the
  // link.
  const standsAtCall =
    reading.phase === "beforeStart" ||
    (read.progress <= SETTLED_TOLERANCE &&
      calls[read.index].departureIsExplicit &&
      calls[read.index].departure > feedNow);
  if (standsAtCall) {
    // A stand behind the drawn mark comes from a call re-timed later, so the mark finishes its link
    // on the revised clock instead of being hauled back. Exceptions: `beforeStart`, which says the
    // run has not begun, and the stop the mark is leaving stating its departure is still ahead.
    if (reading.phase !== "beforeStart" && previousIndex > read.index) {
      return hasReachedStop
        ? continuing({
            ...createRemainingSegment(calls, previousIndex, 1, feedNow),
            arrivesAt: Math.max(feedNow, calls[previousIndex + 1].arrival),
          })
        : continuing(
            createRemainingSegment(
              calls,
              previousIndex,
              previousProgress,
              feedNow,
              previousVelocity,
            ),
          );
    }
    return {
      segment: createScheduledSegment(calls, read.index),
      phase: reading.phase,
      // A platform fact outweighs the drawn journey. A mark already standing here travelled; one
      // drawn elsewhere was placed.
      motion:
        previousIndex === read.index && previousProgress <= SETTLED_TOLERANCE
          ? "travelled"
          : "placed",
    };
  }

  if (previous.timelineKey === timelineKey) {
    // No new observation: keep the trajectory.
    if (previousIndex === read.index) return { ...asRead, segment: previous.segment };
    if (read.index > previousIndex && hasReachedStop) return asRead;
    // The same reading cannot move a vehicle to an earlier link.
    return previousIndex >= 0 ? continuing(previous.segment) : placed;
  }

  if (previousIndex === read.index) {
    // The arrival moved: re-plan the remaining time from the ground covered.
    if (!hasReachedStop) {
      return continuing(
        createRemainingSegment(calls, read.index, previousProgress, feedNow, previousVelocity),
      );
    }
    // Reached the stop, but a carried delay puts the reading behind it: hold until it catches up.
    if (!calls[read.index].departureIsExplicit) {
      return continuing({
        ...createRemainingSegment(calls, read.index, 1, feedNow),
        arrivesAt: Math.max(feedNow, calls[read.index + 1].arrival),
      });
    }
    return asRead;
  }

  // A carried delay puts the reading on an earlier link: finish the current one on the revised
  // clock while its arrival is still ahead.
  if (previousIndex >= 0 && !hasReachedStop && calls[previousIndex + 1].arrival > feedNow) {
    return continuing(
      createRemainingSegment(calls, previousIndex, previousProgress, feedNow, previousVelocity),
    );
  }
  // A different account of the link is a placement.
  return placed;
}

/** Newest last, so the sweep evicts the least recently used. */
function rememberMotion(motions: RunMotions, key: string, motion: RunMotion) {
  motions.delete(key);
  motions.set(key, motion);
}

/**
 * How far a placement moves the mark from its painted position, in links; undefined where this
 * timeline no longer names the drawn segment.
 */
function getPlacementTravel(
  calls: readonly TimedCall[],
  previous: RunMotion,
  position: RunCallPosition,
  feedNow: number,
): number | undefined {
  const previousIndex = findSegmentIndex(calls, previous.segment);
  if (previousIndex < 0) return undefined;
  const previousPosition = previousIndex + getSegmentProgress(previous.segment, feedNow);
  return Math.abs(position.position - previousPosition);
}

/**
 * The vehicle's current segment as an appointment with the next stop. A refresh re-plans the rest
 * of the link and never reverses, except that a call stating its departure is still ahead places
 * the mark back at that stop.
 */
export function getRunPlacement(
  motions: RunMotions,
  departure: Departure,
  feedNow: number,
  standFrom?: number,
): RunPlacement | null {
  const key = getRunMarkKey(departure);
  const previous = motions.get(key);
  if (previous?.shownAt === feedNow) return previous.shown;
  if (departure.status === "cancelled") {
    motions.delete(key);
    return null;
  }

  const { calls, originStatedShift } = getTimedCalls(departure);
  const reading = findCallPosition(calls, feedNow, {
    isMonitored: isMonitoredRun(departure),
    standFrom,
    runEnds: findRunEndStops(departure),
    originStatedShift,
  });
  const timelineKey = getTimelineKey(calls);
  // A finished run drops its mark and trajectory.
  if (reading === "finished") {
    motions.delete(key);
    return null;
  }
  if (reading === "unplaceable") {
    const previousIndex = previous ? findSegmentIndex(calls, previous.segment) : -1;
    if (
      !previous ||
      feedNow < previous.shownAt ||
      feedNow - previous.readAt >= RUN_MOTION_STALE_MS ||
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
    // `readAt` stays: the hold is measured from the last reading that placed the mark.
    rememberMotion(motions, key, { ...previous, timelineKey, segment, shownAt: feedNow, shown });
    return shown;
  }

  const read = getSegmentForPosition(calls, reading, feedNow);
  const previousIsFresh =
    previous !== undefined && feedNow - previous.shownAt < RUN_MOTION_STALE_MS;
  const drawn: DrawnMotion = previousIsFresh
    ? reconcileWithDrawnMark(calls, reading, read, previous, timelineKey, feedNow)
    : { segment: read.segment, phase: reading.phase, motion: "placed" };

  const shown = placementFromSegment(
    drawn.segment,
    feedNow,
    drawn.phase,
    drawn.motion,
    drawn.motion === "placed" && previous
      ? getPlacementTravel(calls, previous, reading, feedNow)
      : undefined,
  );
  rememberMotion(motions, key, {
    timelineKey,
    segment: drawn.segment,
    shownAt: Math.max(previous?.shownAt ?? feedNow, feedNow),
    readAt: feedNow,
    shown,
  });
  sweepRunMotions(motions, feedNow);
  return shown;
}

/** Soonest passage first, so a capped diagram keeps the marks a rider is about to care about. */
export function createSoonestPassageComparator(feedNow: number) {
  const wait = (departure: Departure) =>
    Math.abs(Date.parse(departure.scheduledDepartureTime) - feedNow);
  return (a: Departure, b: Departure) => wait(a) - wait(b);
}
