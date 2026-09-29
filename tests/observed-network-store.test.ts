import assert from "node:assert/strict";
import test from "node:test";
import { ObservedNetworkStore } from "../src/data/observed-network-store.ts";
import { RUN_ENDED_GRACE_MS } from "../src/data/run-reading-store.ts";
import type { Departure, DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { createDeparture } from "./support/fixtures.ts";

const call = (stopName: string, localStopId: string): TripCall => ({ stopName, localStopId });

const departure = (
  id: string,
  lineId: string,
  destination: string,
  tripCalls: readonly TripCall[],
  status: Departure["status"] = "realtime",
): Departure =>
  createDeparture({
    id,
    tripId: id,
    lineId,
    transportMode: "tram",
    destination,
    minutesUntilDeparture: 2,
    platformCode: "1",
    boardingLocalStopId: tripCalls[0]?.localStopId ?? "europaplatz",
    boardingProviderStopPointId: "provider-stop",
    boardingProviderStopPointName: "Provider stop",
    status,
    scheduledDepartureTime: "2026-09-07T12:00:00+02:00",
    tripCalls,
    readAt: { rowReadAt: 1, sequenceReadAt: 1 },
  });

const board = (stopId: string, departures: readonly Departure[]): DepartureBoard => ({
  stopId,
  receivedAt: 1,
  departures,
  dataStatus: "live",
  feedUpdatedAt: "2026-09-07T12:00:00+02:00",
});

test("accumulates topology learned by separate view boards", () => {
  const store = new ObservedNetworkStore();
  store.rememberBoard(
    board("europaplatz", [
      departure("trip-1", "1", "Durlach", [
        call("Europaplatz", "europaplatz"),
        call("Marktplatz", "marktplatz"),
      ]),
    ]),
  );
  store.rememberBoard(
    board("hauptbahnhof", [
      departure("trip-2", "2", "Durlach", [
        call("Hauptbahnhof", "hauptbahnhof"),
        call("Marktplatz", "marktplatz"),
      ]),
    ]),
  );

  assert.deepEqual(
    store
      .getSnapshot()
      .lines.map(({ id }) => id)
      .sort(),
    ["1", "2"],
  );
  assert.equal(store.getSnapshot().tripCount, 2);
});

test("re-reading one timetable trip neither double-counts it nor emits a change", () => {
  const store = new ObservedNetworkStore();
  const listeners: number[] = [];
  store.subscribe(() => listeners.push(store.getSnapshot().tripCount));
  const reading = board("europaplatz", [
    departure("trip-1", "1", "Durlach", [
      call("Europaplatz", "europaplatz"),
      call("Marktplatz", "marktplatz"),
    ]),
  ]);

  store.rememberBoard(reading);
  store.rememberBoard(reading);

  assert.equal(store.getSnapshot().tripCount, 1);
  assert.deepEqual(listeners, [1]);
});

test("keeps topology but not a run's timing fields", () => {
  const store = new ObservedNetworkStore();
  store.rememberBoard(
    board("europaplatz", [
      departure("trip-1", "1", "Durlach", [
        {
          ...call("Europaplatz", "europaplatz"),
          scheduledDepartureTime: "2026-09-07T12:00:00+02:00",
          delayMinutes: 4,
        },
        call("Marktplatz", "marktplatz"),
      ]),
    ]),
  );

  // The public snapshot exposes topology only; a later run reading cannot be recovered from it.
  assert.deepEqual(
    store.getSnapshot().stops.map(({ id }) => id),
    ["europaplatz", "marktplatz"],
  );
});

test("excludes cancelled runs but accepts a diverted route", () => {
  const store = new ObservedNetworkStore();
  store.rememberBoard(
    board("europaplatz", [
      departure(
        "cancelled",
        "1",
        "Durlach",
        [call("Europaplatz", "europaplatz"), call("Marktplatz", "marktplatz")],
        "cancelled",
      ),
      departure(
        "diverted",
        "2",
        "Durlach",
        [call("Europaplatz", "europaplatz"), call("Kronenplatz", "kronenplatz")],
        "diverted",
      ),
    ]),
  );

  assert.deepEqual(
    store.getSnapshot().lines.map(({ id }) => id),
    ["2"],
  );
  assert.deepEqual(
    store.getSnapshot().stops.map(({ id }) => id),
    ["europaplatz", "kronenplatz"],
  );
});

test("forgets a trip once it has run, so a line that stops running leaves", () => {
  const store = new ObservedNetworkStore();
  const lastCallAt = Date.parse("2026-09-07T12:10:00+02:00");
  const listeners: number[] = [];
  store.subscribe(() => listeners.push(store.getSnapshot().tripCount));
  store.rememberBoard(
    board("europaplatz", [
      departure("trip-1", "1", "Durlach", [
        call("Europaplatz", "europaplatz"),
        { ...call("Marktplatz", "marktplatz"), scheduledArrivalTime: "2026-09-07T12:10:00+02:00" },
      ]),
    ]),
    lastCallAt - 60_000,
  );
  assert.deepEqual(
    store.getSnapshot().lines.map(({ id }) => id),
    ["1"],
  );

  // Past its last call and the grace, any later board retires it — even one that names nothing.
  store.rememberBoard(board("hauptbahnhof", []), lastCallAt + RUN_ENDED_GRACE_MS + 1);
  assert.deepEqual(store.getSnapshot().lines, []);
  assert.deepEqual(listeners, [1, 0]);
});
