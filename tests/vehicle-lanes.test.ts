import assert from "node:assert/strict";
import test from "node:test";
import { assignStableVehicleLanes } from "../src/lib/vehicle-lanes.ts";

const vehicle = (markerKey: string, laneIndex: number, fromIndex = 0, toIndex = 1) => ({
  markerKey,
  laneIndex,
  fromIndex,
  toIndex,
  directionArrow: "↓" as const,
});

test("keeps existing vehicles in their lanes when another vehicle leaves the link", () => {
  const first = assignStableVehicleLanes(
    [vehicle("first", 0), vehicle("second", 1), vehicle("third", 2)],
    new Map(),
  );
  const next = assignStableVehicleLanes(
    [vehicle("second", 0), vehicle("third", 1)],
    first.assignments,
  );

  assert.deepEqual(
    next.vehicles.map(({ markerKey, laneIndex }) => [markerKey, laneIndex]),
    [
      ["second", 1],
      ["third", 2],
    ],
  );
});

test("gives a newcomer the first lane that existing vehicles left free", () => {
  const first = assignStableVehicleLanes(
    [vehicle("first", 0), vehicle("second", 1), vehicle("third", 2)],
    new Map(),
  );
  const next = assignStableVehicleLanes(
    [vehicle("second", 0), vehicle("new", 1), vehicle("third", 2)],
    first.assignments,
  );

  assert.deepEqual(
    next.vehicles.map(({ markerKey, laneIndex }) => [markerKey, laneIndex]),
    [
      ["second", 1],
      ["new", 0],
      ["third", 2],
    ],
  );
});

test("chooses a fresh lane when a vehicle moves onto another link", () => {
  const first = assignStableVehicleLanes([vehicle("moving", 2)], new Map());
  const next = assignStableVehicleLanes([vehicle("moving", 2, 1, 2)], first.assignments);

  assert.equal(next.vehicles[0].laneIndex, 0);
});
