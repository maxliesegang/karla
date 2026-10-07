import assert from "node:assert/strict";
import test from "node:test";
import type { DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import {
  findZentrumBoardingDeparture,
  getZentrumBoardingPlatformLabel,
  getZentrumTravelSourceLabel,
  getZentrumVehiclePlaceLabel,
} from "../src/lib/zentrum-presentation.ts";
import {
  getZentrumDirectRides,
  getZentrumTravelTimes,
} from "../src/lib/zentrum-schematic-overlays.ts";
import { createDeparture } from "./support/fixtures.ts";

const at = (minute: number) => `2026-09-04T12:${String(minute).padStart(2, "0")}:00+02:00`;
const instant = (minute: number) => Date.parse(at(minute));
const call = (id: string, minute: number, platformCode = "1"): TripCall => ({
  localStopId: id,
  stopName: id,
  providerStopPointId: id,
  platformCode,
  platformLabel: `Gleis ${platformCode}`,
  scheduledArrivalTime: at(minute),
  scheduledDepartureTime: at(minute),
  delayMinutes: 0,
});
const board = (stopId: string, minute: number): DepartureBoard => ({
  stopId,
  receivedAt: instant(minute),
  feedUpdatedAt: at(minute),
  dataStatus: "live",
  departures: [],
});

test("vehicle labels distinguish a stand, travel, and the end of a run", () => {
  const vehicle = {
    from: { id: "europaplatz", label: "Europaplatz", x: 0, y: 0 },
    to: { id: "marktplatz", label: "Marktplatz", x: 100, y: 0 },
    progress: 0,
  };
  assert.equal(getZentrumVehiclePlaceLabel(vehicle), "Hält an Europaplatz");
  assert.equal(
    getZentrumVehiclePlaceLabel({ ...vehicle, progress: 0.5 }),
    "Zwischen Europaplatz und Marktplatz",
  );
  assert.equal(getZentrumVehiclePlaceLabel({ ...vehicle, progress: 1 }), "Hält an Marktplatz");
  assert.equal(
    getZentrumVehiclePlaceLabel({ ...vehicle, phase: "beforeStart" }),
    "Steht an Europaplatz vor Abfahrt",
  );
  assert.equal(
    getZentrumVehiclePlaceLabel({ ...vehicle, progress: 1, phase: "afterEnd" }),
    "Steht an Marktplatz (Fahrt endet hier)",
  );
});

test("an unmonitored arrival stays a timetable estimate even with a predicted departure", () => {
  const departure = createDeparture({ tripCalls: [call("europaplatz", 1), call("marktplatz", 4)] });
  const time = getZentrumTravelTimes(
    [departure],
    "europaplatz",
    instant(0),
  ).travelTimesByNodeId.get("marktplatz")!;
  assert.equal(getZentrumTravelSourceLabel(time), "nach Echtzeitprognose");
  assert.equal(
    getZentrumTravelSourceLabel({
      ...time,
      arrivalCall: { ...time.arrivalCall, delayMinutes: undefined },
    }),
    "nach Fahrplan",
  );
  assert.equal(
    getZentrumTravelSourceLabel({
      ...time,
      boardingCall: { ...time.boardingCall, delayMinutes: undefined },
    }),
    "nach Fahrplan",
  );
});

test("a direct ride retains its last boarding call in a complex, never another stop's platform", () => {
  const departure = createDeparture({
    id: "origin-reading",
    tripId: "run-2",
    lineId: "2",
    platformCode: "9",
    boardingLocalStopId: "kronenplatz",
    boardingProviderStopPointId: "kronenplatz",
    tripCalls: [call("europaplatz", 1), call("europaplatz", 2, "4"), call("marktplatz", 5)],
  });
  const time = getZentrumTravelTimes(
    [departure],
    "europaplatz",
    instant(0),
  ).travelTimesByNodeId.get("marktplatz")!;
  assert.equal(time.departsAt, instant(2));
  assert.equal(time.departure, departure);
  assert.equal(getZentrumBoardingPlatformLabel(time.boardingCall), "Gleis 4");
  const wrongPlace = createDeparture({
    ...departure,
    id: "other-platform",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: "europaplatz",
    platformCode: "1",
  });
  const boardingRow = createDeparture({
    ...wrongPlace,
    id: "boarding",
    platformCode: "4",
    platformKind: "track",
    serviceNote: "Einstieg hinten",
  });
  const originBoard: DepartureBoard = {
    ...board("europaplatz", 0),
    departures: [departure, wrongPlace, boardingRow],
  };
  assert.equal(findZentrumBoardingDeparture(originBoard, time), boardingRow);
  assert.equal(
    findZentrumBoardingDeparture({ ...originBoard, departures: [departure, wrongPlace] }, time),
    undefined,
  );
  assert.equal(getZentrumBoardingPlatformLabel({ stopName: "Unbekannt" }), "Ohne Steigangabe");
});

test("every run's direct ride between two stops is listed, soonest departure first", () => {
  const ride = (id: string, lineId: string, leaves: number, arrives: number) =>
    createDeparture({
      id,
      lineId,
      tripCalls: [call("europaplatz", leaves), call("marktplatz", arrives)],
    });
  const rides = getZentrumDirectRides(
    [ride("later", "2", 8, 11), ride("sooner", "S1", 3, 5), ride("gone", "2", 0, 1)],
    "europaplatz",
    "marktplatz",
    instant(1),
  );
  assert.deepEqual(
    rides.map(({ departure }) => departure.id),
    ["sooner", "later"],
  );
});
