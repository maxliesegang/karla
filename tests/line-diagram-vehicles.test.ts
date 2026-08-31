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
  countLineDiagramVehicles,
  getLineDiagramCoordinateKey,
  getLineDiagramVehicleDepartures,
  getLineDiagramVehicles,
  getTripPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
  getVehicleRowCoordinate,
} from "../src/lib/line-diagram.ts";
import { getJoinedTripPortionPairs } from "../src/lib/joined-trip-portions.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import { createCall, run } from "./support/calls.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

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

  assert.ok(getVehicleRowCoordinate(vehicle) > 1.16 && getVehicleRowCoordinate(vehicle) < 1.17);
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

test("keeps the freshest board's reading of a vehicle, not the first board's", () => {
  // One vehicle, two boards: the observation posts along a line answer on cadences of minutes and
  // the line's own boards on tens of seconds, and the same trip is usually on both. A contest
  // between their copies is about age — the copy a mark is drawn from decides whether it runs with
  // the deviations the feed has since stated or with the ones it knew five minutes ago.
  const base: Departure = {
    id: "diagram-freshness",
    tripId: "diagram-freshness",
    tripInstanceId: "diagram-freshness@today",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("b", 2), call("c", 4)],
  };
  const stale = base;
  const fresh: Departure = {
    ...base,
    tripCalls: base.tripCalls?.map((tripCall, index) =>
      index === 0 ? tripCall : { ...tripCall, delayMinutes: 2 },
    ),
  };

  const selection = createLineSelection("2");
  const [winner] = getLineDiagramVehicleDepartures(selection, [stale, fresh], (departure) =>
    departure === fresh ? 2 : 1,
  );
  assert.equal(winner, fresh);

  // And where no reading is dated, the fuller sequence still wins, as before.
  const [fuller] = getLineDiagramVehicleDepartures(selection, [base, { ...fresh, tripCalls: [] }]);
  assert.equal(fuller, base);
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
  assert.ok(getVehicleRowCoordinate(vehicle) > 1 && getVehicleRowCoordinate(vehicle) < 2);
});

test("a chain names its own coordinates, and a row speaks for every mark behind it", () => {
  const diagramStops = buildLineDiagramStops(network, line, [call("a", 0), call("b", 1)], null);
  assert.equal(getLineDiagramCoordinateKey("2", diagramStops), "2:a>b");

  const departure: Departure = {
    id: "trip",
    tripId: "trip",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("b", 1)],
  };
  const joined: Departure = { ...departure, id: "portion", destination: "D" };
  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 30_000,
  );
  const both = { ...vehicle, joinedDepartures: [departure, joined] };

  assert.equal(
    getVehicleLabelsByRowIndex([both]).get(both.rowIndex),
    "geschätzte Position von 2 Richtung C und D",
  );
  assert.equal(
    getVehicleLabelsByRowIndex([vehicle, { ...vehicle, departure: joined }]).get(vehicle.rowIndex),
    "geschätzte Position von 2 Richtung C, geschätzte Position von 2 Richtung C",
  );
  // One count per line portion the mark stands for, matching the number shown on the mark itself.
  assert.equal(countLineDiagramVehicles([[both], [vehicle]]), 3);
});

test("carries every trip's own destination on its mark, joined portions included", () => {
  const diagramStops = buildLineDiagramStops(
    network,
    line,
    [call("a", 0), call("b", 1), call("c", 2), call("d", 3)],
    null,
  );
  // A working that turns back at C, on a diagram drawn all the way to D: the one case the diagram
  // itself cannot show, and the mark answers it when it is asked.
  const shortWorking: Departure = {
    id: "diagram-short-working",
    tripId: "diagram-short-working",
    lineId: "2",
    transportMode: "tram",
    destination: "Rüppurr Tulpenstraße",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("b", 1), call("c", 2)],
  };

  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [shortWorking],
    [],
    undefined,
    start + 70_000,
  );

  assert.equal(vehicle.destinationLabel, "Rüppurr Tulpenstraße");
});

test("speaks a mark standing at a terminus as the departure or the arrival it is", () => {
  const diagramStops = buildLineDiagramStops(network, line, [call("a", 0), call("b", 2)], null);
  const waiting: Departure = {
    id: "diagram-waiting",
    tripId: "diagram-waiting",
    lineId: "2",
    transportMode: "tram",
    destination: "B",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: run([call("a", 0), call("b", 2)]),
  };

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [waiting],
    [],
    undefined,
    start - 3 * 60_000,
  );

  assert.equal(vehicles[0].phase, "beforeStart");
  assert.equal(getVehicleLabelsByRowIndex(vehicles).get(0), "nächste Abfahrt von 2 Richtung B");

  const arrived = getLineDiagramVehicles(
    diagramStops,
    [waiting],
    [],
    undefined,
    start + 2.5 * 60_000,
  );

  assert.equal(arrived[0].phase, "afterEnd");
  assert.equal(
    getVehicleLabelsByRowIndex(arrived).get(1),
    "Fahrt von 2 Richtung B endet hier",
    "the final stop, rather than the preceding link, speaks for an arrived mark",
  );
});

test("places a mark on the nearer of two rows a chain names the same stop at", () => {
  // A working that runs through a loop passes one stop twice, so the chain names it twice and a
  // lookup of stop to row answers with whichever of them it kept. The link is the fact in hand and
  // both of its ends are resolved together, which puts the mark on the link the vehicle is on
  // rather than half a diagram away from it — and slid there from wherever it stood.
  const loopNetwork: TransitNetwork = {
    stops: ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const chain = [call("a", 0), call("b", 2), call("c", 4), call("b", 6), call("d", 8)];
  const diagramStops = buildLineDiagramStops(loopNetwork, line, chain, null);
  assert.deepEqual(
    diagramStops.map(({ stopId }) => stopId),
    ["a", "b", "c", "b", "d"],
  );

  const departure: Departure = {
    id: "diagram-loop",
    tripId: "diagram-loop",
    lineId: "2",
    transportMode: "tram",
    destination: "D",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: chain,
  };

  // A minute into the first link: between the first A and the *first* B, not the one after the loop.
  const [firstLeg] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 60_000,
  );
  assert.ok(getVehicleRowCoordinate(firstLeg) > 0 && getVehicleRowCoordinate(firstLeg) < 1);
  assert.equal(firstLeg.directionArrow, "↓");

  // And five minutes in, on the link out of C into a B: which of the two Bs the operator means is
  // not stated anywhere, but both of them adjoin C, so the mark is on one of the two links that
  // name the stops it is actually between — never a diagram away from either.
  const [returning] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 5 * 60_000,
  );
  assert.ok(Math.abs(getVehicleRowCoordinate(returning) - 2) < 1);
});
