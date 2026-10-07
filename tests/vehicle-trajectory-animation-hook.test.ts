import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import {
  useVehicleTrajectoryAnimations,
  type TrajectoryAnimationFields,
} from "../src/hooks/vehicle-trajectory-animation.ts";

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
    assert.equal(keyframes[1][0].transform, `translateX(${(20.8 / 60) * 100}px)`);
    animations[1].currentTime = 40_000;
    await hook.rerender("700");
    assert.equal(animations.length, 3);
    assert.equal(keyframes[2][0].transform, "translateX(100px)");
  } finally {
    await hook.unmount();
  }
});
