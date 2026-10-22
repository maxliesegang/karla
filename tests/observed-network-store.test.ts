import assert from "node:assert/strict";
import test from "node:test";
import { ObservedNetworkStore } from "../src/data/observed-network-store.ts";
import { DATED_JOURNEY_ENDED_GRACE_MS } from "../src/data/dated-journey-reading-store.ts";
import type { StopEvent, StopEventBoard, Call } from "../src/data/transit-types.ts";
import { createStopEvent } from "./support/fixtures.ts";

const call = (stopName: string, localStopId: string): Call => ({ stopName, localStopId });

const stopEvent = (
  id: string,
  lineId: string,
  destination: string,
  calls: readonly Call[],
  status: StopEvent["status"] = "realtime",
): StopEvent =>
  createStopEvent({
    id,
    journeyRef: id,
    lineId,
    ptMode: "tram",
    destinationText: destination,
    minutesUntilDeparture: 2,
    bay: "1",
    boardingLocalStopId: calls[0]?.localStopId ?? "europaplatz",
    boardingProviderStopPointId: "provider-stop",
    boardingProviderStopPointName: "Provider stop",
    status,
    timetabledDepartureTime: "2026-09-07T12:00:00+02:00",
    calls,
    readAt: { rowReadAt: 1, sequenceReadAt: 1 },
  });

const board = (stopId: string, stopEvents: readonly StopEvent[]): StopEventBoard => ({
  stopId,
  receivedAt: 1,
  stopEvents,
  dataStatus: "live",
  feedUpdatedAt: "2026-09-07T12:00:00+02:00",
});

test("accumulates topology learned by separate view boards", () => {
  const store = new ObservedNetworkStore();
  store.rememberBoard(
    board("europaplatz", [
      stopEvent("trip-1", "1", "Durlach", [
        call("Europaplatz", "europaplatz"),
        call("Marktplatz", "marktplatz"),
      ]),
    ]),
  );
  store.rememberBoard(
    board("hauptbahnhof", [
      stopEvent("trip-2", "2", "Durlach", [
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
  assert.equal(store.getSnapshot().journeyCount, 2);
});

test("re-reading one timetable trip neither double-counts it nor emits a change", () => {
  const store = new ObservedNetworkStore();
  const listeners: number[] = [];
  store.subscribe(() => listeners.push(store.getSnapshot().journeyCount));
  const reading = board("europaplatz", [
    stopEvent("trip-1", "1", "Durlach", [
      call("Europaplatz", "europaplatz"),
      call("Marktplatz", "marktplatz"),
    ]),
  ]);

  store.rememberBoard(reading);
  store.rememberBoard(reading);

  assert.equal(store.getSnapshot().journeyCount, 1);
  assert.deepEqual(listeners, [1]);
});

test("keeps topology but not a run's timing fields", () => {
  const store = new ObservedNetworkStore();
  store.rememberBoard(
    board("europaplatz", [
      stopEvent("trip-1", "1", "Durlach", [
        {
          ...call("Europaplatz", "europaplatz"),
          timetabledDepartureTime: "2026-09-07T12:00:00+02:00",
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
      stopEvent(
        "cancelled",
        "1",
        "Durlach",
        [call("Europaplatz", "europaplatz"), call("Marktplatz", "marktplatz")],
        "cancelled",
      ),
      stopEvent(
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
  store.subscribe(() => listeners.push(store.getSnapshot().journeyCount));
  store.rememberBoard(
    board("europaplatz", [
      stopEvent("trip-1", "1", "Durlach", [
        call("Europaplatz", "europaplatz"),
        { ...call("Marktplatz", "marktplatz"), timetabledArrivalTime: "2026-09-07T12:10:00+02:00" },
      ]),
    ]),
    lastCallAt - 60_000,
  );
  assert.deepEqual(
    store.getSnapshot().lines.map(({ id }) => id),
    ["1"],
  );

  // Past its last call and the grace, any later board retires it — even one that names nothing.
  store.rememberBoard(board("hauptbahnhof", []), lastCallAt + DATED_JOURNEY_ENDED_GRACE_MS + 1);
  assert.deepEqual(store.getSnapshot().lines, []);
  assert.deepEqual(listeners, [1, 0]);
});
