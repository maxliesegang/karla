import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { getZentrumRunObservation } from "../src/lib/zentrum-run-observation.ts";
import { createDeparture } from "./support/fixtures.ts";

const call = (localStopId: string): TripCall => ({
  stopName: localStopId,
  localStopId,
  providerStopPointId: `${localStopId}-1`,
  platformCode: "1",
});

const departure = (id: string, overrides: Partial<Departure> = {}): Departure =>
  createDeparture({
    id,
    lineId: "S1",
    transportMode: "tram",
    destination: "Testziel",
    minutesUntilDeparture: 3,
    platformCode: "1",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: "europaplatz-1",
    boardingProviderStopPointName: "Europaplatz",
    status: "realtime",
    scheduledDepartureTime: "2026-09-04T12:00:00+02:00",
    tripCalls: [call("europaplatz"), call("marktplatz")],
    tripId: id,
    ...overrides,
  });

const board = (
  stopId: string,
  receivedAt: number,
  departures: readonly Departure[],
  dataStatus: DepartureBoard["dataStatus"] = "live",
): DepartureBoard => {
  // Dated by the board they came off, exactly as the source dates every row it publishes.
  const rows = departures.map((departure) => ({
    ...departure,
    readAt: { rowReadAt: receivedAt, sequenceReadAt: receivedAt },
  }));
  return dataStatus === "live"
    ? {
        stopId,
        receivedAt,
        dataStatus,
        feedUpdatedAt: "2026-09-04T11:57:00+02:00",
        departures: rows,
      }
    : { stopId, receivedAt, dataStatus, errorMessage: "unavailable", departures: rows };
};

test("reads runs from every supplied live board, including an opened stop", () => {
  const observation = getZentrumRunObservation([
    board("europaplatz", 10, [departure("a")]),
    board("durlacher-tor", 10, [departure("b")]),
    // A post that could not be read states nothing about what is running.
    board("karlstor", 10, [departure("c")], "unavailable"),
  ]);

  assert.deepEqual(
    observation.runDepartures.map(({ id }) => id),
    ["a", "b"],
  );
});

test("only what the plan can draw: a run with calls, on rails", () => {
  const observation = getZentrumRunObservation([
    board("europaplatz", 10, [
      departure("rail"),
      departure("bus", { tripId: "bus", transportMode: "bus" }),
      departure("uncalled", { tripId: "uncalled", tripCalls: [] }),
    ]),
  ]);

  assert.deepEqual(
    observation.runDepartures.map(({ id }) => id),
    ["rail"],
  );
});

test("one vehicle read at two posts is one mark, stamped with the board its row came off", () => {
  const shared = { tripId: "one-run", lineId: "S1" };
  const observation = getZentrumRunObservation([
    board("europaplatz", 10, [departure("early", shared)]),
    board("karlstor", 40, [departure("late", shared)]),
  ]);

  // The freshest post answers for the vehicle, and every row keeps the age of its own board.
  assert.deepEqual(
    observation.runDepartures.map(({ id }) => id),
    ["late"],
  );
  assert.deepEqual(observation.runDepartures[0].readAt, { rowReadAt: 40, sequenceReadAt: 40 });
  // The marks are moved against the freshest post, which is the newest reading in hand.
  assert.equal(observation.clockBoard?.receivedAt, 40);
});

test("no post answered at all is no reading, and no clock", () => {
  const observation = getZentrumRunObservation([]);

  assert.deepEqual(observation.runDepartures, []);
  assert.equal(observation.clockBoard, null);
});
