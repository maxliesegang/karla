import assert from "node:assert/strict";
import test from "node:test";
import { createDeparture } from "./support/fixtures";
import { createCall, run } from "./support/calls";
import {
  createRunMotions,
  getRunPlacement,
  getRunTrajectoryProgress,
} from "../src/lib/vehicle-positioning";
import { getTrajectoryKeyframes } from "../src/lib/vehicle-trajectory-animation";

const start = Date.parse("2026-10-07T10:00:00Z");
const call = createCall(start);
const reading = (arrival: number, delay = 0) =>
  createDeparture({
    tripId: "arrival-deadline",
    tripCalls: [call("a", 0, delay), call("b", arrival, delay), call("c", 6, delay)],
  });

test("an earlier revised arrival is reached by its deadline, including browser keyframes", () => {
  const motions = createRunMotions();
  getRunPlacement(motions, reading(4), start + 60_250);
  const revised = getRunPlacement(motions, reading(1.5), start + 61_250);
  assert.ok(revised?.trajectory);
  assert.equal(revised.trajectory.arrivesAt, start + 90_000);
  assert.equal(getRunTrajectoryProgress(revised.trajectory, start + 90_000), 1);
  assert.ok(getRunTrajectoryProgress(revised.trajectory, start + 89_999) < 1);
  const keyframes = getTrajectoryKeyframes({
    trajectory: revised.trajectory,
    animationStartsAt: start + 61_250,
    paintedValue: "old-paint",
    getValue: (progress) => String(progress),
  });
  assert.equal(keyframes.at(-1)?.value, "1");
  const arrived = getRunPlacement(motions, reading(1.5), start + 90_000);
  assert.equal(arrived?.fromStopId, "b");
  assert.equal(arrived?.progress, 0);
});

test("a later revised arrival slows movement and reaches the station at the revised instant", () => {
  const motions = createRunMotions();
  const before = getRunPlacement(motions, reading(2), start + 60_250);
  const revised = getRunPlacement(motions, reading(2, 1), start + 61_250);
  assert.ok(before && revised && revised.progress >= before.progress);
  for (let at = 62_250; at < 180_000; at += 1_000) {
    const placed = getRunPlacement(motions, reading(2, 1), start + at);
    assert.equal(placed?.fromStopId, "a");
    assert.ok(placed && placed.progress < 1);
  }
  const arrived = getRunPlacement(motions, reading(2, 1), start + 180_000);
  assert.equal(arrived?.fromStopId, "b");
  assert.equal(arrived?.progress, 0);
});

test("a marker already at the station waits there after the arrival is revised later", () => {
  const motions = createRunMotions();
  const arrived = getRunPlacement(motions, reading(2), start + 120_000);
  assert.equal(arrived?.fromStopId, "b");
  const delayed = reading(2, 2);
  for (const at of [121_000, 150_000, 239_000, 240_000]) {
    const held = getRunPlacement(motions, delayed, start + at);
    assert.equal(held?.fromStopId, "b");
    assert.equal(held?.progress, 0);
  }
});

test("a revision more than two links behind never relocates a departed marker backward", () => {
  const motions = createRunMotions();
  const trip = createDeparture({
    tripId: "large-backward-revision",
    tripCalls: run([call("a", 0), call("b", 2), call("c", 4), call("d", 6), call("e", 8)]),
  });
  const before = getRunPlacement(motions, trip, start + 420_000);
  assert.equal(before?.fromStopId, "d");
  const revised = {
    ...trip,
    tripCalls: trip.tripCalls?.map((entry) => ({ ...entry, delayMinutes: 10 })),
  };
  const after = getRunPlacement(motions, revised, start + 421_000);
  assert.equal(after?.fromStopId, "d");
  assert.ok(before && after && after.progress >= before.progress);
});

test("a revised arrival already in the past permits a forward placement immediately", () => {
  const motions = createRunMotions();
  getRunPlacement(motions, reading(4), start + 60_000);
  const corrected = getRunPlacement(motions, reading(1), start + 61_000);
  assert.equal(corrected?.fromStopId, "b");
  assert.equal(corrected?.progress, 0);
  assert.equal(corrected?.motion, "placed");
  assert.equal(corrected?.placedAfterLinks, undefined);
});
