import assert from "node:assert/strict";
import test from "node:test";
import type { StopEventBoard, Call } from "../src/data/transit-types.ts";
import {
  findZentrumBoardingStopEvent,
  getZentrumBoardingBayText,
  getZentrumTravelSourceLabel,
  getZentrumVehiclePlaceLabel,
  getZentrumPositionFreshness,
} from "../src/lib/zentrum-presentation.ts";
import {
  getZentrumDirectRides,
  getZentrumTravelTimes,
} from "../src/lib/zentrum-schematic-overlays.ts";
import { createStopEvent } from "./support/fixtures.ts";

const at = (minute: number) => `2026-09-04T12:${String(minute).padStart(2, "0")}:00+02:00`;
const instant = (minute: number) => Date.parse(at(minute));
const call = (id: string, minute: number, bay = "1"): Call => ({
  localStopId: id,
  stopName: id,
  providerStopPointId: id,
  bay,
  bayText: `Gleis ${bay}`,
  timetabledArrivalTime: at(minute),
  timetabledDepartureTime: at(minute),
  delayMinutes: 0,
});
const board = (stopId: string, minute: number): StopEventBoard => ({
  stopId,
  receivedAt: instant(minute),
  feedUpdatedAt: at(minute),
  dataStatus: "live",
  stopEvents: [],
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
  const stopEvent = createStopEvent({ calls: [call("europaplatz", 1), call("marktplatz", 4)] });
  const time = getZentrumTravelTimes(
    [stopEvent],
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

test("a direct ride retains its last boarding call in a stop place, never another stop's platform", () => {
  const stopEvent = createStopEvent({
    id: "origin-reading",
    journeyRef: "run-2",
    lineId: "2",
    bay: "9",
    boardingLocalStopId: "kronenplatz",
    boardingProviderStopPointId: "kronenplatz",
    calls: [call("europaplatz", 1), call("europaplatz", 2, "4"), call("marktplatz", 5)],
  });
  const time = getZentrumTravelTimes(
    [stopEvent],
    "europaplatz",
    instant(0),
  ).travelTimesByNodeId.get("marktplatz")!;
  assert.equal(time.departsAt, instant(2));
  assert.equal(time.stopEvent, stopEvent);
  assert.equal(getZentrumBoardingBayText(time.boardingCall), "Gleis 4");
  const wrongPlace = createStopEvent({
    ...stopEvent,
    id: "other-platform",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: "europaplatz",
    bay: "1",
  });
  const boardingRow = createStopEvent({
    ...wrongPlace,
    id: "boarding",
    bay: "4",
    bayKind: "track",
    serviceNote: "Einstieg hinten",
  });
  const originBoard: StopEventBoard = {
    ...board("europaplatz", 0),
    stopEvents: [stopEvent, wrongPlace, boardingRow],
  };
  assert.equal(findZentrumBoardingStopEvent(originBoard, time), boardingRow);
  assert.equal(
    findZentrumBoardingStopEvent({ ...originBoard, stopEvents: [stopEvent, wrongPlace] }, time),
    undefined,
  );
  assert.equal(getZentrumBoardingBayText({ stopName: "Unbekannt" }), "Ohne Steigangabe");
});

test("every run's direct ride between two stops is listed, soonest departure first", () => {
  const ride = (id: string, lineId: string, leaves: number, arrives: number) =>
    createStopEvent({
      id,
      lineId,
      calls: [call("europaplatz", leaves), call("marktplatz", arrives)],
    });
  const rides = getZentrumDirectRides(
    [ride("later", "2", 8, 11), ride("sooner", "S1", 3, 5), ride("gone", "2", 0, 1)],
    "europaplatz",
    "marktplatz",
    instant(1),
  );
  assert.deepEqual(
    rides.map(({ stopEvent }) => stopEvent.id),
    ["sooner", "later"],
  );
});

test("position freshness uses sequence age and retained coverage rather than board age", () => {
  const datedJourney = createStopEvent({ readAt: { rowReadAt: 0, sequenceReadAt: 100_000 } });
  assert.equal(
    getZentrumPositionFreshness([datedJourney], 120_000),
    "Positionsdaten · bis zu 20 s alt",
  );
  assert.equal(
    getZentrumPositionFreshness(
      [
        {
          ...datedJourney,
          readAt: { ...datedJourney.readAt!, rowReadAt: 119_000, coverageReadAt: 10_000 },
        },
      ],
      120_000,
    ),
    "Ältere Positionsdaten · bis zu 1 min alt",
  );
  assert.equal(getZentrumPositionFreshness([createStopEvent()], 120_000), "Datenalter unbekannt");
});
