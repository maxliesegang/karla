import assert from "node:assert/strict";
import test from "node:test";
import type { RunSegmentTrajectory } from "../src/lib/vehicle-positioning.ts";
import {
  getTrajectoryKeyframes,
  isCorrectivePlacement,
  PLACEMENT_CORRECTION_MAX_LINKS,
} from "../src/lib/vehicle-trajectory-animation.ts";

const start = Date.parse("2026-08-23T10:00:00Z");

/** One 60-second link with the ramp share the placement plans its segments on. */
const trajectory: RunSegmentTrajectory = {
  startProgress: 0,
  startsAt: start,
  arrivesAt: start + 60_000,
  startVelocity: 0,
  cruiseVelocity: 1 / 51_000,
  acceleratesUntil: start + 9_000,
  brakesFrom: start + 51_000,
  sampledAt: start,
};

/** A transform that carries the progress it was asked for, so keyframes can be read back. */
const getTransform = (progress: number) => `t(${progress.toFixed(4)})`;
const readProgress = (transform: string) => Number(transform.slice(2, -1));

test("spans the link from the instant it starts at to the arrival, in order", () => {
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start + 10_000,
    getTransform,
  });
  assert.ok(keyframes.length > 3);
  assert.equal(keyframes[0]?.offset, 0);
  assert.equal(keyframes.at(-1)?.offset, 1);
  const offsets = keyframes.map(({ offset }) => offset);
  assert.deepEqual(
    [...offsets].sort((a, b) => a - b),
    offsets,
  );
  assert.equal(readProgress(keyframes.at(-1)?.transform ?? ""), 1);
  // No two keyframes share an instant: the compositor would interpolate nothing between them.
  assert.equal(new Set(offsets).size, offsets.length);
});

test("keyframes the crossings of the boundaries still ahead of the mark", () => {
  const without = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start,
    getTransform,
  });
  const withBoundary = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start,
    getTransform,
    boundaryProgresses: [0.5, -0.2, 1.2],
  });
  // One boundary lies on the link, one before its start, one past its end: only the first adds a
  // keyframe, and it stands where the crossing actually happens.
  assert.equal(withBoundary.length, without.length + 1);
  const crossed = withBoundary.map(({ transform }) => readProgress(transform));
  const atBoundary = crossed.find((progress) => Math.abs(progress - 0.5) < 0.001);
  assert.ok(atBoundary);
});

test("a replan starts from the paint the mark already carries", () => {
  const painted = "matrix(1, 0, 0, 1, 40, 12)";
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start + 20_000,
    getTransform,
    paintedTransform: painted,
  });
  assert.equal(keyframes[0]?.transform, painted);
  // The correction ends within the correction window, and from there the keyframes are computed.
  const computed = keyframes.slice(1).map(({ transform }) => transform);
  assert.ok(computed.every((transform) => transform.startsWith("t(")));
  const offsets = keyframes.map(({ offset }) => offset);
  assert.deepEqual(
    [...offsets].sort((a, b) => a - b),
    offsets,
  );
});

test("a link that has run out before the animation starts is not animated", () => {
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: trajectory.arrivesAt,
    getTransform,
  });
  assert.deepEqual(keyframes, []);
});

test("a drawing that cannot state a transform at a progress is not keyframed there", () => {
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start,
    getTransform: (progress) => (progress > 0.5 ? undefined : getTransform(progress)),
  });
  assert.ok(keyframes.length > 0);
  assert.ok(keyframes.every(({ transform }) => readProgress(transform) <= 0.5));
});

test("a placement within the correction band is corrective, and nothing else is", () => {
  // No travel stated: a first paint, with no drawn mark to correct from — snapped, as every
  // unmeasurable placement is. Within the band, a correction over; past it, a snap.
  assert.equal(isCorrectivePlacement(undefined), false);
  assert.equal(isCorrectivePlacement(0), true);
  assert.equal(isCorrectivePlacement(PLACEMENT_CORRECTION_MAX_LINKS), true);
  assert.equal(isCorrectivePlacement(PLACEMENT_CORRECTION_MAX_LINKS + 0.1), false);
});
