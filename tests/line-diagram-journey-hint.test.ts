import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import { getDatedJourneyPositionHint } from "../src/lib/stop-event-presentation.ts";
import { createCall } from "./support/calls.ts";
import { createStopEvent } from "./support/fixtures.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

const journey = (
  journeyCalls: readonly Call[],
  status: StopEvent["status"] = "realtime",
): StopEvent =>
  createStopEvent({
    id: "hint-trip",
    journeyRef: "hint-trip",
    lineId: "2",
    ptMode: "tram",
    destinationText: "C",
    minutesUntilDeparture: 0,
    bay: "1",
    boardingLocalStopId: "b",
    status,
    timetabledDepartureTime: new Date(start + 60_000).toISOString(),
    calls: [...journeyCalls],
  });

const calls = [call("a", 0), call("b", 1), call("c", 2)];

test("says nothing while the trip is drawn on the line", () => {
  assert.equal(getDatedJourneyPositionHint(journey(calls), true, start + 60_000), undefined);
  assert.equal(getDatedJourneyPositionHint(undefined, false, start), undefined);
  // Nothing has been drawn to be missing from: the diagram states that emptiness itself.
  assert.equal(getDatedJourneyPositionHint(journey([call("a", 0)]), false, start), undefined);
});

test("names the start of a run that has not begun, with the deviation in the time", () => {
  assert.equal(
    getDatedJourneyPositionHint(journey(calls), false, start - 5 * 60_000),
    "Noch nicht unterwegs · Start 14:00 ab A",
  );
  assert.equal(
    getDatedJourneyPositionHint(
      journey([call("a", 0, 3), call("b", 1), call("c", 2)]),
      false,
      start - 60_000,
    ),
    "Noch nicht unterwegs · Start 14:03 ab A",
  );
});

test("states where a finished run ended rather than leaving the diagram unexplained", () => {
  assert.equal(
    getDatedJourneyPositionHint(journey(calls), false, start + 9 * 60_000),
    "Fahrt beendet · 14:02 C",
  );
});

test("claims no position for a cancelled trip or a run it cannot place", () => {
  assert.equal(
    getDatedJourneyPositionHint(journey(calls, "cancelled"), false, start - 60_000),
    "Entfällt · keine Position auf der Linie",
  );
  assert.equal(
    getDatedJourneyPositionHint(journey(calls), false, start + 90_000),
    "Position derzeit nicht bekannt",
  );
});
