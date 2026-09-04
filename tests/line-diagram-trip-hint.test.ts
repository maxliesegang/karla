import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getSelectedTripPositionHint } from "../src/lib/departure-presentation.ts";
import { createCall } from "./support/calls.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

const trip = (
  tripCalls: readonly TripCall[],
  status: Departure["status"] = "realtime",
): Departure => ({
  id: "hint-trip",
  tripId: "hint-trip",
  lineId: "2",
  transportMode: "tram",
  destination: "C",
  minutesUntilDeparture: 0,
  platformCode: "1",
  boardingLocalStopId: "b",
  status,
  scheduledDepartureTime: new Date(start + 60_000).toISOString(),
  tripCalls: [...tripCalls],
});

const calls = [call("a", 0), call("b", 1), call("c", 2)];

test("says nothing while the trip is drawn on the line", () => {
  assert.equal(getSelectedTripPositionHint(trip(calls), true, start + 60_000), undefined);
  assert.equal(getSelectedTripPositionHint(undefined, false, start), undefined);
  // Nothing has been drawn to be missing from: the diagram states that emptiness itself.
  assert.equal(getSelectedTripPositionHint(trip([call("a", 0)]), false, start), undefined);
});

test("names the start of a run that has not begun, with the deviation in the time", () => {
  assert.equal(
    getSelectedTripPositionHint(trip(calls), false, start - 5 * 60_000),
    "Noch nicht unterwegs · Start 14:00 ab A",
  );
  assert.equal(
    getSelectedTripPositionHint(
      trip([call("a", 0, 3), call("b", 1), call("c", 2)]),
      false,
      start - 60_000,
    ),
    "Noch nicht unterwegs · Start 14:03 ab A",
  );
});

test("states where a finished run ended rather than leaving the diagram unexplained", () => {
  assert.equal(
    getSelectedTripPositionHint(trip(calls), false, start + 9 * 60_000),
    "Fahrt beendet · 14:02 C",
  );
});

test("claims no position for a cancelled trip or a run it cannot place", () => {
  assert.equal(
    getSelectedTripPositionHint(trip(calls, "cancelled"), false, start - 60_000),
    "Entfällt · keine Position auf der Linie",
  );
  assert.equal(
    getSelectedTripPositionHint(trip(calls), false, start + 90_000),
    "Position derzeit nicht bekannt",
  );
});
