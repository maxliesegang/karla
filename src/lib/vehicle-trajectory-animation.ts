import { getRunTrajectoryProgress, type RunSegmentTrajectory } from "./vehicle-positioning";

/**
 * One trajectory as browser keyframes, shared by every drawing that paints a mark along it.
 *
 * The domain model owns the motion — an acceleration–cruise–braking plan toward the next stop
 * (`vehicle-positioning.ts`). The browser cannot run a polynomial, so the plan is sampled into a
 * short list of keyframes the compositor interpolates linearly between: densely over the ramps,
 * where the curve bends, and once per crossing of a boundary the drawing cares about (a line
 * diagram's stop rows), where a mark must be at a known place on its own clock.
 *
 * The caller states where a mark stands at a progress — transforms are the drawing's business;
 * which instants deserve a keyframe is the trajectory's. A revised prediction that meets a mark
 * already painted starts its first keyframe from the painted transform, so the remaining ground is
 * corrected over a few seconds instead of snapping.
 */

/** A revised prediction meets the painted marker over this short visual correction. */
export const TRAJECTORY_CORRECTION_MS = 3_000;

/**
 * A placement no further than this from the mark it replaces — in links of the trip's own calls —
 * is corrected over the same few seconds a replan is, instead of snapped. The reading found the
 * vehicle a little away from where the mark stood, and covering that in `TRAJECTORY_CORRECTION_MS`
 * reads as the correction it is; a placement further than a link would be drawn as a journey no
 * vehicle was observed making, so it is painted where it belongs and nothing carries the old paint.
 */
export const PLACEMENT_CORRECTION_MAX_LINKS = 1;

/** Whether a placement's own travel is short enough to be corrected over rather than snapped. */
export const isCorrectivePlacement = (placedAfterLinks: number | undefined): boolean =>
  placedAfterLinks !== undefined && placedAfterLinks <= PLACEMENT_CORRECTION_MAX_LINKS;

/** One keyframe of a WAAPI animation: the mark's transform, and when along the link it holds. */
export type TrajectoryKeyframe = { transform: string; offset: number };

export type TrajectoryKeyframeOptions = {
  /** The trajectory the mark follows, as the placement sampled it. */
  trajectory: RunSegmentTrajectory;
  /** Feed-clock instant the animation spans from; the trajectory is read from there. */
  animationStartsAt: number;
  /** The mark's transform at a progress along the link, in the drawing's own coordinate system. */
  getTransform: (progress: number) => string | undefined;
  /**
   * Progresses between the link's ends whose crossings are keyframed on their own clock — the
   * boundaries a drawing places marks between. Beyond the link's ends they are ignored.
   */
  boundaryProgresses?: readonly number[];
  /** The transform the mark is painted at, which a replan carries briefly instead of snapping. */
  paintedTransform?: string;
};

/**
 * The keyframes one trajectory is painted from, from `animationStartsAt` to the next stop.
 *
 * Times are sampled where the curve is steepest and deduplicated, so each keyframe states a
 * distinct instant in order; offsets are ascending and end at 1, as a Web Animation requires.
 */
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
    // The curve is monotonic. A short binary search is both cheaper than per-frame JS animation
    // and accurate enough that a skipped-stop marker crosses each boundary on its own clock.
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
