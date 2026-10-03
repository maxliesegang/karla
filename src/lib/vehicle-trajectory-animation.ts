import { getRunTrajectoryProgress, type RunSegmentTrajectory } from "./vehicle-positioning";

/**
 * One trajectory as Web Animation keyframes: the acceleration–cruise–braking curve
 * (`vehicle-positioning.ts`) sampled densely on the ramps and at each boundary the drawing cares
 * about. A revised plan starts from the painted transform, correcting over a few seconds.
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

/** One keyframe of a WAAPI animation: the mark's transform, and when along the link it holds. */
export type TrajectoryKeyframe = { transform: string; offset: number };

export type TrajectoryKeyframeOptions = {
  /** The trajectory the mark follows, as the placement sampled it. */
  trajectory: RunSegmentTrajectory;
  /** Feed-clock instant the animation starts at. */
  animationStartsAt: number;
  /** The mark's transform at a progress, in the drawing's coordinates. */
  getTransform: (progress: number) => string | undefined;
  /** Progresses within the link whose crossings get their own keyframes. */
  boundaryProgresses?: readonly number[];
  /** The painted transform, which a replan starts from. */
  paintedTransform?: string;
};

/** Keyframes from `animationStartsAt` to the next stop: distinct, in order, offsets ending at 1. */
export function getTrajectoryKeyframes({
  trajectory,
  animationStartsAt,
  getTransform,
  boundaryProgresses = [],
  paintedTransform,
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
  const correctionEndsAt = paintedTransform
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
    const transform = index === 0 && paintedTransform ? paintedTransform : getTransform(progress);
    return transform ? [{ transform, offset: (instant - animationStartsAt) / duration }] : [];
  });
}
