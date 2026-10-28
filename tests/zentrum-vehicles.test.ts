import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, StopEventBoard, Call } from "../src/data/transit-types.ts";
import { getZentrumDatedJourneyObservation } from "../src/lib/zentrum-dated-journey-observation.ts";
import { createStopEvent } from "./support/fixtures.ts";

const call = (stopPlaceId: string): Call => ({
  stopName: stopPlaceId,
  stopPlaceId,
  stopPointId: `${stopPlaceId}-1`,
  bay: "1",
});

const stopEvent = (id: string, overrides: Partial<StopEvent> = {}): StopEvent =>
  createStopEvent({
    id,
    lineId: "S1",
    ptMode: "tram",
    destinationText: "Testziel",
    minutesUntilDeparture: 3,
    bay: "1",
    boardingStopPlaceId: "europaplatz",
    boardingStopPointId: "europaplatz-1",
    boardingStopPointName: "Europaplatz",
    status: "realtime",
    timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
    calls: [call("europaplatz"), call("marktplatz")],
    journeyRef: id,
    ...overrides,
  });

const board = (
  stopId: string,
  receivedAt: number,
  stopEvents: readonly StopEvent[],
  dataStatus: StopEventBoard["dataStatus"] = "live",
): StopEventBoard => {
  // Dated by the board they came off, exactly as the source dates every row it publishes.
  const rows = stopEvents.map((stopEvent) => ({
    ...stopEvent,
    readAt: { rowReadAt: receivedAt, sequenceReadAt: receivedAt },
  }));
  return dataStatus === "live"
    ? {
        stopId,
        receivedAt,
        dataStatus,
        feedUpdatedAt: "2026-09-04T11:57:00+02:00",
        stopEvents: rows,
      }
    : { stopId, receivedAt, dataStatus, errorMessage: "unavailable", stopEvents: rows };
};

test("reads journeys from every supplied live board, including an opened stop", () => {
  const observation = getZentrumDatedJourneyObservation([
    board("europaplatz", 10, [stopEvent("a")]),
    board("durlacher-tor", 10, [stopEvent("b")]),
    // A post that could not be read states nothing about what is running.
    board("karlstor", 10, [stopEvent("c")], "unavailable"),
  ]);

  assert.deepEqual(
    observation.datedJourneyStopEvents.map(({ id }) => id),
    ["a", "b"],
  );
});

test("only what the plan can draw: a journey with calls, on rails", () => {
  const observation = getZentrumDatedJourneyObservation([
    board("europaplatz", 10, [
      stopEvent("rail"),
      stopEvent("bus", { journeyRef: "bus", ptMode: "bus" }),
      stopEvent("uncalled", { journeyRef: "uncalled", calls: [] }),
    ]),
  ]);

  assert.deepEqual(
    observation.datedJourneyStopEvents.map(({ id }) => id),
    ["rail"],
  );
});

test("one vehicle read at two posts is one mark, stamped with the board its row came off", () => {
  const shared = { journeyRef: "one-journey", lineId: "S1" };
  const observation = getZentrumDatedJourneyObservation([
    board("europaplatz", 10, [stopEvent("early", shared)]),
    board("karlstor", 40, [stopEvent("late", shared)]),
  ]);

  // The freshest post answers for the vehicle, and every row keeps the age of its own board.
  assert.deepEqual(
    observation.datedJourneyStopEvents.map(({ id }) => id),
    ["late"],
  );
  assert.deepEqual(observation.datedJourneyStopEvents[0].readAt, {
    rowReadAt: 40,
    sequenceReadAt: 40,
  });
  // The marks are moved against the freshest post, which is the newest reading in hand.
  assert.equal(observation.clockBoard?.receivedAt, 40);
});

test("no post answered at all is no reading, and no clock", () => {
  const observation = getZentrumDatedJourneyObservation([]);

  assert.deepEqual(observation.datedJourneyStopEvents, []);
  assert.equal(observation.clockBoard, null);
});
