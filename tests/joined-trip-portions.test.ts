import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getJoinedTripPortionPairs } from "../src/lib/joined-trip-portions.ts";

const start = Date.parse("2026-08-26T12:00:00Z");

function call(stopId: string, minute: number, hasDeparture = true): TripCall {
  const time = new Date(start + minute * 60_000).toISOString();
  return {
    stopName: stopId.toUpperCase(),
    localStopId: stopId,
    scheduledArrivalTime: time,
    scheduledDepartureTime: hasDeparture ? time : undefined,
  };
}

function departure(id: string, destination: string, calls: readonly TripCall[]): Departure {
  return {
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    trainNumber: "85653",
    lineId: "S8",
    transportMode: "lightRail",
    destination,
    minutesUntilDeparture: 10,
    platformCode: "24",
    boardingLocalStopId: "hauptbahnhof",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: calls,
  };
}

test("recognises a separately addressed portion that terminates along a shared timed route", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("freudenstadt", 30, false)];
  const terminating = departure("short", "Freudenstadt Hbf", shared);
  const continuing = departure("long", "Bondorf", [
    ...shared.slice(0, -1),
    call("freudenstadt", 30),
    call("eutingen", 40),
    call("bondorf", 50, false),
  ]);

  const [joined] = getJoinedTripPortionPairs([terminating, continuing]);

  assert.equal(joined?.terminating, terminating);
  assert.equal(joined?.continuing, continuing);
  assert.equal(joined?.sharedUntil.localStopId, "freudenstadt");
});

test("treats a missing time on one portion as unknown when later shared calls confirm it", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30), call("e", 40)];
  const terminating = departure("short", "E", [
    { ...shared[0], scheduledArrivalTime: undefined, scheduledDepartureTime: undefined },
    ...shared.slice(1),
  ]);
  const continuing = departure("long", "F", [...shared, call("f", 50)]);

  assert.equal(getJoinedTripPortionPairs([terminating, continuing]).length, 1);
});

test("uses the shared train number and route when one portion has no valid call times", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const terminating = departure(
    "short",
    "D",
    shared.map((tripCall) => ({
      ...tripCall,
      scheduledArrivalTime: undefined,
      scheduledDepartureTime: undefined,
    })),
  );
  const continuing = departure("long", "E", [...shared, call("e", 40)]);

  assert.equal(getJoinedTripPortionPairs([terminating, continuing]).length, 1);
});

test("does not infer joining for branches, identical routes or mismatched passage times", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const base = departure("base", "D", shared);

  assert.deepEqual(
    getJoinedTripPortionPairs([
      base,
      departure("branch", "E", [...shared.slice(0, -1), call("e", 30), call("f", 40)]),
    ]),
    [],
  );
  assert.deepEqual(getJoinedTripPortionPairs([base, departure("duplicate", "D", shared)]), []);
  assert.deepEqual(
    getJoinedTripPortionPairs([
      base,
      departure("later", "E", [...shared.slice(0, -1), call("d", 31), call("e", 40)]),
    ]),
    [],
  );
});

test("does not infer joining without a shared operator train number", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const terminating = departure("short", "D", shared);
  const continuing = departure("long", "E", [...shared, call("e", 40)]);

  assert.deepEqual(
    getJoinedTripPortionPairs([{ ...terminating, trainNumber: undefined }, continuing]),
    [],
  );
  assert.deepEqual(
    getJoinedTripPortionPairs([terminating, { ...continuing, trainNumber: "85654" }]),
    [],
  );
});

test("leaves an ambiguous group of three portions unchanged", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const departures = [
    departure("short", "D", shared),
    departure("middle", "E", [...shared, call("e", 40)]),
    departure("long", "F", [...shared, call("e", 40), call("f", 50)]),
  ];

  assert.deepEqual(getJoinedTripPortionPairs(departures), []);
});
