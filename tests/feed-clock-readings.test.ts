import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, StopEventBoard } from "../src/data/transit-types.ts";
import { getCountdownMinutes } from "../src/lib/feed-clock.ts";
import {
  getStopEventStatusLabel,
  getDepartureTimeReading,
  getStaleBoardLabel,
  getCallTimeReading,
} from "../src/lib/stop-event-presentation.ts";
import { parseTriasStopEvents } from "../src/data/trias-parsers.ts";
import { sortStopEventsByExpectedInstant } from "../src/lib/stop-event-order.ts";
import { createStopEvent as createFixture } from "./support/fixtures.ts";
import { triasStopEvent, triasStopEvents } from "./support/trias.ts";

const createStopEvent = (overrides: Partial<StopEvent> = {}): StopEvent =>
  createFixture({
    id: "trip-1",
    lineId: "1",
    ptMode: "tram",
    destinationText: "Durlach Turmberg",
    minutesUntilDeparture: 7,
    bay: "1",
    boardingLocalStopId: "marktplatz",
    status: "realtime",
    timetabledDepartureTime: "2026-08-30T17:32:00+02:00",
    ...overrides,
  });

/**
 * The operator counts `17:34` minus `17:27` as seven; counting seconds would read a minute below the
 * platform display.
 */
test("a countdown is counted against the feed's clock at the minute, as the operator's own board is", () => {
  const stopEvent = createStopEvent({ delayMinutes: 2 });
  const feedNow = Date.parse("2026-08-30T17:27:24+02:00");

  assert.equal(getCountdownMinutes(stopEvent, feedNow), 7);
});

test("a departure still passes on its own once the minute it was due has gone by", () => {
  const stopEvent = createStopEvent({ delayMinutes: 2 });

  assert.equal(getCountdownMinutes(stopEvent, Date.parse("2026-08-30T17:33:59+02:00")), 1);
  assert.equal(getCountdownMinutes(stopEvent, Date.parse("2026-08-30T17:34:00+02:00")), 0);
  assert.equal(getCountdownMinutes(stopEvent, Date.parse("2026-08-30T17:40:00+02:00")), 0);
});

/**
 * The delay is truncated, the prediction is not: about one row in twenty has `delay: 0` against a
 * `realDateTime` a minute later, which must not read as punctual.
 */
test("the published time is the feed's own prediction, not the schedule plus its truncated delay", () => {
  const stopEvent = createStopEvent({
    delayMinutes: 0,
    estimatedDepartureTime: "2026-08-30T17:33:00+02:00",
  });
  const reading = getDepartureTimeReading(stopEvent);

  assert.equal(reading?.expectedTime, "17:33");
  assert.equal(reading?.timetabledTime, "17:32");
  assert.equal(reading?.punctuality, "late");
  assert.equal(getCountdownMinutes(stopEvent, Date.parse("2026-08-30T17:27:24+02:00")), 6);
});

test("a trip the feed made no prediction for still reads as unmonitored rather than punctual", () => {
  const stopEvent = createStopEvent({ delayMinutes: undefined });
  const reading = getDepartureTimeReading(stopEvent);

  assert.equal(reading?.punctuality, "unmonitored");
  assert.equal(reading?.timetabledTime, undefined);
  assert.equal(getStopEventStatusLabel(stopEvent), "nach Fahrplan");
});

test("a cancelled trip is moved by neither the prediction nor the delay", () => {
  const reading = getDepartureTimeReading(
    createStopEvent({
      status: "cancelled",
      delayMinutes: 3,
      estimatedDepartureTime: "2026-08-30T17:35:00+02:00",
    }),
  );

  assert.equal(reading?.expectedTime, "17:32");
  assert.equal(reading?.punctuality, "unmonitored");
});

/** Board order matches the printed times, to the minute. */
test("the board is ordered by the prediction the rows publish, not by the delay stated beside it", () => {
  const estimated = createStopEvent({
    id: "predicted",
    delayMinutes: 0,
    estimatedDepartureTime: "2026-08-30T17:33:00+02:00",
  });
  const stated = createStopEvent({
    id: "stated",
    timetabledDepartureTime: "2026-08-30T17:32:30+02:00",
  });

  assert.deepEqual(
    sortStopEventsByExpectedInstant([estimated, stated]).map(({ id }) => id),
    ["stated", "predicted"],
  );
});

/**
 * The row's own call in the sequence carries the row's published time, so board and diagram agree.
 */
test("the call a row completes carries the same published time as the row itself", () => {
  const board = parseTriasStopEvents(
    triasStopEvents("2026-08-30T15:27:24Z", [
      triasStopEvent({
        current: {
          ref: "de:08212:1003:1:1",
          name: "KA Marktplatz",
          departure: { timetabled: "2026-08-30T15:32:00Z", estimated: "2026-08-30T15:33:00Z" },
        },
        onward: [
          {
            ref: "de:08212:1002:1:1",
            name: "KA Kronenplatz",
            departure: { timetabled: "2026-08-30T15:34:00Z", estimated: "2026-08-30T15:34:00Z" },
          },
        ],
      }),
    ]),
    "de:08212:1003",
  );
  const stopEvent = board.stopEvents[0];
  const ownCall = stopEvent.calls?.find((call) => call.isThisCall);
  const feedNow = Date.parse(board.serverTime);

  assert.equal(getDepartureTimeReading(stopEvent)?.expectedTime, "17:33");
  assert.equal(getCallTimeReading(ownCall!, feedNow)?.expectedTime, "17:33");
});

test("a failed refresh is said at once, and the board's age once it is old", () => {
  const readAt = Date.parse("2026-08-30T17:27:00+02:00");
  const board: StopEventBoard = {
    stopId: "marktplatz",
    dataStatus: "live",
    feedUpdatedAt: new Date(readAt).toISOString(),
    receivedAt: readAt,
    stopEvents: [],
  };
  assert.equal(getStaleBoardLabel(board, readAt + 30_000), undefined);

  const retained = { ...board, refreshFailedAt: readAt + 30_000 };
  assert.equal(
    getStaleBoardLabel(retained, readAt + 31_000),
    "Stand 17:27 · Aktualisierung fehlgeschlagen",
  );
  assert.equal(
    getStaleBoardLabel(retained, readAt + 150_000),
    "Stand 17:27 · seit 2 Min ohne Aktualisierung",
  );
});
