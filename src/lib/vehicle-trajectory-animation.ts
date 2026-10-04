import { getRunTrajectoryProgress, type RunSegmentTrajectory } from "./vehicle-positioning";

/**
 * One trajectory as Web Animation keyframes: the acceleration–cruise–braking curve
 * (`vehicle-positioning.ts`) sampled densely on the ramps and at each boundary the drawing cares
 * about. A revised plan starts from the painted value, correcting over a few seconds.
 */

/** A revised prediction meets the painted marker over this short visual correction. */
export const TRAJECTORY_CORRECTION_MS = 3_000;

/**
 * A placement within this many links is corrected over `TRAJECTORY_CORRECTION_MS` like a replan;
 * further ones are painted where they belong.
 */
export const PLACEMENT_CORRECTION_MAX_LINKS = 1;

/** Whether a placement is short enough to be corrected rather than snapped. */
export const isCorrectivePlacement = (placedAfterLinks: number | undefined): boolean =>
  placedAfterLinks !== undefined && placedAfterLinks <= PLACEMENT_CORRECTION_MAX_LINKS;

/** The property a mark's position is stated in: its transform, or a stroke's dash offset. */
export type TrajectoryAnimationProperty = "transform" | "strokeDashoffset";

/**
 * Whether the painted value can seed the next animation. A dash offset is measured along its own
 * link's stretch, so on another link it would mean another place.
 */
export const canReuseAnimatedValue = (
  property: TrajectoryAnimationProperty,
  paintedLinkKey: string,
  linkKey: string,
): boolean => property === "transform" || paintedLinkKey === linkKey;

/** One keyframe of a WAAPI animation: the animated value, and when along the link it holds. */
export type TrajectoryKeyframe = { value: string; offset: number };

export type TrajectoryKeyframeOptions = {
  /** The trajectory the mark follows, as the placement sampled it. */
  trajectory: RunSegmentTrajectory;
  /** Feed-clock instant the animation starts at. */
  animationStartsAt: number;
  /** The animated property value at a progress. */
  getValue: (progress: number) => string | undefined;
  /** Progresses within the link whose crossings get their own keyframes. */
  boundaryProgresses?: readonly number[];
  /** The painted value, which a replan starts from. */
  paintedValue?: string;
};

/** Keyframes from `animationStartsAt` to the next stop: distinct, in order, offsets ending at 1. */
export function getTrajectoryKeyframes({
  trajectory,
  animationStartsAt,
  getValue,
  boundaryProgresses = [],
  paintedValue,
}: TrajectoryKeyframeOptions): TrajectoryKeyframe[] {
  const duration = trajectory.arrivesAt - animationStartsAt;
  if (duration <= 0) return [];
  const fromProgress = getRunTrajectoryProgress(trajectory, animationStartsAt);
  const boundaryProgressesWithin = boundaryProgresses.filter(
    (progress) => progress > fromProgress && progress < 1,
  );
  const findPassageTime = (targetProgress: number) => {
    let before = animationStartsAt;
    let after = trajectory.arrivesAt;
    // The curve is monotonic, so a short binary search finds each boundary crossing.
    for (let pass = 0; pass < 24; pass += 1) {
      const middle = (before + after) / 2;
      if (getRunTrajectoryProgress(trajectory, middle) < targetProgress) before = middle;
      else after = middle;
    }
    return (before + after) / 2;
  };
  const correctionEndsAt = paintedValue
    ? Math.min(trajectory.arrivesAt, animationStartsAt + TRAJECTORY_CORRECTION_MS)
    : animationStartsAt;
  const rampSamples = (from: number, to: number) =>
    Array.from({ length: 5 }, (_, index) => from + ((to - from) * (index + 1)) / 6);
  const times = [
    animationStartsAt,
    correctionEndsAt,
    ...rampSamples(trajectory.startsAt, trajectory.acceleratesUntil),
    trajectory.acceleratesUntil,
    trajectory.brakesFrom,
    ...rampSamples(trajectory.brakesFrom, trajectory.arrivesAt),
    ...boundaryProgressesWithin.map(findPassageTime),
    trajectory.arrivesAt,
  ]
    .filter((instant) => instant >= animationStartsAt && instant <= trajectory.arrivesAt)
    .sort((left, right) => left - right)
    .filter((instant, index, all) => index === 0 || instant !== all[index - 1]);
  return times.flatMap((instant, index) => {
    const progress = getRunTrajectoryProgress(trajectory, instant);
    const value = index === 0 && paintedValue ? paintedValue : getValue(progress);
    return value ? [{ value, offset: (instant - animationStartsAt) / duration }] : [];
  });
}
