import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import {
  buildZentrumSchematicReading,
  getZentrumSchematicVehicles,
} from "../src/lib/zentrum-schematic.ts";
import {
  getMinutesUntilArrival,
  getRideMinutes,
  getZentrumVehiclePathsOverlay,
  getZentrumStopBoard,
  getZentrumStopDepartures,
  getZentrumTravelTimes,
} from "../src/lib/zentrum-schematic-overlays.ts";
import { createDeparture } from "./support/fixtures.ts";

const EUROPAPLATZ_MARKTPLATZ = "europaplatz\u0000marktplatz";
const MARKTPLATZ_KRONENPLATZ = "kronenplatz\u0000marktplatz";

const at = (minute: number) => `2026-09-04T12:${String(minute).padStart(2, "0")}:00+02:00`;
const instant = (minute: number) => Date.parse(at(minute));

const stopPointIds: Record<string, string> = {
  europaplatz: "7001004",
  marktplatz: "7001003",
  kronenplatz: "7001002",
};

const timedCall = (localStopId: string, minute: number): TripCall => ({
  stopName: localStopId,
  localStopId,
  providerStopPointId: stopPointIds[localStopId],
  platformCode: "1",
  scheduledArrivalTime: at(minute),
  scheduledDepartureTime: at(minute),
  delayMinutes: 0,
});

/** One run along the Kaiserstraße, calling at each stop at the minute given beside it. */
const run = (
  id: string,
  lineId: string,
  stops: readonly (readonly [string, number])[],
  destination = "Durlach",
): Departure =>
  createDeparture({
    id,
    tripInstanceId: id,
    lineId,
    transportMode: "tram",
    destination,
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: stops[0][0],
    boardingProviderStopPointId: stopPointIds[stops[0][0]],
    boardingProviderStopPointName: stops[0][0],
    status: "realtime",
    delayMinutes: 0,
    scheduledDepartureTime: at(stops[0][1]),
    tripCalls: stops.map(([stopId, minute]) => timedCall(stopId, minute)),
  });

const eastbound = (id: string, startMinute: number) =>
  run(id, "S1", [
    ["europaplatz", startMinute],
    ["marktplatz", startMinute + 2],
    ["kronenplatz", startMinute + 4],
  ]);

const placeVehicles = (runs: readonly Departure[], minute: number) =>
  getZentrumSchematicVehicles(
    buildZentrumSchematicReading(runs),
    runs,
    instant(minute),
    createRunMotions(),
  );

test("lights a tram's corridor from the tram onwards, and nothing behind it", () => {
  const [vehicle] = placeVehicles([eastbound("lead", 0)], 1);
  assert.ok(vehicle);

  const overlay = getZentrumVehiclePathsOverlay([vehicle]);

  // The corridor it is on goes out behind it, so it is a stretch from the mark, not lit whole.
  assert.deepEqual([...(overlay.corridorIdsByLineId.get("S1") ?? [])], [MARKTPLATZ_KRONENPLATZ]);
  assert.deepEqual(
    overlay.stretches.map(({ vehicle: { id }, end }) => [id, end]),
    [[vehicle.id, 1]],
  );
});

test("keeps a corridor lit whole while a tram behind will still run it", () => {
  const vehicles = placeVehicles([eastbound("lead", 0), eastbound("follower", 2)], 3);
  assert.equal(vehicles.length, 2);
  const lead = vehicles.find(({ id }) => id.includes("lead"));
  assert.equal(lead?.from.id, "marktplatz");

  const overlay = getZentrumVehiclePathsOverlay(vehicles);

  // The lead is on the Marktplatz–Kronenplatz corridor; the follower still has all of it ahead.
  assert.ok(overlay.corridorIdsByLineId.get("S1")?.has(MARKTPLATZ_KRONENPLATZ));
  assert.equal(overlay.stretches.length, 2);
});

test("lights the way a tram still has to come to a stop, and says when it leaves there", () => {
  const [vehicle] = placeVehicles([eastbound("lead", 0)], 1);
  assert.ok(vehicle);

  const toKronenplatz = getZentrumStopDepartures([vehicle], "kronenplatz");
  assert.deepEqual(
    toKronenplatz.departures.map(({ departsAt, isAtStop }) => [departsAt, isAtStop]),
    [[instant(4), false]],
  );
  // The rest of its own corridor, then the corridor on to the stop.
  assert.deepEqual(
    [...(toKronenplatz.overlay.corridorIdsByLineId.get("S1") ?? [])],
    [MARKTPLATZ_KRONENPLATZ],
  );
  assert.deepEqual(
    toKronenplatz.overlay.stretches.map(({ end }) => end),
    [1],
  );

  // A stop the tram has already left is behind it, and is nothing it can be taken from.
  assert.deepEqual(getZentrumStopDepartures([vehicle], "europaplatz").departures, []);
});

test("offers only the next tram of a line toward one destination", () => {
  const vehicles = placeVehicles([eastbound("lead", 0), eastbound("follower", 2)], 3);

  const { departures } = getZentrumStopDepartures(vehicles, "kronenplatz");

  assert.equal(departures.length, 1);
  assert.equal(departures[0]?.departsAt, instant(4));
});

/** The row a stop's own board states for a run, as the board at that stop publishes it. */
const boardRow = (departure: Departure, localStopId: string, minute: number): Departure => ({
  ...departure,
  boardingLocalStopId: localStopId,
  scheduledDepartureTime: at(minute),
});

test("reads a stop's whole board, and marks the trams of it already on the plan", () => {
  const lead = eastbound("lead", 0);
  const later = eastbound("later", 10);
  const unrouted = createDeparture({ id: "bus", lineId: "S5", destination: "Rheinhafen" });
  const [vehicle] = placeVehicles([lead], 1);
  assert.ok(vehicle);

  const { rows, vehicleMinutesById } = getZentrumStopBoard(
    [boardRow(lead, "kronenplatz", 4), boardRow(later, "kronenplatz", 14), unrouted],
    [vehicle],
    "kronenplatz",
    instant(1),
  );

  assert.deepEqual(
    rows.map(({ departure, vehicleId }) => [departure.id, vehicleId]),
    [
      ["lead", vehicle.id],
      ["later", undefined],
      ["bus", undefined],
    ],
  );
  // The wait the mark carries is the one its board row counts.
  assert.deepEqual([...vehicleMinutesById], [[vehicle.id, 3]]);
});

test("signs every drawn tram of the board with the wait its row counts", () => {
  const vehicles = placeVehicles([eastbound("lead", 0), eastbound("follower", 2)], 3);

  const { vehicleMinutesById } = getZentrumStopBoard(
    [
      boardRow(eastbound("lead", 0), "kronenplatz", 4),
      boardRow(eastbound("follower", 2), "kronenplatz", 6),
    ],
    vehicles,
    "kronenplatz",
    instant(3),
  );

  assert.deepEqual([...vehicleMinutesById.values()], [1, 3]);
});

test("signs a tram published at two places of a stop with the wait at the first", () => {
  const lead = eastbound("lead", 0);
  const [vehicle] = placeVehicles([lead], 1);
  assert.ok(vehicle);

  const { rows, vehicleMinutesById } = getZentrumStopBoard(
    [boardRow(lead, "kronenplatz", 4), boardRow(lead, "kronenplatz", 5)],
    [vehicle],
    "kronenplatz",
    instant(1),
  );

  assert.equal(rows.length, 2);
  assert.deepEqual([...vehicleMinutesById.values()], [3]);
});

test("reads how soon every stop is reached directly, by the tram that gets there first", () => {
  const runs = [
    // Gone already: it left the Europaplatz before the rider got there.
    eastbound("gone", 0),
    eastbound("next", 2),
    // Leaves sooner and stops short, so it wins the Marktplatz and nothing beyond it.
    run(
      "short",
      "S5",
      [
        ["europaplatz", 1],
        ["marktplatz", 3],
      ],
      "Marktplatz",
    ),
  ];

  const { travelTimesByNodeId, overlay } = getZentrumTravelTimes(runs, "europaplatz", instant(1));

  assert.deepEqual(Object.fromEntries(travelTimesByNodeId), {
    marktplatz: {
      arrivesAt: instant(3),
      lineId: "S5",
      departsAt: instant(1),
      departure: runs[2],
      boardingCall: runs[2].tripCalls![0],
      arrivalCall: runs[2].tripCalls![1],
    },
    kronenplatz: {
      arrivesAt: instant(6),
      lineId: "S1",
      departsAt: instant(2),
      departure: runs[1],
      boardingCall: runs[1].tripCalls![0],
      arrivalCall: runs[1].tripCalls![2],
    },
  });
  assert.deepEqual([...(overlay.corridorIdsByLineId.get("S5") ?? [])], [EUROPAPLATZ_MARKTPLATZ]);
  assert.deepEqual([...(overlay.corridorIdsByLineId.get("S1") ?? [])].sort(), [
    EUROPAPLATZ_MARKTPLATZ,
    MARKTPLATZ_KRONENPLATZ,
  ]);
});

test("reads the shortest ride to each stop when riding time is the measure", () => {
  const runs = [
    run(
      "slow",
      "2",
      [
        ["europaplatz", 1],
        ["marktplatz", 4],
        ["kronenplatz", 7],
      ],
      "Wolfartsweier",
    ),
    eastbound("fast", 5),
  ];

  const byArrival = getZentrumTravelTimes(runs, "europaplatz", instant(1));
  const byRide = getZentrumTravelTimes(runs, "europaplatz", instant(1), "ride");

  assert.equal(byArrival.travelTimesByNodeId.get("kronenplatz")?.lineId, "2");
  assert.deepEqual(byRide.travelTimesByNodeId.get("kronenplatz"), {
    arrivesAt: instant(9),
    lineId: "S1",
    departsAt: instant(5),
    departure: runs[1],
    boardingCall: runs[1].tripCalls![0],
    arrivalCall: runs[1].tripCalls![2],
  });
  assert.equal(getRideMinutes(byRide.travelTimesByNodeId.get("kronenplatz")!), 4);
});

test("counts minutes to an arrival up, never promising one early", () => {
  assert.equal(getMinutesUntilArrival(instant(5), instant(3)), 2);
  assert.equal(getMinutesUntilArrival(instant(5) + 1_000, instant(3)), 3);
  assert.equal(getMinutesUntilArrival(instant(3), instant(5)), 0);
});
