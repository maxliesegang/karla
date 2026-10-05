import assert from "node:assert/strict";
import test from "node:test";
import {
  getRunDiscoveryPosts,
  isRunInArea,
  RUN_DISCOVERY_APPROACH_MS,
} from "../src/lib/run-discovery.ts";
import type { TripCall } from "../src/data/transit-types.ts";
import { createDeparture } from "./support/fixtures.ts";

const start = Date.parse("2026-10-05T12:00:00Z");
const call = (localStopId: string, minute: number, terminus = false): TripCall => ({
  localStopId,
  stopName: localStopId,
  scheduledArrivalTime: new Date(start + minute * 60_000).toISOString(),
  scheduledDepartureTime: terminus ? undefined : new Date(start + minute * 60_000).toISOString(),
});
const run = (calls: readonly TripCall[]) => createDeparture({ tripCalls: calls });

test("the same one-sided map stop is a departure post for through runs and an arrival post for terminating runs", () => {
  const area = ["a", "b"];
  assert.deepEqual(
    getRunDiscoveryPosts(area, [run([call("a", 0), call("b", 1), call("outside", 2)])]),
    [{ stopId: "b", eventKind: "departure" }],
  );
  assert.deepEqual(getRunDiscoveryPosts(area, [run([call("a", 0), call("b", 1, true)])]), [
    { stopId: "b", eventKind: "arrival" },
    { stopId: "b", eventKind: "departure" },
  ]);
});

test("all exits are covered when a run leaves and returns, including an internal short turn", () => {
  assert.deepEqual(
    getRunDiscoveryPosts(
      ["a", "b", "c"],
      [run([call("a", 0), call("outside", 1), call("b", 2), call("c", 3, true)])],
    ),
    [
      { stopId: "a", eventKind: "departure" },
      { stopId: "c", eventKind: "arrival" },
      { stopId: "c", eventKind: "departure" },
    ],
  );
});

test("an incomplete sequence does not invent a terminus, and vanished service removes its posts", () => {
  assert.deepEqual(getRunDiscoveryPosts(["a", "b"], [run([call("a", 0), call("b", 1)])]), []);
  assert.deepEqual(getRunDiscoveryPosts(["a", "b"], []), []);
  const cancelled = createDeparture({ status: "cancelled", tripCalls: [call("a", 0, true)] });
  assert.deepEqual(getRunDiscoveryPosts(["a"], [cancelled]), []);
});

test("area retention includes approaches and re-entry, but ends before a distant terminus", () => {
  const area = new Set(["a", "b"]);
  const trip = run([call("a", 0), call("outside", 1), call("b", 20), call("far-end", 80, true)]);
  assert.equal(isRunInArea(trip, start - RUN_DISCOVERY_APPROACH_MS - 1, area), false);
  assert.equal(isRunInArea(trip, start - RUN_DISCOVERY_APPROACH_MS, area), true);
  assert.equal(isRunInArea(trip, start + 5 * 60_000, area), false);
  assert.equal(isRunInArea(trip, start + 15 * 60_000, area), true);
  assert.equal(isRunInArea(trip, start + 23 * 60_000, area), false);
});
