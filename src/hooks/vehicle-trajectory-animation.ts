import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  getRunTrajectoryProgress,
  type RunPlacementMotion,
  type RunSegmentTrajectory,
} from "../lib/vehicle-positioning";
import {
  type TrajectoryAnimationProperty,
  canReuseAnimatedValue,
  isCorrectivePlacement,
  getTrajectoryKeyframes,
  TRAJECTORY_CORRECTION_MS,
} from "../lib/vehicle-trajectory-animation";

/**
 * One mark's segment-length Web Animation, shared by the line diagram and the Zentrum map:
 * - a signature over the plan and coordinates decides whether the running animation still applies;
 * - a replan continues from the painted value, correcting over a few seconds;
 * - a placement is never animated from the old paint, except one within a link
 *   (`placedAfterLinks`), which is corrected like a replan;
 * - a mark without trajectory, or under `prefers-reduced-motion`, is painted at its tick position.
 * The caller supplies the property values (`getValue`); marks are found by `data-marker-key`.
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
  linkKey: string;
  geometrySignature: string | undefined;
  motion: RunPlacementMotion;
  animation: Animation;
};

export function useVehicleTrajectoryAnimations<Mark extends TrajectoryAnimationFields>({
  container,
  marks,
  getValue,
  getBoundaryProgresses,
  geometrySignature,
  property = "transform",
}: {
  container: RefObject<HTMLElement | null>;
  marks: readonly Mark[];
  /** The animated property value at a progress. */
  getValue: (mark: Mark, progress: number) => string | undefined;
  /** Progresses keyframed on their own, per mark. */
  getBoundaryProgresses?: (mark: Mark) => readonly number[];
  /**
   * Identity of the measured geometry. A change recreates animations without carrying old paint, so
   * marks stay on the moved geometry. Undefined always carries the paint.
   */
  geometrySignature?: string;
  /** The property `getValue` states; a lit stroke follows its mark by dash offset. */
  property?: TrajectoryAnimationProperty;
}) {
  const animationsRef = useRef(new Map<string, KeptAnimation>());

  useLayoutEffect(() => {
    const layer = container.current;
    if (!layer) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const liveKeys = new Set<string>();
    // A replan continues from the painted position, captured before cancelling. A placement does
    // not, except one within a link, which would otherwise blink. A geometry change does not either.
    const readReusableAnimatedValue = (
      element: HTMLElement | SVGElement,
      mark: Mark,
      active: KeptAnimation | undefined,
    ): string | undefined => {
      const isCorrective = mark.motion !== "placed" || isCorrectivePlacement(mark.placedAfterLinks);
      if (
        !isCorrective ||
        !active ||
        active.geometrySignature !== geometrySignature ||
        !canReuseAnimatedValue(property, active.linkKey, mark.linkKey)
      )
        return undefined;
      const painted = getComputedStyle(element)[property];
      return painted === "none" ? undefined : painted;
    };
    for (const mark of marks) {
      liveKeys.add(mark.key);
      const element = layer.querySelector<HTMLElement | SVGElement>(
        `[data-marker-key="${CSS.escape(mark.key)}"]`,
      );
      if (!element) continue;
      const fromValue = getValue(mark, mark.progress);
      const toValue = getValue(mark, 1);
      if (reduceMotion || !fromValue || !toValue) {
        animationsRef.current.get(mark.key)?.animation.cancel();
        animationsRef.current.delete(mark.key);
        continue;
      }
      if (!mark.trajectory) {
        // No journey to plan. A correctable placement is carried over a few seconds from the old
        // animation's paint; anything else snaps to where it belongs.
        const signature = ["held", mark.linkKey, fromValue, geometrySignature ?? ""].join(":");
        const active = animationsRef.current.get(mark.key);
        if (active?.signature === signature) continue;
        const paintedValue = readReusableAnimatedValue(element, mark, active);
        active?.animation.cancel();
        animationsRef.current.delete(mark.key);
        if (!paintedValue) continue;
        const animation = element.animate(
          [{ [property]: paintedValue }, { [property]: fromValue }],
          { duration: TRAJECTORY_CORRECTION_MS, easing: "linear", fill: "both" },
        );
        animationsRef.current.set(mark.key, {
          signature,
          linkKey: mark.linkKey,
          geometrySignature,
          motion: mark.motion,
          animation,
        });
        continue;
      }
      const { trajectory } = mark;
      const plannedFromValue = getValue(mark, trajectory.startProgress);
      if (!plannedFromValue) continue;
      const signature = [
        mark.linkKey,
        trajectory.startProgress,
        trajectory.startsAt,
        trajectory.arrivesAt,
        trajectory.startVelocity,
        trajectory.cruiseVelocity,
        trajectory.acceleratesUntil,
        trajectory.brakesFrom,
        plannedFromValue,
        toValue,
        geometrySignature ?? "",
      ].join(":");
      const active = animationsRef.current.get(mark.key);
      if (
        active?.signature === signature &&
        (mark.motion !== "placed" || active.motion === "placed")
      )
        continue;
      const paintedValue = readReusableAnimatedValue(element, mark, active);
      active?.animation.cancel();

      const waitingMs = Math.max(0, trajectory.startsAt - trajectory.sampledAt);
      const animationStartsAt = waitingMs > 0 ? trajectory.startsAt : trajectory.sampledAt;
      // The first keyframe is the present position, so paint and animation agree from the first
      // frame.
      const movingFrom = getRunTrajectoryProgress(trajectory, animationStartsAt);
      const movingFromValue = getValue(mark, movingFrom);
      if (!movingFromValue) continue;
      const movingDuration =
        waitingMs > 0
          ? trajectory.arrivesAt - trajectory.startsAt
          : trajectory.arrivesAt - trajectory.sampledAt;
      if (movingDuration <= 0 || movingFrom >= 1) continue;
      const keyframes = getTrajectoryKeyframes({
        trajectory,
        animationStartsAt,
        getValue: (progress) => getValue(mark, progress),
        boundaryProgresses: getBoundaryProgresses?.(mark) ?? [],
        paintedValue,
      });
      if (keyframes.length === 0) continue;
      const animation = element.animate(
        keyframes.map(({ value, offset }) => ({ [property]: value, offset })),
        {
          delay: waitingMs,
          duration: movingDuration,
          easing: "linear",
          fill: "both",
        },
      );
      animationsRef.current.set(mark.key, {
        signature,
        linkKey: mark.linkKey,
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
