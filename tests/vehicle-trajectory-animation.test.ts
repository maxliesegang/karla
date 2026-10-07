import assert from "node:assert/strict";
import test from "node:test";
import type { RunSegmentTrajectory } from "../src/lib/vehicle-positioning.ts";
import {
  canReuseAnimatedValue,
  getTrajectoryKeyframes,
  isCorrectivePlacement,
  PLACEMENT_CORRECTION_MAX_LINKS,
  TRAJECTORY_CORRECTION_MS,
} from "../src/lib/vehicle-trajectory-animation.ts";

const start = Date.parse("2026-08-23T10:00:00Z");

/** One 60-second link sampled every second, as the placement plans it. */
const progresses = Array.from({ length: 61 }, (_, second) => second / 60);
const trajectory: RunSegmentTrajectory = {
  startsAt: start,
  progresses,
  startProgress: 0,
  arrivesAt: start + 60_000,
  sampledAt: start,
};

/** A transform that carries the progress it was asked for, so keyframes can be read back. */
const getValue = (progress: number) => `t(${progress.toFixed(4)})`;
const readProgress = (transform: string) => Number(transform.slice(2, -1));

test("spans the link from the instant it starts at to the arrival, in order", () => {
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start + 10_000,
    getValue,
  });
  assert.ok(keyframes.length > 3);
  assert.equal(keyframes[0]?.offset, 0);
  assert.equal(keyframes.at(-1)?.offset, 1);
  const offsets = keyframes.map(({ offset }) => offset);
  assert.deepEqual(
    [...offsets].sort((a, b) => a - b),
    offsets,
  );
  assert.equal(readProgress(keyframes.at(-1)?.value ?? ""), 1);
  // No two keyframes share an instant: the compositor would interpolate nothing between them.
  assert.equal(new Set(offsets).size, offsets.length);
});

test("keyframes the crossings of the boundaries still ahead of the mark", () => {
  const without = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start,
    getValue,
  });
  const withBoundary = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start,
    getValue,
    boundaryProgresses: [0.505, -0.2, 1.2],
  });
  // One boundary lies on the link, one before its start, one past its end: only the first adds a
  // keyframe, and it stands where the crossing actually happens.
  assert.equal(withBoundary.length, without.length + 1);
  const crossed = withBoundary.map(({ value }) => readProgress(value));
  const atBoundary = crossed.find((progress) => Math.abs(progress - 0.505) < 0.001);
  assert.ok(atBoundary);
});

test("a replan starts from the paint the mark already carries", () => {
  const painted = "matrix(1, 0, 0, 1, 40, 12)";
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start + 20_000,
    getValue,
    paintedValue: painted,
  });
  assert.equal(keyframes[0]?.value, painted);
  // The correction ends within the correction window, and from there the keyframes are computed.
  const computed = keyframes.slice(1).map(({ value }) => value);
  assert.ok(computed.every((transform) => transform.startsWith("t(")));
  const offsets = keyframes.map(({ offset }) => offset);
  assert.deepEqual(
    [...offsets].sort((a, b) => a - b),
    offsets,
  );
});

test("a replan lets the trajectory catch the paint before resuming its samples", () => {
  const animationStartsAt = start + 20_000;
  const paintedProgress = 0.36;
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt,
    getValue,
    paintedValue: getValue(paintedProgress),
    boundaryProgresses: [0.35, 0.375, 0.5],
  });
  const correctionOffset = TRAJECTORY_CORRECTION_MS / (trajectory.arrivesAt - animationStartsAt);
  assert.equal(keyframes[1]?.offset, correctionOffset);
  const progresses = keyframes.map(({ value }) => readProgress(value));
  assert.deepEqual(
    progresses,
    [...progresses].sort((a, b) => a - b),
  );
});

test("a link that has run out before the animation starts is not animated", () => {
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: trajectory.arrivesAt,
    getValue,
  });
  assert.deepEqual(keyframes, []);
});

test("a drawing that cannot state a transform at a progress is not keyframed there", () => {
  const keyframes = getTrajectoryKeyframes({
    trajectory,
    animationStartsAt: start,
    getValue: (progress) => (progress > 0.5 ? undefined : getValue(progress)),
  });
  assert.ok(keyframes.length > 0);
  assert.ok(keyframes.every(({ value }) => readProgress(value) <= 0.5));
});

test("a placement within the correction band is corrective, and nothing else is", () => {
  // No travel stated: a first paint, with no drawn mark to correct from — snapped, as every
  // unmeasurable placement is. Within the band, a correction over; past it, a snap.
  assert.equal(isCorrectivePlacement(undefined), false);
  assert.equal(isCorrectivePlacement(0), true);
  assert.equal(isCorrectivePlacement(PLACEMENT_CORRECTION_MAX_LINKS), true);
  assert.equal(isCorrectivePlacement(PLACEMENT_CORRECTION_MAX_LINKS + 0.1), false);
});

test("a lit stretch's dash offset is not carried onto the next link", () => {
  // Arrived at a stop, the old stretch is drained; held as the new link's start, it would leave the
  // way ahead unlit until departure.
  assert.equal(canReuseAnimatedValue("strokeDashoffset", "a-b", "b-c"), false);
  assert.equal(canReuseAnimatedValue("strokeDashoffset", "a-b", "a-b"), true);
  assert.equal(canReuseAnimatedValue("transform", "a-b", "b-c"), true);
});
