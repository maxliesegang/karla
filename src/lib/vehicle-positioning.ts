import type { Departure } from "../data/transit-types";
import { collapseTurnaroundCalls, statesRunEnd, statesRunStart } from "./trip-calls";
import { getRunTimeline } from "./run-timeline";
import { getRunMarkKey } from "./trips";

/** Shared vehicle motion from call times: revised station arrivals take priority over continuity. */

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
  /** The mark's way along the current link, replaced only by a new reading or the next link. */
  trajectory?: RunSegmentTrajectory;
};

/** See `RunPlacement.motion`. */
export type RunPlacementMotion = "travelled" | "placed";

export type RunSegmentTrajectory = {
  startsAt: number;
  /** Monotonic samples every `FOLLOW_STEP_MS`, with the final sample at `arrivesAt`. */
  progresses: readonly number[];
  startProgress: number;
  /** When the last sample is reached: the next stop, or the end of the plan's horizon. */
  arrivesAt: number;
  /** Feed-clock instant at which the accompanying placement was evaluated. */
  sampledAt: number;
};

/** A run unseen for this long has stopped being tracked; its next position starts fresh. */
const RUN_MOTION_STALE_MS = 120_000;
/** Runs remembered for smoothing before the untouched ones are swept out. */
const RUN_MOTION_CAPACITY = 256;
/** Progress within this of a target or a call counts as reaching it. */
const SETTLED_TOLERANCE = 0.005;
/** Resolution of a mark's plan. */
export const FOLLOW_STEP_MS = 1_000;
/** How long a mark plans ahead without a new reading. */
const FOLLOW_HORIZON_MS = 120_000;
/** About how long a mark takes to close the gap to its reading. Tuned on recorded runs. */
const FOLLOW_TIME_CONSTANT_MS = 10_000;
/** A catching-up mark runs at most this many times the reading's own speed… */
const FOLLOW_MAX_SPEEDUP = 2.5;
/** …or at least one link in this many milliseconds, where the reading stands. */
const FOLLOW_MIN_CATCH_UP_VELOCITY = 1 / 40_000;
/** A forward reading this many links away is placed rather than followed. */
const PLACEMENT_DISTANCE_LINKS = 2;
/**
 * A mark at most this far along its link goes back to the stop behind when the reading has the
 * vehicle still standing there: a mark that had only edged out reads better back at the stop than
 * crawling away from it until the delayed departure.
 */
export const NEAR_STOP_RETURN_PROGRESS = 0.1;
/**
 * A departure stated to the minute is drawn this much later, at most half the link: a dwell that
 * runs over is the commonest revision, and a mark already away would have to crawl the link.
 */
const DEPARTURE_GRACE_MS = 10_000;
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

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

type TimedCall = {
  stopId: string;
  arrival: number;
  departure: number;
  /** Repeated beside the sequence's own copy of the boarding call. */
  isPublishedCurrentCall: boolean;
};

/** Placement adds a bounded dwell grace to the shared expected timeline. */
function getTimedCalls(departure: Departure): {
  calls: TimedCall[];
  originStatedShift: number | undefined;
} {
  const localCalls = collapseTurnaroundCalls(departure.tripCalls ?? []).filter(
    (call) => call.localStopId,
  );
  const timeline = getRunTimeline(localCalls);
  const first = timeline[0]?.call;
  const originShift = first?.delayMinutes ?? first?.arrivalDelayMinutes;
  const originStatedShift =
    originShift !== undefined && originShift > 0 ? originShift * 60_000 : undefined;
  const timed: TimedCall[] = [];
  for (const { call, arrival, departure: callDeparture } of timeline) {
    if (!call.localStopId) continue;
    const previous = timed.at(-1);
    const isPublishedCurrentCall = call.isCurrentStop === true;
    if (
      previous &&
      previous.stopId === call.localStopId &&
      (previous.isPublishedCurrentCall || isPublishedCurrentCall)
    ) {
      previous.arrival = Math.min(previous.arrival, arrival);
      previous.departure = Math.max(previous.departure, callDeparture);
      previous.isPublishedCurrentCall ||= isPublishedCurrentCall;
    } else {
      timed.push({
        stopId: call.localStopId,
        arrival,
        departure: callDeparture,
        isPublishedCurrentCall,
      });
    }
  }
  for (const [index, here] of timed.entries()) {
    const next = timed[index + 1];
    if (!next) break;
    here.departure += Math.min(DEPARTURE_GRACE_MS, Math.max(0, next.arrival - here.departure) / 2);
  }
  return { calls: timed, originStatedShift };
}

function getStandingEnd(here: TimedCall): number {
  return Math.max(here.arrival, here.departure);
}

/** A stated deviation, including zero, permits a new waiting mark at the origin. */
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
  hasWaitingMark: boolean;
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
  { isMonitored, hasWaitingMark, standFrom, runEnds, originStatedShift }: CallPositionContext,
): RunCallPosition | EmptyReading {
  if (calls.length < 2) return "unplaceable";
  const first = calls[0];
  const last = calls[calls.length - 1];
  // Standing at the first stop: within the lead before departure, or since its turnaround arrival.
  // A later re-stated departure keeps the stand, still bounded by the lead from the published
  // time, so the mark does not blink across the revision.
  if (feedNow < first.arrival) {
    if (first.stopId !== runEnds.startStopId) return "unplaceable";
    const isDueOut =
      (isMonitored || hasWaitingMark) && first.departure - feedNow <= DEPARTURE_STAND_LEAD_MS;
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

/** Where the reading says the vehicle is at an instant, and how fast it is moving there. */
type ReadTarget = { position: number; velocity: number };

function findReadTarget(
  calls: readonly TimedCall[],
  feedNow: number,
  context: CallPositionContext,
): ReadTarget | undefined {
  const reading = findCallPosition(calls, feedNow, context);
  if (typeof reading === "string") return undefined;
  const index = Math.floor(reading.position);
  if (reading.phase !== "running" || index === reading.position || index >= calls.length - 1) {
    return { position: reading.position, velocity: 0 };
  }
  const run = calls[index + 1].arrival - getStandingEnd(calls[index]);
  return { position: reading.position, velocity: run > 0 ? 1 / run : 0 };
}

/**
 * The mark's way along one link: progress sampled every `FOLLOW_STEP_MS` from `startsAt`, ending at
 * the next stop or after `FOLLOW_HORIZON_MS`.
 */
type LinkPlan = { startsAt: number; arrivesAt: number; progresses: readonly number[] };

const getPlanEnd = (plan: LinkPlan) => plan.arrivesAt;

const getPlanProgress = (plan: LinkPlan, feedNow: number): number => {
  const { progresses } = plan;
  const offset = (feedNow - plan.startsAt) / FOLLOW_STEP_MS;
  if (offset <= 0) return progresses[0];
  if (feedNow >= plan.arrivesAt) return progresses[progresses.length - 1];
  const index = Math.floor(offset);
  const sampleAt = plan.startsAt + index * FOLLOW_STEP_MS;
  const nextAt = Math.min(plan.arrivesAt, sampleAt + FOLLOW_STEP_MS);
  return (
    progresses[index] +
    (progresses[index + 1] - progresses[index]) * ((feedNow - sampleAt) / (nextAt - sampleAt))
  );
};

/** Follows revised arrivals without reversing; standing marks wait for departure. */
function planLink(
  calls: readonly TimedCall[],
  context: CallPositionContext,
  index: number,
  startProgress: number,
  startsAt: number,
): LinkPlan {
  const progresses = [startProgress];
  let position = index + startProgress;
  let from = findReadTarget(calls, startsAt, context);
  const arrival = calls[index + 1].arrival;
  const arrivesAt = Math.max(startsAt, Math.min(startsAt + FOLLOW_HORIZON_MS, arrival));
  let previousAt = startsAt;
  for (let sample = 1; previousAt < arrivesAt; sample += 1) {
    const at = Math.min(startsAt + sample * FOLLOW_STEP_MS, arrivesAt);
    const step = at - previousAt;
    const to = findReadTarget(calls, at, context);
    if (at === arrival && startProgress < 1) {
      progresses.push(1);
      break;
    }
    if (from && to && position > from.position + SETTLED_TOLERANCE / 10) {
      // Ahead of the reading: a mark at its stop stays there; one under way slows so it reaches
      // the next stop when the reading does, rather than stopping between stops.
      if (position === index) {
        from = to;
        progresses.push(0);
        previousAt = at;
        continue;
      }
      const timeLeft = Math.max(step, arrival - previousAt);
      position = Math.min(index + 1, position + ((index + 1 - position) / timeLeft) * step);
    } else if (from && to) {
      let velocity = from.velocity + (from.position - position) / FOLLOW_TIME_CONSTANT_MS;
      // A small gap closes in one step rather than ever more slowly.
      if (to.position > position) {
        velocity = Math.max(
          velocity,
          Math.min(FOLLOW_MIN_CATCH_UP_VELOCITY, (to.position - position) / step),
        );
      }
      const maxVelocity = Math.max(
        from.velocity * FOLLOW_MAX_SPEEDUP,
        FOLLOW_MIN_CATCH_UP_VELOCITY,
      );
      let next = position + Math.min(maxVelocity, Math.max(0, velocity)) * step;
      // Catching up never overtakes the reading.
      if (position <= to.position) next = Math.min(next, to.position);
      position = Math.min(next, index + 1);
    }
    from = to;
    progresses.push(position - index);
    previousAt = at;
    if (position >= index + 1) break;
  }
  return {
    startsAt,
    progresses,
    arrivesAt: Math.min(arrivesAt, startsAt + (progresses.length - 1) * FOLLOW_STEP_MS),
  };
}

type RunMotion = {
  timelineKey: string;
  fromStopId: string;
  toStopId: string;
  plan: LinkPlan;
  shownAt: number;
  /**
   * When the run last placed the vehicle. Bounds how long a mark is held over empty readings, which
   * `shownAt` cannot: it advances every tick.
   */
  readAt: number;
  shown: RunPlacement;
};

/**
 * The marks painted so far, keyed by mark, so a refresh continues a mark's motion. The app keeps one
 * for every view (`hooks/run-motions.ts`), so a run's mark is in one place whichever view draws it.
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

/** Newest last, so the sweep evicts the least recently used. */
function rememberMotion(motions: RunMotions, key: string, motion: RunMotion) {
  motions.delete(key);
  motions.set(key, motion);
}

const getTimelineKey = (calls: readonly TimedCall[]) =>
  calls.map(({ stopId, arrival, departure }) => `${stopId}:${arrival}:${departure}`).join("|");

function findLinkIndex(calls: readonly TimedCall[], fromStopId: string, toStopId: string): number {
  return calls.findIndex(
    (call, index) => call.stopId === fromStopId && calls[index + 1]?.stopId === toStopId,
  );
}

/** The plan read back at an instant, as an index into the calls and progress along that link. */
export const getRunTrajectoryProgress = (
  trajectory: RunSegmentTrajectory,
  feedNow: number,
): number => getPlanProgress(trajectory, feedNow);

function placementFromPlan(
  calls: readonly TimedCall[],
  index: number,
  plan: LinkPlan,
  feedNow: number,
  readPhase: RunPlacementPhase,
  motion: RunPlacementMotion,
  placedAfterLinks?: number,
): RunPlacement {
  const progress = getPlanProgress(plan, feedNow);
  const isAtFirstCall = index === 0 && progress <= SETTLED_TOLERANCE;
  const isAtLastCall = index === calls.length - 2 && progress >= 1 - SETTLED_TOLERANCE;
  const phase =
    (readPhase === "beforeStart" && isAtFirstCall) || (readPhase === "afterEnd" && isAtLastCall)
      ? readPhase
      : "running";
  const end = getPlanEnd(plan);
  const finalProgress = plan.progresses[plan.progresses.length - 1];
  const trajectory: RunSegmentTrajectory | undefined =
    phase === "running" && end > feedNow && finalProgress > progress + SETTLED_TOLERANCE
      ? {
          startsAt: plan.startsAt,
          progresses: plan.progresses,
          startProgress: plan.progresses[0],
          arrivesAt: end,
          sampledAt: feedNow,
        }
      : undefined;
  return {
    fromStopId: calls[index].stopId,
    toStopId: calls[index + 1].stopId,
    progress,
    phase,
    motion,
    ...(placedAfterLinks !== undefined ? { placedAfterLinks } : {}),
    ...(trajectory ? { trajectory } : {}),
  };
}

/** Forward corrections meet arrival deadlines; backward corrections stay within the stop grace. */
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
  const context: CallPositionContext = {
    isMonitored: isMonitoredRun(departure),
    hasWaitingMark: previous?.shown.phase === "beforeStart",
    standFrom,
    runEnds: findRunEndStops(departure),
    originStatedShift,
  };
  const reading = findCallPosition(calls, feedNow, context);
  if (reading === "finished") {
    motions.delete(key);
    return null;
  }
  const timelineKey = getTimelineKey(calls);

  if (reading === "unplaceable") {
    // Held on its own plan: the reading says nothing about the vehicle. Views keep their own feed
    // clocks, so one a little behind keeps the ground another has shown.
    if (
      !previous ||
      feedNow - previous.readAt >= RUN_MOTION_STALE_MS ||
      findLinkIndex(calls, previous.fromStopId, previous.toStopId) < 0
    ) {
      return null;
    }
    const shown: RunPlacement = {
      ...previous.shown,
      progress:
        feedNow < previous.shownAt
          ? previous.shown.progress
          : getPlanProgress(previous.plan, feedNow),
      phase: "running",
      motion: "travelled",
    };
    delete shown.placedAfterLinks;
    rememberMotion(motions, key, {
      ...previous,
      shownAt: Math.max(previous.shownAt, feedNow),
      shown,
    });
    return shown;
  }

  // Where the drawn mark stands on this reading's calls, and since when a new plan would start.
  let drawn: { index: number; progress: number; from: number; isPlanCurrent: boolean } | undefined;
  if (previous && feedNow - previous.shownAt < RUN_MOTION_STALE_MS) {
    const index = findLinkIndex(calls, previous.fromStopId, previous.toStopId);
    if (index >= 0) {
      const planEnd = getPlanEnd(previous.plan);
      // A step back of the feed clock is not travel: the mark keeps the ground it was shown on.
      const from = feedNow < previous.shownAt ? feedNow : Math.min(feedNow, planEnd);
      const progress =
        feedNow < previous.shownAt ? previous.shown.progress : getPlanProgress(previous.plan, from);
      drawn =
        progress >= 1 && index + 1 < calls.length - 1
          ? { index: index + 1, progress: 0, from, isPlanCurrent: false }
          : {
              index,
              progress,
              from,
              isPlanCurrent: previous.timelineKey === timelineKey && planEnd > feedNow,
            };
    }
  }

  const readIndex = Math.min(calls.length - 2, Math.floor(reading.position));
  const readProgress = clampUnit(reading.position - readIndex);
  const distance = drawn ? reading.position - (drawn.index + drawn.progress) : undefined;
  const hasPassedArrival =
    drawn !== undefined &&
    distance !== undefined &&
    distance > 0 &&
    calls[drawn.index + 1].arrival <= feedNow;
  const hasNotLeft =
    drawn !== undefined &&
    reading.position === drawn.index &&
    drawn.progress > 0 &&
    drawn.progress <= NEAR_STOP_RETURN_PROGRESS;
  let index: number;
  let plan: LinkPlan;
  let motion: RunPlacementMotion;
  if (drawn && hasNotLeft) {
    index = drawn.index;
    plan = planLink(calls, context, index, 0, feedNow);
    motion = "placed";
  } else if (
    drawn &&
    distance !== undefined &&
    distance <= PLACEMENT_DISTANCE_LINKS &&
    !hasPassedArrival
  ) {
    index = drawn.index;
    plan =
      drawn.isPlanCurrent && previous
        ? previous.plan
        : planLink(calls, context, index, drawn.progress, drawn.from);
    motion = "travelled";
  } else {
    index = readIndex;
    plan = planLink(calls, context, index, readProgress, feedNow);
    motion = "placed";
  }

  if (getPlanProgress(plan, feedNow) >= 1 && index + 1 < calls.length - 1) {
    index += 1;
    plan = planLink(calls, context, index, 0, feedNow);
  }
  const shown = placementFromPlan(
    calls,
    index,
    plan,
    feedNow,
    reading.phase,
    motion,
    motion === "placed" && distance !== undefined ? Math.abs(distance) : undefined,
  );
  rememberMotion(motions, key, {
    timelineKey,
    fromStopId: shown.fromStopId,
    toStopId: shown.toStopId,
    plan,
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
