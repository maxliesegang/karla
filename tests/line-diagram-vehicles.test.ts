import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TransitNetwork, TripCall } from "../src/data/transit-types.ts";
import {
  buildLineDiagramStops,
  countLineDiagramVehicles,
  getLineDiagramCoordinateKey,
  getLineDiagramRunDepartures,
  getLineDiagramVehicles,
  getShownLineDiagramVehicles,
  getRunPositionAnchorIndex,
  getVehicleLabelsByRowIndex,
  getVehicleRowCoordinate,
} from "../src/lib/line-diagram.ts";
import { getJoinedRunPortionPairs } from "../src/lib/joined-run-portions.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import { createCall, run } from "./support/calls.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import { createDeparture as createFixture } from "./support/fixtures.ts";

/** One drawing's motion record, shared across this file as the module global used to be. */
const motions = createRunMotions();

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

const network: TransitNetwork = {
  stops: ["a", "b", "c", "d", "e"].map((id) => ({
    id,
    name: id.toUpperCase(),
  })),
  lines: [],
};

test("moves continuously across every visible row when an observed trip skips a call", () => {
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 1), call("c", 2)]);
  const departure: Departure = createFixture({
    id: "diagram-skipped-call",
    tripId: "diagram-skipped-call",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("c", 2)],
  });

  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 70_000,
    { motions },
  );

  assert.ok(getVehicleRowCoordinate(vehicle) > 1.1 && getVehicleRowCoordinate(vehicle) < 1.4);
  assert.equal(getRunPositionAnchorIndex(diagramStops, [vehicle], call("c", 2)), 1);
});

test("uses the next call as the position anchor before a selected vehicle can be placed", () => {
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 1), call("c", 2)]);

  assert.equal(getRunPositionAnchorIndex(diagramStops, [], call("b", 1)), 1);
  assert.equal(getRunPositionAnchorIndex(diagramStops, [], undefined), -1);
});

test("keeps the freshest board's reading of a vehicle, not the first board's", () => {
  // One vehicle, two boards: the observation posts along a line answer on cadences of minutes and
  // the line's own boards on tens of seconds, and the same trip is usually on both. A contest
  // between their copies is about age — the copy a mark is drawn from decides whether it runs with
  // the deviations the feed has since stated or with the ones it knew five minutes ago.
  const base: Departure = createFixture({
    id: "diagram-freshness",
    tripId: "diagram-freshness",
    tripInstanceId: "diagram-freshness@today",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("b", 2), call("c", 4)],
  });
  const stale: Departure = { ...base, readAt: { rowReadAt: 1, sequenceReadAt: 1 } };
  const fresh: Departure = createFixture({
    ...base,
    readAt: { rowReadAt: 2, sequenceReadAt: 2 },
    tripCalls: base.tripCalls?.map((tripCall, index) =>
      index === 0 ? tripCall : { ...tripCall, delayMinutes: 2 },
    ),
  });

  const selection = createLineSelection("2");
  const [winner] = getLineDiagramRunDepartures(selection, [stale, fresh]);
  assert.equal(winner, fresh);

  // And where no reading is dated, the fuller sequence still wins, as before.
  const [fuller] = getLineDiagramRunDepartures(selection, [base, { ...fresh, tripCalls: [] }]);
  assert.equal(fuller, base);
});

test("draws joined portions as one counted mark until the terminating portion ends", () => {
  const sharedCalls = [call("a", 0), call("b", 2), call("c", 4), call("d", 6)];
  const createDeparture = (
    id: string,
    destination: string,
    tripCalls: readonly TripCall[],
  ): Departure =>
    createFixture({
      id,
      tripId: id,
      tripInstanceId: `${id}@today`,
      trainNumber: "85653",
      lineId: "2",
      transportMode: "tram",
      destination,
      minutesUntilDeparture: 0,
      platformCode: "1",
      boardingLocalStopId: "a",
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
  const diagramStops = buildLineDiagramStops(network, continuing.tripCalls ?? []);

  const together = getLineDiagramVehicles(
    diagramStops,
    [terminating, continuing],
    getJoinedRunPortionPairs([terminating, continuing]),
    terminating,
    start + 60_000,
    { motions },
  );
  assert.equal(together.length, 1);
  assert.deepEqual(together[0]?.joinedDepartures.map(({ id }) => id).sort(), ["long", "short"]);
  assert.equal(together[0]?.isSelected, true);
  assert.equal(together[0]?.departure.id, "long");
  assert.equal(
    together[0]?.markerKey,
    "long@today",
    "the composite keeps the identity of the portion that continues",
  );

  const afterTerminus = getLineDiagramVehicles(
    diagramStops,
    [terminating, continuing],
    getJoinedRunPortionPairs([terminating, continuing]),
    undefined,
    start + 7 * 60_000,
    { motions },
  );
  assert.equal(afterTerminus.length, 1);
  assert.deepEqual(
    afterTerminus[0]?.joinedDepartures.map(({ id }) => id),
    ["long"],
  );
  assert.equal(
    afterTerminus[0]?.markerKey,
    together[0]?.markerKey,
    "splitting the published portions does not remount the continuing vehicle",
  );
});

test("keeps inconsistent joined-portion positions separate", () => {
  const sharedCalls = [call("a", 0), call("b", 2), call("c", 4), call("d", 6)];
  const createDeparture = (id: string, destination: string, tripCalls: readonly TripCall[]) =>
    createFixture({
      id,
      tripId: id,
      tripInstanceId: `${id}@today`,
      trainNumber: "85653",
      lineId: "2",
      destination,
      boardingLocalStopId: "a",
      scheduledDepartureTime: new Date(start).toISOString(),
      tripCalls,
    });
  const terminating = createDeparture("delayed-short", "D", [
    ...sharedCalls.map((tripCall) => ({ ...tripCall, delayMinutes: 2 })),
  ]);
  const continuing = createDeparture("punctual-long", "E", [...sharedCalls, call("e", 8)]);
  const departures = [terminating, continuing];
  const diagramStops = buildLineDiagramStops(network, continuing.tripCalls ?? []);

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    departures,
    getJoinedRunPortionPairs(departures),
    undefined,
    start + 3 * 60_000,
    { motions },
  );

  assert.equal(vehicles.length, 2);
  assert.ok(vehicles.every(({ joinedDepartures }) => joinedDepartures.length === 1));
});

test("draws both published platform calls at the same stop", () => {
  // What a turning trip publishes at its last stop: timed into the platform it arrives on, and
  // again out of the one it leaves from, both resolving to the same stop.
  const tripCalls = [call("a", 0), call("b", 2), call("c", 4), call("c", 6)];
  const diagramStops = buildLineDiagramStops(network, tripCalls);
  assert.deepEqual(
    diagramStops.map(({ stopId }) => stopId),
    ["a", "b", "c", "c"],
  );

  const departure: Departure = createFixture({
    id: "turning-terminus",
    tripId: "turning-terminus",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls,
  });

  // The carried link still ends at the first C call; the second is the separately published stand.
  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 3 * 60_000,
    { motions },
  );
  assert.ok(getVehicleRowCoordinate(vehicle) > 1 && getVehicleRowCoordinate(vehicle) < 2);

  const [betweenPlatforms] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 5 * 60_000,
    { motions },
  );
  assert.ok(
    getVehicleRowCoordinate(betweenPlatforms) > 2 && getVehicleRowCoordinate(betweenPlatforms) < 3,
  );
});

test("reads a three-call terminus as the two calls the route keeps", () => {
  // Waidweg, as line 3 reports a terminating run: the loop's entry point, the public platform the
  // row departs from, and the track the run ends on — three calls, one stop. The pair the feed
  // itself marks folds to one call, and what remains are the two calls a rider reads, each saying
  // which platform it is. The entry point stays beside the folded call, exactly as Europaplatz's
  // two street platforms do.
  const tripCalls = [
    call("hammweg", 0),
    { ...call("waidweg", 1), platformLabel: "Gleis 1" },
    { ...call("waidweg", 2), platformLabel: "3", isCurrentStop: true },
    { ...call("waidweg", 3), platformLabel: "Gleis 2", scheduledDepartureTime: undefined },
  ];
  const diagramStops = buildLineDiagramStops(network, tripCalls);

  assert.deepEqual(
    diagramStops.map(({ stopName, stopId, platformLabel }) => ({
      stopName,
      stopId,
      platformLabel,
    })),
    [
      { stopName: "HAMMWEG", stopId: "hammweg", platformLabel: undefined },
      { stopName: "WAIDWEG", stopId: "waidweg", platformLabel: "Gleis 1" },
      { stopName: "WAIDWEG", stopId: "waidweg", platformLabel: "3" },
    ],
  );
});

test("a chain names its own coordinates, and a row speaks for every mark behind it", () => {
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 1)]);
  assert.equal(getLineDiagramCoordinateKey("2", diagramStops), "2:a>b");

  const departure: Departure = createFixture({
    id: "trip",
    tripId: "trip",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("b", 1)],
  });
  const joined: Departure = { ...departure, id: "portion", destination: "D" };
  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 30_000,
    { motions },
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
  const diagramStops = buildLineDiagramStops(network, [
    call("a", 0),
    call("b", 1),
    call("c", 2),
    call("d", 3),
  ]);
  // A working that turns back at C, on a diagram drawn all the way to D: the one case the diagram
  // itself cannot show, and the mark answers it when it is asked.
  const shortWorking: Departure = createFixture({
    id: "diagram-short-working",
    tripId: "diagram-short-working",
    lineId: "2",
    transportMode: "tram",
    destination: "Rüppurr Tulpenstraße",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: [call("a", 0), call("b", 1), call("c", 2)],
  });

  const [vehicle] = getLineDiagramVehicles(
    diagramStops,
    [shortWorking],
    [],
    undefined,
    start + 70_000,
    { motions },
  );

  assert.equal(vehicle.destinationLabel, "Rüppurr Tulpenstraße");
});

test("speaks a mark standing at a terminus as the departure or the arrival it is", () => {
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 2)]);
  const waiting: Departure = createFixture({
    id: "diagram-waiting",
    tripId: "diagram-waiting",
    lineId: "2",
    transportMode: "tram",
    destination: "B",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: run([call("a", 0), call("b", 2)]),
  });

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [waiting],
    [],
    undefined,
    start - 3 * 60_000,
    { motions },
  );

  assert.equal(vehicles[0].phase, "beforeStart");
  assert.equal(getVehicleLabelsByRowIndex(vehicles).get(0), "nächste Abfahrt von 2 Richtung B");

  const arrived = getLineDiagramVehicles(
    diagramStops,
    [waiting],
    [],
    undefined,
    start + 2.5 * 60_000,
    { motions },
  );

  assert.equal(arrived[0].phase, "afterEnd");
  assert.equal(
    getVehicleLabelsByRowIndex(arrived).get(1),
    "Fahrt von 2 Richtung B endet hier",
    "the final stop, rather than the preceding link, speaks for an arrived mark",
  );
});

test("hides the turnaround stands with the line's other vehicles, but never the rider's own", () => {
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 2), call("c", 4)]);
  const mine: Departure = createFixture({
    id: "shown-mine",
    tripId: "shown-mine",
    lineId: "2",
    transportMode: "tram",
    destination: "C",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start + 2 * 60_000).toISOString(),
    tripCalls: run([call("a", 2), call("b", 4), call("c", 6)]),
  });
  // The next run out of the same terminus, standing there for its own turn.
  const turning: Departure = createFixture({
    ...mine,
    id: "shown-turning",
    tripId: "shown-turning",
    scheduledDepartureTime: new Date(start + 5 * 60_000).toISOString(),
    tripCalls: run([call("a", 5), call("b", 7), call("c", 9)]),
  });

  // Both runs stand at their first stop before either has begun.
  const placements = getLineDiagramVehicles(diagramStops, [mine, turning], [], mine, start, {
    motions,
  });
  assert.deepEqual(
    placements.map(({ departure, phase }) => [departure.tripId, phase]),
    [
      ["shown-mine", "beforeStart"],
      ["shown-turning", "beforeStart"],
    ],
  );

  // With the line's other vehicles hidden the turnaround stand goes with them; the stand the
  // rider's own run begins from stays, being theirs.
  assert.deepEqual(
    getShownLineDiagramVehicles(placements, false).map(({ departure }) => departure.tripId),
    ["shown-mine"],
  );
  assert.deepEqual(
    getShownLineDiagramVehicles(placements, true).map(({ departure }) => departure.tripId),
    ["shown-mine", "shown-turning"],
  );

  // Without a followed trip every stand is another run's beginning, so hiding the others clears
  // the diagram of them all.
  const unaccompanied = getLineDiagramVehicles(
    diagramStops,
    [mine, turning],
    [],
    undefined,
    start,
    { motions },
  );
  assert.deepEqual(
    getShownLineDiagramVehicles(unaccompanied, false).map(({ departure }) => departure.tripId),
    [],
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
  const diagramStops = buildLineDiagramStops(loopNetwork, chain);
  assert.deepEqual(
    diagramStops.map(({ stopId }) => stopId),
    ["a", "b", "c", "b", "d"],
  );

  const departure: Departure = createFixture({
    id: "diagram-loop",
    tripId: "diagram-loop",
    lineId: "2",
    transportMode: "tram",
    destination: "D",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: chain,
  });

  // A minute into the first link: between the first A and the *first* B, not the one after the loop.
  const [firstLeg] = getLineDiagramVehicles(
    diagramStops,
    [departure],
    [],
    departure,
    start + 60_000,
    { motions },
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
    { motions },
  );
  assert.ok(Math.abs(getVehicleRowCoordinate(returning) - 2) < 1);
});
