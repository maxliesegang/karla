import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TransitNetwork, TripCall } from "../src/data/transit-types.ts";
import {
  buildLineDiagramStops,
  countLineDiagramVehicles,
  formatPlatformLabels,
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

/** One drawing's motion record, shared across this file. */
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
  // One vehicle on a slow post's board and a fast line board: the fresher copy draws the mark.
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

  // Undated readings fall back to the fuller sequence.
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
  // A turning trip at its last stop: into the arrival platform, out of the departure one, same
  // stop.
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

  // The carried link ends at the first C call; the second is the published stand.
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
  // Waidweg as line 3 reports a terminating run: loop entry, public platform, end track, all one
  // stop. The feed's turnaround pair folds; the two calls a rider reads remain, each naming its
  // platform.
  const tripCalls = [
    call("hammweg", 0),
    { ...call("waidweg", 1), platformLabel: "Gleis 1" },
    { ...call("waidweg", 2), platformLabel: "3", isCurrentStop: true },
    { ...call("waidweg", 3), platformLabel: "Gleis 2", scheduledDepartureTime: undefined },
  ];
  const diagramStops = buildLineDiagramStops(network, tripCalls);

  assert.deepEqual(
    diagramStops.map(({ stopName, stopId, platformLabels }) => ({
      stopName,
      stopId,
      platformLabels,
    })),
    [
      { stopName: "HAMMWEG", stopId: "hammweg", platformLabels: undefined },
      { stopName: "WAIDWEG", stopId: "waidweg", platformLabels: ["Gleis 1"] },
      { stopName: "WAIDWEG", stopId: "waidweg", platformLabels: ["3"] },
    ],
  );
});

test("a stop the route reaches twice names the platforms both directions use there", () => {
  // Line 4 at Europaplatz: `Gleis 3` then `5` towards Oberreut, `6` then `4` towards Waldstadt.
  const europaplatz = (platformCode: string): TripCall => ({
    stopName: "Europaplatz",
    localStopId: "europaplatz",
    platformCode,
    platformLabel: `Gleis ${platformCode}`,
  });
  const drawn = [call("a", 0), europaplatz("5"), europaplatz("3"), call("b", 3)];
  const opposite = [call("a", 0), europaplatz("6"), europaplatz("4"), call("b", 3)];
  const shortSameWay = [call("b", 0), europaplatz("3"), europaplatz("5")];
  const platformsOf = (observedRunCalls: readonly (readonly TripCall[])[]) =>
    buildLineDiagramStops(network, drawn, undefined, observedRunCalls).map(
      ({ platformLabels }) => platformLabels,
    );

  const expected = [undefined, ["Gleis 5", "Gleis 6"], ["Gleis 3", "Gleis 4"], undefined];
  assert.deepEqual(platformsOf([opposite, shortSameWay]), expected);
  // Either way round, a run is read the diagram's way up.
  assert.deepEqual(platformsOf([[...opposite].reverse()]), expected);
  // Without other runs, the drawn trip's own platform.
  assert.deepEqual(platformsOf([]), [undefined, ["Gleis 5"], ["Gleis 3"], undefined]);
});

test("a row's platforms share their word once", () => {
  assert.equal(formatPlatformLabels(["Gleis 3", "Gleis 4"]), "Gleis 3/4");
  assert.equal(formatPlatformLabels(["Gleis 5"]), "Gleis 5");
  assert.equal(formatPlatformLabels(["Gleis 1", "3"]), "Gleis 1 / 3");
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
  // One count per line portion, as the mark shows.
  assert.equal(countLineDiagramVehicles([[both], [vehicle]]), 3);
});

test("carries every trip's own destination on its mark, joined portions included", () => {
  const diagramStops = buildLineDiagramStops(network, [
    call("a", 0),
    call("b", 1),
    call("c", 2),
    call("d", 3),
  ]);
  // A working turning back at C on a diagram drawn to D: the mark says so when asked.
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
  // The next run out of the terminus, standing for its turn.
  const turning: Departure = createFixture({
    ...mine,
    id: "shown-turning",
    tripId: "shown-turning",
    scheduledDepartureTime: new Date(start + 5 * 60_000).toISOString(),
    tripCalls: run([call("a", 5), call("b", 7), call("c", 9)]),
  });

  // Both stand at their first stop before beginning.
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

  // Hiding other runs hides the turnaround stand, but not the rider's own run's stand.
  assert.deepEqual(
    getShownLineDiagramVehicles(placements, false).map(({ departure }) => departure.tripId),
    ["shown-mine"],
  );
  assert.deepEqual(
    getShownLineDiagramVehicles(placements, true).map(({ departure }) => departure.tripId),
    ["shown-mine", "shown-turning"],
  );

  // Without a followed trip, hiding others clears every stand.
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
  // A loop names a stop twice; both link ends resolve together, so the mark is on its real link.
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

  // A minute in: between the first A and the first B.
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

  // Five minutes in, out of C into a B: either B adjoins C, so the mark is on a link naming the
  // stops it is really between.
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
