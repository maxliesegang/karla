import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  getCurrentLineVehicleDepartures,
  updateLineVehicleObservations,
} from "../src/lib/line-vehicle-observations.ts";
import { createCall } from "./support/calls.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

function departure(
  id: string,
  calls: readonly TripCall[],
  status: Departure["status"] = "realtime",
): Departure {
  return {
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status,
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: calls,
  };
}

test("keeps a trip after its observation board stops listing it", () => {
  const trip = departure("retained", [call("a", 0), call("b", 5), call("c", 10)]);
  const observations = updateLineVehicleObservations([], [trip], start, start + 60_000);

  assert.deepEqual(
    getCurrentLineVehicleDepartures(observations, [], start + 6 * 60_000).map(({ id }) => id),
    ["retained"],
  );
});

test("expires a retained trip after its delayed final call and grace period", () => {
  const trip = departure("expired", [call("a", 0), call("b", 10, 3)]);
  const observations = updateLineVehicleObservations([], [trip], start, start + 60_000);

  assert.equal(getCurrentLineVehicleDepartures(observations, [], start + 16 * 60_000).length, 0);
});

test("a current cancellation removes the retained vehicle", () => {
  const running = departure("cancelled", [call("a", 0), call("b", 10)]);
  const cancelled = departure("cancelled", running.tripCalls ?? [], "cancelled");
  const observed = updateLineVehicleObservations([], [running], start, start + 60_000);
  const updated = updateLineVehicleObservations(
    observed,
    [cancelled],
    start + 30_000,
    start + 90_000,
  );

  assert.equal(updated.length, 0);
  assert.equal(getCurrentLineVehicleDepartures(observed, [cancelled], start + 90_000).length, 0);
});

test("a fresh observation replaces retained delay readings", () => {
  const original = departure("updated", [call("a", 0), call("b", 10)]);
  const delayed = departure("updated", [call("a", 0), call("b", 10, 4)]);
  const first = updateLineVehicleObservations([], [original], start, start + 60_000);
  const second = updateLineVehicleObservations(first, [delayed], start + 30_000, start + 90_000);

  assert.equal(second[0]?.departure.tripCalls?.[1]?.delayMinutes, 4);
  assert.deepEqual(getCurrentLineVehicleDepartures(second, [delayed], start + 90_000), [delayed]);
});

test("shows a current placeable observation even when its final call cannot define retention", () => {
  const incomplete = departure("incomplete", [
    call("a", 0),
    call("b", 5),
    { stopName: "C", localStopId: "c" },
  ]);

  assert.equal(updateLineVehicleObservations([], [incomplete], start, start + 60_000).length, 0);
  assert.deepEqual(getCurrentLineVehicleDepartures([], [incomplete], start + 60_000), [incomplete]);
});

test("bounds retained vehicle observations", () => {
  const trips = Array.from({ length: 4 }, (_, index) =>
    departure(`capacity-${index}`, [call("a", 0), call("b", 10)]),
  );

  assert.equal(updateLineVehicleObservations([], trips, start, start + 60_000, 2).length, 2);
});

test("stamps each trip with the age of the board it came from, not the freshest one in hand", () => {
  // The diagram reads the core observation and the line's own boards on different cadences, so the
  // two arrive minutes apart. One instant across both would have a stale trip dead-reckoned from a
  // time it was never read at, which is exactly how a mark drifts away from the vehicle.
  const fresh = departure("fresh", [call("a", 0), call("b", 5), call("c", 10)]);
  const stale = departure("stale", [call("a", 1), call("b", 6), call("c", 11)]);
  const readAt = new Map<Departure, number>([
    [fresh, start],
    [stale, start - 5 * 60_000],
  ]);

  const observations = updateLineVehicleObservations(
    [],
    [fresh, stale],
    (candidate) => readAt.get(candidate) ?? 0,
    start + 60_000,
  );

  const observedById = new Map(
    observations.map((observation) => [observation.departure.id, observation.observedAt]),
  );
  assert.equal(observedById.get("fresh"), start);
  assert.equal(observedById.get("stale"), start - 5 * 60_000);
});

test("a single instant still stamps every trip in a batch read off one board", () => {
  const first = departure("first", [call("a", 0), call("b", 5)]);
  const second = departure("second", [call("a", 2), call("b", 7)]);

  const observations = updateLineVehicleObservations([], [first, second], start, start + 60_000);

  assert.deepEqual([...new Set(observations.map(({ observedAt }) => observedAt))], [start]);
});
