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
 * Animates vehicle trajectories and short corrections, preserving painted progress across replans
 * and resizes. Marks are found by `data-marker-key`.
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
  trajectory?: RunSegmentTrajectory;
  sampledAt?: number;
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
        trajectory.progresses.length,
        trajectory.progresses[trajectory.progresses.length - 1],
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
      const elapsed = active?.animation.currentTime;
      const sampledAt =
        active?.trajectory?.progresses === trajectory.progresses &&
        active.sampledAt !== undefined &&
        typeof elapsed === "number"
          ? Math.max(trajectory.sampledAt, active.sampledAt + elapsed)
          : trajectory.sampledAt;
      active?.animation.cancel();
      animationsRef.current.delete(mark.key);

      const waitingMs = Math.max(0, trajectory.startsAt - sampledAt);
      const animationStartsAt = waitingMs > 0 ? trajectory.startsAt : sampledAt;
      // The first keyframe is the present position, so paint and animation agree from the first
      // frame.
      const movingFrom = getRunTrajectoryProgress(trajectory, animationStartsAt);
      const movingFromValue = getValue(mark, movingFrom);
      if (!movingFromValue) continue;
      const movingDuration =
        waitingMs > 0
          ? trajectory.arrivesAt - trajectory.startsAt
          : trajectory.arrivesAt - sampledAt;
      const keyframes =
        movingDuration <= 0 || movingFrom >= 1
          ? [{ value: movingFromValue, offset: 0 }]
          : getTrajectoryKeyframes({
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
          duration: Math.max(0, movingDuration),
          easing: "linear",
          fill: "both",
        },
      );
      animationsRef.current.set(mark.key, {
        signature,
        linkKey: mark.linkKey,
        geometrySignature,
        motion: mark.motion,
        trajectory,
        sampledAt,
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
