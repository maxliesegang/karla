import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import { createDatedJourneyMotions } from "../src/lib/vehicle-positioning.ts";
import {
  buildZentrumSchematicReading,
  getZentrumSchematicVehicles,
} from "../src/lib/zentrum-schematic.ts";
import {
  getMinutesUntilArrival,
  getRideMinutes,
  getZentrumVehiclePathsOverlay,
  getZentrumStopBoard,
  getZentrumStopEvents,
  getZentrumTravelTimes,
} from "../src/lib/zentrum-schematic-overlays.ts";
import { createStopEvent } from "./support/fixtures.ts";

const EUROPAPLATZ_MARKTPLATZ = "europaplatz\u0000marktplatz";
const MARKTPLATZ_KRONENPLATZ = "kronenplatz\u0000marktplatz";

const at = (minute: number) => `2026-09-04T12:${String(minute).padStart(2, "0")}:00+02:00`;
const instant = (minute: number) => Date.parse(at(minute));

const stopPointIds: Record<string, string> = {
  europaplatz: "de:08212:1004",
  marktplatz: "de:08212:1003",
  kronenplatz: "de:08212:1002",
};

const timedCall = (stopPlaceId: string, minute: number): Call => ({
  stopName: stopPlaceId,
  stopPlaceId,
  stopPointId: stopPointIds[stopPlaceId],
  bay: "1",
  timetabledArrivalTime: at(minute),
  timetabledDepartureTime: at(minute),
  delayMinutes: 0,
});

/** One journey along the Kaiserstraße, calling at each stop at the minute given beside it. */
const datedJourney = (
  id: string,
  lineId: string,
  stops: readonly (readonly [string, number])[],
  destination = "Durlach",
): StopEvent =>
  createStopEvent({
    id,
    datedJourneyId: id,
    lineId,
    ptMode: "tram",
    destinationText: destination,
    minutesUntilDeparture: 0,
    bay: "1",
    boardingStopPlaceId: stops[0][0],
    boardingStopPointId: stopPointIds[stops[0][0]],
    boardingStopPointName: stops[0][0],
    status: "realtime",
    delayMinutes: 0,
    timetabledDepartureTime: at(stops[0][1]),
    calls: stops.map(([stopId, minute]) => timedCall(stopId, minute)),
  });

const eastbound = (id: string, startMinute: number) =>
  datedJourney(id, "S1", [
    ["europaplatz", startMinute],
    ["marktplatz", startMinute + 2],
    ["kronenplatz", startMinute + 4],
  ]);

const placeVehicles = (datedJourneys: readonly StopEvent[], minute: number) =>
  getZentrumSchematicVehicles(
    buildZentrumSchematicReading(datedJourneys),
    datedJourneys,
    instant(minute),
    createDatedJourneyMotions(),
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

  const toKronenplatz = getZentrumStopEvents([vehicle], "kronenplatz");
  assert.deepEqual(
    toKronenplatz.stopEvents.map(({ departsAt, isAtStop }) => [departsAt, isAtStop]),
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
  assert.deepEqual(getZentrumStopEvents([vehicle], "europaplatz").stopEvents, []);
});

test("offers only the next tram of a line toward one destination", () => {
  const vehicles = placeVehicles([eastbound("lead", 0), eastbound("follower", 2)], 3);

  const { stopEvents } = getZentrumStopEvents(vehicles, "kronenplatz");

  assert.equal(stopEvents.length, 1);
  assert.equal(stopEvents[0]?.departsAt, instant(4));
});

/** The row a stop's own board states for a journey, as the board at that stop publishes it. */
const boardRow = (stopEvent: StopEvent, stopPlaceId: string, minute: number): StopEvent => ({
  ...stopEvent,
  boardingStopPlaceId: stopPlaceId,
  timetabledDepartureTime: at(minute),
});

test("reads a stop's whole board, and marks the trams of it already on the plan", () => {
  const lead = eastbound("lead", 0);
  const later = eastbound("later", 10);
  const unrouted = createStopEvent({ id: "bus", lineId: "S5", destinationText: "Rheinhafen" });
  const [vehicle] = placeVehicles([lead], 1);
  assert.ok(vehicle);

  const { rows, vehicleMinutesById } = getZentrumStopBoard(
    [boardRow(lead, "kronenplatz", 4), boardRow(later, "kronenplatz", 14), unrouted],
    [vehicle],
    "kronenplatz",
    instant(1),
  );

  assert.deepEqual(
    rows.map(({ stopEvent, vehicleId }) => [stopEvent.id, vehicleId]),
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
  const datedJourneys = [
    // Gone already: it left the Europaplatz before the rider got there.
    eastbound("gone", 0),
    eastbound("next", 2),
    // Leaves sooner and stops short, so it wins the Marktplatz and nothing beyond it.
    datedJourney(
      "short",
      "S5",
      [
        ["europaplatz", 1],
        ["marktplatz", 3],
      ],
      "Marktplatz",
    ),
  ];

  const { travelTimesByNodeId, overlay } = getZentrumTravelTimes(
    datedJourneys,
    "europaplatz",
    instant(1),
  );

  assert.deepEqual(Object.fromEntries(travelTimesByNodeId), {
    marktplatz: {
      arrivesAt: instant(3),
      lineId: "S5",
      departsAt: instant(1),
      stopEvent: datedJourneys[2],
      boardingCall: datedJourneys[2].calls![0],
      arrivalCall: datedJourneys[2].calls![1],
    },
    kronenplatz: {
      arrivesAt: instant(6),
      lineId: "S1",
      departsAt: instant(2),
      stopEvent: datedJourneys[1],
      boardingCall: datedJourneys[1].calls![0],
      arrivalCall: datedJourneys[1].calls![2],
    },
  });
  assert.deepEqual([...(overlay.corridorIdsByLineId.get("S5") ?? [])], [EUROPAPLATZ_MARKTPLATZ]);
  assert.deepEqual([...(overlay.corridorIdsByLineId.get("S1") ?? [])].sort(), [
    EUROPAPLATZ_MARKTPLATZ,
    MARKTPLATZ_KRONENPLATZ,
  ]);
});

test("reads the shortest ride to each stop when riding time is the measure", () => {
  const datedJourneys = [
    datedJourney(
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

  const byArrival = getZentrumTravelTimes(datedJourneys, "europaplatz", instant(1));
  const byRide = getZentrumTravelTimes(datedJourneys, "europaplatz", instant(1), "ride");

  assert.equal(byArrival.travelTimesByNodeId.get("kronenplatz")?.lineId, "2");
  assert.deepEqual(byRide.travelTimesByNodeId.get("kronenplatz"), {
    arrivesAt: instant(9),
    lineId: "S1",
    departsAt: instant(5),
    stopEvent: datedJourneys[1],
    boardingCall: datedJourneys[1].calls![0],
    arrivalCall: datedJourneys[1].calls![2],
  });
  assert.equal(getRideMinutes(byRide.travelTimesByNodeId.get("kronenplatz")!), 4);
});

test("counts minutes to an arrival up, never promising one early", () => {
  assert.equal(getMinutesUntilArrival(instant(5), instant(3)), 2);
  assert.equal(getMinutesUntilArrival(instant(5) + 1_000, instant(3)), 3);
  assert.equal(getMinutesUntilArrival(instant(3), instant(5)), 0);
});

test("a shared stop board includes inferred boarding places and lights their physical corridor", () => {
  const atTulla = (stopEvent: StopEvent, code: string, latitude: number, longitude: number) => ({
    ...stopEvent,
    calls: stopEvent.calls?.map((call) =>
      call.stopPlaceId === "tullastrasse"
        ? { ...call, stopPointId: "de:08212:7", bay: code, latitude, longitude }
        : call,
    ),
  });
  const inbound = atTulla(
    datedJourney("inbound", "S2", [
      ["gottesauer-platz", 0],
      ["tullastrasse", 2],
      ["essenweinstrasse", 4],
    ]),
    "4",
    49.007335,
    8.431542,
  );
  const outbound = atTulla(
    datedJourney("outbound", "S2", [
      ["essenweinstrasse", 0],
      ["tullastrasse", 2],
      ["gottesauer-platz", 4],
    ]),
    "3",
    49.006722,
    8.431291,
  );
  const south = atTulla(
    datedJourney("south", "5", [
      ["tullastrasse", 2],
      ["schloss-gottesaue", 4],
      ["wolfartsweierer-strasse", 6],
    ]),
    "3",
    49.006722,
    8.431291,
  );
  const east = atTulla(
    datedJourney("east", "1", [
      ["gottesauer-platz", 0],
      ["tullastrasse", 2],
      ["weinweg", 4],
    ]),
    "1a",
    49.006292,
    8.43165,
  );
  const west = atTulla(
    datedJourney("west", "1", [
      ["weinweg", 0],
      ["tullastrasse", 2],
      ["gottesauer-platz", 4],
    ]),
    "2a",
    49.006097,
    8.432522,
  );
  const datedJourneys = [inbound, outbound, south, east, west];
  const vehicles = placeVehicles(datedJourneys, 1);
  const vehicle = vehicles.find((v) => v.stopEvent.id === inbound.id)!;
  assert.ok(vehicle.to.id.startsWith("tullastrasse@"));
  const board = getZentrumStopBoard([inbound], vehicles, "tullastrasse", instant(1));
  assert.equal(board.rows[0].vehicleId, vehicle.id);
  const times = getZentrumTravelTimes(datedJourneys, "tullastrasse", instant(1));
  assert.ok(times.travelTimesByNodeId.has("schloss-gottesaue"));
  assert.ok(
    times.overlay.corridorIdsByLineId.get("5")?.has(`schloss-gottesaue\u0000${vehicle.to.id}`),
  );
});
