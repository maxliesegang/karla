import assert from "node:assert/strict";
import test from "node:test";
import type { FeedStopEvent } from "../src/data/feed.ts";
import { createStopEventId } from "../src/data/transit-source.ts";

/**
 * The pair this exists for is real: two S8 to Karlsruhe Tullastraße leave Augartenstraße Gleis 2
 * scheduled on the same minute, one running three minutes late and one not monitored at all.
 */
const createStopEvent = (overrides: Partial<FeedStopEvent> = {}): FeedStopEvent =>
  ({
    stopPointId: "de:08212:74",
    stopPointName: "Augartenstraße",
    journeyRef: "de:kvv:00S08_:.kvv-22-308-E.7.T0.613.s26",
    lineId: "S8",
    ptMode: "tram",
    destinationText: "Karlsruhe Tullastraße",
    minutesUntilDeparture: 44,
    bay: "2",
    status: "realtime",
    timetabledDepartureTime: "2026-08-24T18:50:00.000Z",
    ...overrides,
  }) as FeedStopEvent;

test("tells two trips apart when line, Steig, destination and scheduled minute are all the same", () => {
  const delayed = createStopEvent({
    delayMinutes: 3,
    estimatedDepartureTime: "2026-08-24T18:53:00.000Z",
  });
  const unmonitored = createStopEvent({
    journeyRef: "de:kvv:00S08_:.kvv-22-308-E.7.T0.667.s26",
    minutesUntilDeparture: 41,
  });

  assert.notEqual(
    createStopEventId(delayed, "augartenstrasse"),
    createStopEventId(unmonitored, "augartenstrasse"),
  );
});

test("keeps a trip's id across refreshes, whatever the feed reports about it now", () => {
  const first = createStopEvent({ minutesUntilDeparture: 44 });
  const later = createStopEvent({ minutesUntilDeparture: 12, delayMinutes: 2, status: "diverted" });

  assert.equal(
    createStopEventId(first, "augartenstrasse"),
    createStopEventId(later, "augartenstrasse"),
  );
});

test("separates the same trip read at two stops, and two runs of a reused trip id", () => {
  const stopEvent = createStopEvent();

  assert.notEqual(
    createStopEventId(stopEvent, "augartenstrasse"),
    createStopEventId(stopEvent, "marktplatz"),
  );
  assert.notEqual(
    createStopEventId(stopEvent, "augartenstrasse"),
    createStopEventId(
      createStopEvent({ timetabledDepartureTime: "2026-08-24T19:50:00.000Z" }),
      "augartenstrasse",
    ),
  );
});

test("falls back to what the departure looks like where the feed names no trip", () => {
  const untripped = createStopEvent({ journeyRef: undefined });

  assert.equal(
    createStopEventId(untripped, "augartenstrasse"),
    "augartenstrasse-S8-2-Karlsruhe Tullastraße-2026-08-24T18:50:00.000Z",
  );
});
