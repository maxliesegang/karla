import assert from "node:assert/strict";
import test from "node:test";
import type {
  Departure,
  TransitLine,
  TransitNetwork,
  TripCall,
} from "../src/data/transit-types.ts";
import {
  buildLineDiagramStops,
  getLineDiagramVehicles,
  getTripPositionAnchorIndex,
} from "../src/lib/line-diagram.ts";
import { getJoinedTripPortionPairs } from "../src/lib/joined-trip-portions.ts";

const start = Date.parse("2026-08-23T12:00:00Z");

function call(stopId: string, minute: number): TripCall {
  const time = new Date(start + minute * 60_000).toISOString();
  return {
    stopName: stopId.toUpperCase(),
    localStopId: stopId,
    scheduledArrivalTime: time,
    scheduledDepartureTime: time,
    delayMinutes: 0,
  };
}

const network: TransitNetwork = {
  stops: ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    name: id.toUpperCase(),
  })),
  lines: [],
};
const line: TransitLine = {
  id: "2",
  name: "2",
  color: "#f00",
  textColor: "#fff",
  destinations: ["C"],
  zentrumStopIds: ["a", "b", "c"],
};

test("moves continuously across every visible row when an observed trip skips a call", () => {
  const diagramStops = buildLineDiagramStops(
    network,
    line,
    [call("a", 0), call("b", 1), call("c", 2)],
    null,
  );
  const departure: Departure = {
    id: "diagram-skipped-call",
    tripId: "diagram-skipped-call",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("c", 2)],
  };

  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 70_000,
  );

  assert.ok(vehicle.diagramPosition > 0.99 && vehicle.diagramPosition < 1.01);
  assert.equal(getTripPositionAnchorIndex(diagramStops, [vehicle], call("c", 2)), 1);
});

test("uses the next call as the position anchor before a selected vehicle can be placed", () => {
  const diagramStops = buildLineDiagramStops(
    network,
    line,
    [call("a", 0), call("b", 1), call("c", 2)],
    null,
  );

  assert.equal(getTripPositionAnchorIndex(diagramStops, [], call("b", 1)), 1);
  assert.equal(getTripPositionAnchorIndex(diagramStops, [], undefined), -1);
});

test("draws joined portions as one counted mark until the terminating portion ends", () => {
  const sharedCalls = [call("a", 0), call("b", 2), call("c", 4), call("d", 6)];
  const createDeparture = (
    id: string,
    destination: string,
    tripCalls: readonly TripCall[],
  ): Departure => ({
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    trainNumber: "85653",
    lineId: "2",
    transportMode: "tram",
    destination,
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls,
  });
  const terminating = createDeparture(
    "short",
    "D",
    sharedCalls.map((tripCall) => ({
      ...tripCall,
      scheduledArrivalTime: undefined,
      scheduledDepartureTime: undefined,
    })),
  );
  const continuing = {
    ...createDeparture("long", "E", [...sharedCalls, call("e", 8)]),
    predictedDepartureTime: new Date(start + 60_000).toISOString(),
    tripCalls: [...sharedCalls, call("e", 8)].map((tripCall) => ({
      ...tripCall,
      delayMinutes: 1,
    })),
  };
  const diagramStops = buildLineDiagramStops(network, line, continuing.tripCalls ?? [], null);

  const together = getLineDiagramVehicles(
    diagramStops,
    [terminating, continuing],
    getJoinedTripPortionPairs([terminating, continuing]),
    terminating,
    start + 60_000,
  );
  assert.equal(together.length, 1);
  assert.deepEqual(together[0]?.joinedDepartures.map(({ id }) => id).sort(), ["long", "short"]);
  assert.equal(together[0]?.isSelected, true);
  assert.equal(together[0]?.departure.id, "long");

  const afterTerminus = getLineDiagramVehicles(
    diagramStops,
    [terminating, continuing],
    getJoinedTripPortionPairs([terminating, continuing]),
    undefined,
    start + 7 * 60_000,
  );
  assert.equal(afterTerminus.length, 1);
  assert.deepEqual(
    afterTerminus[0]?.joinedDepartures.map(({ id }) => id),
    ["long"],
  );
});

test("keeps inconsistent joined-portion positions separate", () => {
  const sharedCalls = [call("a", 0), call("b", 2), call("c", 4), call("d", 6)];
  const createDeparture = (id: string, destination: string, tripCalls: readonly TripCall[]) => ({
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    trainNumber: "85653",
    lineId: "2",
    transportMode: "tram" as const,
    destination,
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime" as const,
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls,
  });
  const terminating = createDeparture("delayed-short", "D", [
    ...sharedCalls.map((tripCall) => ({ ...tripCall, delayMinutes: 2 })),
  ]);
  const continuing = createDeparture("punctual-long", "E", [...sharedCalls, call("e", 8)]);
  const departures = [terminating, continuing];
  const diagramStops = buildLineDiagramStops(network, line, continuing.tripCalls, null);

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    departures,
    getJoinedTripPortionPairs(departures),
    undefined,
    start + 3 * 60_000,
  );

  assert.equal(vehicles.length, 2);
  assert.ok(vehicles.every(({ joinedDepartures }) => joinedDepartures.length === 1));
});

test("draws a terminus stated on both of its platforms as one row", () => {
  // What a turning trip publishes at its last stop: timed into the platform it arrives on, and
  // again out of the one it leaves from, both resolving to the same stop.
  const tripCalls = [call("a", 0), call("b", 2), call("c", 4), call("c", 6)];
  const diagramStops = buildLineDiagramStops(network, line, tripCalls, null);
  assert.deepEqual(
    diagramStops.map(({ stopId }) => stopId),
    ["a", "b", "c"],
  );

  const departure: Departure = {
    id: "turning-terminus",
    tripId: "turning-terminus",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls,
  };

  // The last link a rider can be carried along is B–C, and it is the diagram's last row pair.
  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 3 * 60_000,
  );
  assert.ok(vehicle.diagramPosition > 1 && vehicle.diagramPosition < 2);
});
