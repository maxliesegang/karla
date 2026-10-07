import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import {
  useVehicleTrajectoryAnimations,
  type TrajectoryAnimationFields,
} from "../src/hooks/vehicle-trajectory-animation.ts";
import { createRunMotions, getRunPlacement } from "../src/lib/vehicle-positioning";
import { createCall } from "./support/calls";
import { createDeparture } from "./support/fixtures";

const start = Date.parse("2026-10-06T10:00:00Z");
const progresses = Array.from({ length: 61 }, (_, second) => second / 60);
const mark: TrajectoryAnimationFields = {
  key: "vehicle",
  linkKey: "a-b",
  motion: "travelled",
  progress: 1 / 3,
  trajectory: {
    startsAt: start,
    startProgress: 0,
    progresses,
    arrivesAt: start + 60_000,
    sampledAt: start + 20_000,
  },
};

test("a resize keeps the progress the animation has reached between clock ticks", async (t) => {
  const container = document.createElement("div");
  const element = document.createElement("div");
  element.dataset.markerKey = mark.key;
  container.append(element);
  const animations: Animation[] = [];
  const keyframes: Keyframe[][] = [];
  t.mock.method(element, "animate", (frames: Keyframe[]) => {
    const animation = new Animation();
    animations.push(animation);
    keyframes.push(frames);
    return animation;
  });
  const hook = await renderHook<string, void>(
    (geometrySignature: string) =>
      useVehicleTrajectoryAnimations({
        container: { current: container },
        marks: [mark],
        geometrySignature,
        getValue: (_, progress) => `translateX(${progress * 100}px)`,
      }),
    "1200",
  );
  try {
    assert.equal(animations.length, 1);
    animations[0].currentTime = 800;
    await hook.rerender("1200");
    assert.equal(animations.length, 1);
    await hook.rerender("900");
    assert.equal(animations.length, 2);
    const transform = String(keyframes[1][0].transform);
    const pixels = Number(transform.slice("translateX(".length, -3));
    assert.ok(Math.abs(pixels - (20.8 / 60) * 100) < 1e-9);
    animations[1].currentTime = 40_000;
    await hook.rerender("700");
    assert.equal(animations.length, 3);
    assert.equal(keyframes[2][0].transform, "translateX(100px)");
  } finally {
    await hook.unmount();
  }
});

test("a revised arrival gives the browser an animation ending exactly at the station deadline", async (t) => {
  const call = createCall(start);
  const run = (arrival: number) =>
    createDeparture({
      tripId: "browser-arrival",
      tripCalls: [call("a", 0), call("b", arrival), call("c", 6)],
    });
  const motions = createRunMotions();
  const before = getRunPlacement(motions, run(4), start + 60_250);
  const after = getRunPlacement(motions, run(1.5), start + 61_250);
  assert.ok(before?.trajectory && after?.trajectory);
  const container = document.createElement("div");
  const element = document.createElement("div");
  element.dataset.markerKey = "browser-arrival";
  container.append(element);
  const frames: Keyframe[][] = [];
  const timings: KeyframeAnimationOptions[] = [];
  t.mock.method(element, "animate", (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    frames.push(keyframes);
    timings.push(options);
    return new Animation();
  });
  const toMark = (placement: NonNullable<ReturnType<typeof getRunPlacement>>) => ({
    ...placement,
    key: "browser-arrival",
    linkKey: "a-b",
  });
  const hook = await renderHook<TrajectoryAnimationFields, void>(
    (mark) =>
      useVehicleTrajectoryAnimations({
        container: { current: container },
        marks: [mark],
        getValue: (_, progress) => `translateX(${progress * 100}px)`,
      }),
    toMark(before),
  );
  try {
    await hook.rerender(toMark(after));
    assert.equal(timings.at(-1)?.duration, 28_750);
    assert.equal(frames.at(-1)?.at(-1)?.transform, "translateX(100px)");
    assert.equal(frames.at(-1)?.at(-1)?.offset, 1);
  } finally {
    await hook.unmount();
  }
});
