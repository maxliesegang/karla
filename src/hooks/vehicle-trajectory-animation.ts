import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  getTripTrajectoryProgress,
  type TripPlacementMotion,
  type TripSegmentTrajectory,
} from "../lib/vehicle-positioning";
import { isCorrectivePlacement, getTrajectoryKeyframes } from "../lib/vehicle-trajectory-animation";

/**
 * One mark's segment-length Web Animation, kept for it between renders.
 *
 * This is the choreography both drawings that animate a mark share (`LineDiagramVehicleLayer` and
 * the Zentrum's vehicle map): the domain places a mark on a link with an appointment —
 * `TripSegmentTrajectory` — and the browser runs it as one animation, not as a succession of
 * one-second transitions. What is shared here is everything about *how* an animation is kept:
 *
 * - A signature over the trajectory's plan and the drawing's own coordinates decides whether the
 *   running animation is still the appointment in hand. Time passing re-renders the same signature
 *   and re-uses the animation; only a replan or a moved link cancels and recreates it.
 * - A replan continues from the transform the mark is painted at, so the remaining ground is
 *   corrected over a few seconds rather than snapping (`lib/vehicle-trajectory-animation.ts`).
 * - A placement — `motion: "placed"`, the reading having found the vehicle somewhere else — is
 *   never animated from the old paint, and never reuses an animation that had travelled: the two
 *   are indistinguishable from coordinates alone, and only the placement knows which happened.
 *   The placement that barely moved the mark states how far it moved it
 *   (`TripPlacement.placedAfterLinks`), and within a link it is corrected over the same few
 *   seconds a replan is — a snap there would read as a blink, not as a statement.
 * - A mark with no trajectory, and every mark under `prefers-reduced-motion`, stand still and are
 *   painted at the position their tick evaluated; their animations, if any, are cancelled.
 *
 * What is *not* shared is the coordinate system: the caller states where its mark stands at a
 * progress (`getTransform`) and which boundaries deserve their own keyframes. Marks are found by
 * their `data-marker-key` inside the container, so the caller renders them as it likes.
 */

/** The fields of a mark this hook reads; a caller's own mark type extends them. */
export type TrajectoryAnimationFields = {
  /** The mark's element, found by its `data-marker-key` in the container. */
  key: string;
  /** The link's motion as one appointment with its next stop, as the placement sampled it. */
  trajectory: TripSegmentTrajectory;
  /** How the mark got here: only travelled motion is animated as a journey. */
  motion: TripPlacementMotion;
  /**
   * How far a placement put the mark from where it was drawn, in links of the trip's own calls —
   * the placement's own statement of whether it may be corrected over rather than snapped. See
   * `TripPlacement.placedAfterLinks`.
   */
  placedAfterLinks?: number;
  /** The progress the mark's tick evaluated, which its base style is painted at. */
  progress: number;
  /** The caller's identity of the stretch the trajectory runs on, in its own coordinates. */
  linkKey: string;
};

type KeptAnimation = {
  signature: string;
  geometrySignature: string | undefined;
  motion: TripPlacementMotion;
  animation: Animation;
};

export function useVehicleTrajectoryAnimations<Mark extends TrajectoryAnimationFields>({
  container,
  marks,
  getTransform,
  getBoundaryProgresses,
  geometrySignature,
}: {
  /** The element the marks are rendered in, and that animations are attached within. */
  container: RefObject<HTMLElement | null>;
  marks: readonly Mark[];
  /** The mark's whole position at a progress, in the caller's own coordinate system. */
  getTransform: (mark: Mark, progress: number) => string | undefined;
  /** Progresses whose crossings are keyframed on their own clock, per mark. */
  getBoundaryProgresses?: (mark: Mark) => readonly number[];
  /**
   * Identity of the measured geometry the transforms are painted in. A change re-measures the
   * drawing: animations are recreated without carrying the old paint, so a mark stays attached to
   * the geometry that moved under it rather than visibly travelling through a layout change.
   * Left undefined, as for a drawing that states its own coordinates in live units, the paint is
   * always carried.
   */
  geometrySignature?: string;
}) {
  const animationsRef = useRef(new Map<string, KeptAnimation>());

  useLayoutEffect(() => {
    const layer = container.current;
    if (!layer) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const liveKeys = new Set<string>();
    for (const mark of marks) {
      liveKeys.add(mark.key);
      const element = layer.querySelector<HTMLElement>(
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
      // Replanning should continue from what the rider is actually looking at. The domain sample
      // and the compositor normally agree, but a refresh can land between their clocks. Capturing
      // the presentation before cancellation removes that small but conspicuous discontinuity.
      // A placement is deliberately different: the reading found the vehicle somewhere else, so
      // carrying the old paint into the new animation would invent a journey between those places.
      // The exception is the placement that barely moved the mark — the reading found the vehicle
      // a little away from where it stood — which is corrected over the same few seconds a replan
      // is, because there a snap is not a statement of anything; it is a blink.
      // Geometry changes are different again: the drawing itself moved, so the mark must stay
      // attached to it rather than visibly travelling through a layout change.
      const isCorrective = mark.motion !== "placed" || isCorrectivePlacement(mark.placedAfterLinks);
      const paintedTransform =
        isCorrective && active && active.geometrySignature === geometrySignature
          ? getComputedStyle(element).transform
          : undefined;
      active?.animation.cancel();

      const waitingMs = Math.max(0, trajectory.startsAt - trajectory.sampledAt);
      const animationStartsAt = waitingMs > 0 ? trajectory.startsAt : trajectory.sampledAt;
      // The first keyframe is where the mark stands at that instant, so the painted mark and the
      // animation agree about the present moment from the frame the animation starts in.
      const movingFrom = getTripTrajectoryProgress(trajectory, animationStartsAt);
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
      const animation = element.animate(keyframes, {
        delay: waitingMs,
        duration: movingDuration,
        easing: "linear",
        fill: "both",
      });
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
