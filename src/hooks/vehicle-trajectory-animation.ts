import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  getRunTrajectoryProgress,
  type RunPlacementMotion,
  type RunSegmentTrajectory,
} from "../lib/vehicle-positioning";
import {
  isCorrectivePlacement,
  getTrajectoryKeyframes,
  TRAJECTORY_CORRECTION_MS,
} from "../lib/vehicle-trajectory-animation";

/**
 * One mark's segment-length Web Animation, shared by the line diagram and the Zentrum map:
 * - a signature over the plan and coordinates decides whether the running animation still applies;
 * - a replan continues from the painted transform, correcting over a few seconds;
 * - a placement is never animated from the old paint, except one within a link
 *   (`placedAfterLinks`), which is corrected like a replan;
 * - a mark without trajectory, or under `prefers-reduced-motion`, is painted at its tick position.
 * The caller supplies the coordinates (`getTransform`); marks are found by `data-marker-key`.
 */

/** The fields of a mark this hook reads; a caller's own mark type extends them. */
export type TrajectoryAnimationFields = {
  /** The element's `data-marker-key`. */
  key: string;
  /**
   * The link's appointment as placed. Absent where nothing can be planned; the mark is then painted
   * at its tick position, corrected over where the placement allows.
   */
  trajectory?: RunSegmentTrajectory;
  /** Only travelled motion is animated. */
  motion: RunPlacementMotion;
  /** See `RunPlacement.placedAfterLinks`. */
  placedAfterLinks?: number;
  /** The tick's progress, which the base style is painted at. */
  progress: number;
  /** The caller's identity for the trajectory's stretch. */
  linkKey: string;
};

type KeptAnimation = {
  signature: string;
  geometrySignature: string | undefined;
  motion: RunPlacementMotion;
  animation: Animation;
};

/** The property a mark's position is stated in: its transform, or a stroke's dash offset. */
type AnimatedProperty = "transform" | "strokeDashoffset";

export function useVehicleTrajectoryAnimations<Mark extends TrajectoryAnimationFields>({
  container,
  marks,
  getTransform,
  getBoundaryProgresses,
  geometrySignature,
  property = "transform",
}: {
  container: RefObject<HTMLElement | null>;
  marks: readonly Mark[];
  /** The mark's position at a progress, in the caller's coordinates. */
  getTransform: (mark: Mark, progress: number) => string | undefined;
  /** Progresses keyframed on their own, per mark. */
  getBoundaryProgresses?: (mark: Mark) => readonly number[];
  /**
   * Identity of the measured geometry. A change recreates animations without carrying old paint, so
   * marks stay on the moved geometry. Undefined always carries the paint.
   */
  geometrySignature?: string;
  /** The property `getTransform` states; a lit stroke follows its mark by dash offset. */
  property?: AnimatedProperty;
}) {
  const animationsRef = useRef(new Map<string, KeptAnimation>());

  useLayoutEffect(() => {
    const layer = container.current;
    if (!layer) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const liveKeys = new Set<string>();
    for (const mark of marks) {
      liveKeys.add(mark.key);
      const element = layer.querySelector<HTMLElement | SVGElement>(
        `[data-marker-key="${CSS.escape(mark.key)}"]`,
      );
      if (!element) continue;
      const fromTransform = getTransform(mark, mark.progress);
      const toTransform = getTransform(mark, 1);
      if (reduceMotion || !fromTransform || !toTransform) {
        animationsRef.current.get(mark.key)?.animation.cancel();
        animationsRef.current.delete(mark.key);
        continue;
      }
      if (!mark.trajectory) {
        // No journey to plan. A correctable placement is carried over a few seconds from the old
        // animation's paint; anything else snaps to where it belongs.
        const signature = ["held", mark.linkKey, fromTransform, geometrySignature ?? ""].join(":");
        const active = animationsRef.current.get(mark.key);
        if (active?.signature === signature) continue;
        const corrective = mark.motion !== "placed" || isCorrectivePlacement(mark.placedAfterLinks);
        const paintedTransform =
          corrective && active && active.geometrySignature === geometrySignature
            ? getComputedStyle(element)[property]
            : undefined;
        active?.animation.cancel();
        animationsRef.current.delete(mark.key);
        if (!paintedTransform || paintedTransform === "none") continue;
        const animation = element.animate(
          [{ [property]: paintedTransform }, { [property]: fromTransform }],
          { duration: TRAJECTORY_CORRECTION_MS, easing: "linear", fill: "both" },
        );
        animationsRef.current.set(mark.key, {
          signature,
          geometrySignature,
          motion: mark.motion,
          animation,
        });
        continue;
      }
      const { trajectory } = mark;
      const plannedFromTransform = getTransform(mark, trajectory.startProgress);
      if (!plannedFromTransform) continue;
      const signature = [
        mark.linkKey,
        trajectory.startProgress,
        trajectory.startsAt,
        trajectory.arrivesAt,
        trajectory.startVelocity,
        trajectory.cruiseVelocity,
        trajectory.acceleratesUntil,
        trajectory.brakesFrom,
        plannedFromTransform,
        toTransform,
        geometrySignature ?? "",
      ].join(":");
      const active = animationsRef.current.get(mark.key);
      if (
        active?.signature === signature &&
        (mark.motion !== "placed" || active.motion === "placed")
      )
        continue;
      // A replan continues from the painted position, captured before cancelling. A placement does
      // not, except one within a link, which would otherwise blink. A geometry change does not
      // either.
      const isCorrective = mark.motion !== "placed" || isCorrectivePlacement(mark.placedAfterLinks);
      const paintedTransform =
        isCorrective && active && active.geometrySignature === geometrySignature
          ? getComputedStyle(element)[property]
          : undefined;
      active?.animation.cancel();

      const waitingMs = Math.max(0, trajectory.startsAt - trajectory.sampledAt);
      const animationStartsAt = waitingMs > 0 ? trajectory.startsAt : trajectory.sampledAt;
      // The first keyframe is the present position, so paint and animation agree from the first
      // frame.
      const movingFrom = getRunTrajectoryProgress(trajectory, animationStartsAt);
      const movingFromTransform = getTransform(mark, movingFrom);
      if (!movingFromTransform) continue;
      const movingDuration =
        waitingMs > 0
          ? trajectory.arrivesAt - trajectory.startsAt
          : trajectory.arrivesAt - trajectory.sampledAt;
      if (movingDuration <= 0 || movingFrom >= 1) continue;
      const keyframes = getTrajectoryKeyframes({
        trajectory,
        animationStartsAt,
        getTransform: (progress) => getTransform(mark, progress),
        boundaryProgresses: getBoundaryProgresses?.(mark) ?? [],
        paintedTransform:
          paintedTransform && paintedTransform !== "none" ? paintedTransform : undefined,
      });
      if (keyframes.length === 0) continue;
      const animation = element.animate(
        keyframes.map(({ transform, offset }) => ({ [property]: transform, offset })),
        {
          delay: waitingMs,
          duration: movingDuration,
          easing: "linear",
          fill: "both",
        },
      );
      animationsRef.current.set(mark.key, {
        signature,
        geometrySignature,
        motion: mark.motion,
        animation,
      });
    }
    for (const [key, active] of animationsRef.current) {
      if (liveKeys.has(key)) continue;
      active.animation.cancel();
      animationsRef.current.delete(key);
    }
  });

  useEffect(
    () => () => {
      for (const { animation } of animationsRef.current.values()) animation.cancel();
      animationsRef.current.clear();
    },
    [],
  );
}
