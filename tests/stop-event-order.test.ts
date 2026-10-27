import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent } from "../src/data/transit-types.ts";
import {
  getExpectedDepartureInstant,
  groupStopEventsByBay,
  sortStopEventsByExpectedInstant,
} from "../src/lib/stop-event-order.ts";
import { createStopEvent as createFixture } from "./support/fixtures.ts";

const BASE = Date.parse("2026-08-24T14:30:00+02:00");

const createStopEvent = (
  id: string,
  lineId: string,
  minutes: number,
  overrides: Partial<StopEvent> = {},
): StopEvent =>
  createFixture({
    id,
    lineId,
    ptMode: "tram",
    destinationText: "Durlach Turmberg",
    minutesUntilDeparture: minutes,
    bay: "1",
    boardingStopPlaceId: "marktplatz",
    status: "realtime",
    timetabledDepartureTime: new Date(BASE + minutes * 60_000).toISOString(),
    ...overrides,
  });

test("orders a board by the time its countdowns are counted to, not by the schedule", () => {
  const delayed = createStopEvent("delayed", "1", 3, { delayMinutes: 6 });
  const punctual = createStopEvent("punctual", "2", 5, { delayMinutes: 0 });

  assert.deepEqual(
    sortStopEventsByExpectedInstant([delayed, punctual]).map((stopEvent) => stopEvent.id),
    ["punctual", "delayed"],
  );
});

test("leaves an unmonitored departure on its schedule", () => {
  const unmonitored = createStopEvent("unmonitored", "1", 7);

  assert.equal(getExpectedDepartureInstant(unmonitored), BASE + 7 * 60_000);
});

test("applies no deviation to a cancelled trip, which is expected nowhere", () => {
  const cancelled = createStopEvent("cancelled", "1", 4, { status: "cancelled", delayMinutes: 9 });

  assert.equal(getExpectedDepartureInstant(cancelled), BASE + 4 * 60_000);
});

test("sorts a departure the feed stated no schedule for last, rather than to an invented time", () => {
  const untimed = createStopEvent("untimed", "1", 2, { timetabledDepartureTime: "" });
  const timed = createStopEvent("timed", "2", 8);

  assert.deepEqual(
    sortStopEventsByExpectedInstant([untimed, timed]).map((stopEvent) => stopEvent.id),
    ["timed", "untimed"],
  );
  // With the feed's clock in hand its own countdown is all there is, and it is used.
  assert.equal(getExpectedDepartureInstant(untimed, BASE), BASE + 2 * 60_000);
});

test("keeps departures the feed states no time for in the order it listed them", () => {
  const first = createStopEvent("first", "1", 2, { timetabledDepartureTime: "" });
  const second = createStopEvent("second", "2", 4, { timetabledDepartureTime: "" });

  assert.deepEqual(
    sortStopEventsByExpectedInstant([first, second]).map((stopEvent) => stopEvent.id),
    ["first", "second"],
  );
});

test("gathers a board by Steig, in platform order, keeping each group in departure order", () => {
  const board = [
    createStopEvent("a", "1", 2, { bay: "2" }),
    createStopEvent("b", "2", 3, { bay: "10" }),
    createStopEvent("c", "3", 4, { bay: "2" }),
    createStopEvent("d", "4", 5, { bay: "1" }),
  ];

  assert.deepEqual(
    groupStopEventsByBay(board).map((group) => [
      group.bay,
      group.stopEvents.map((stopEvent) => stopEvent.id),
    ]),
    [
      ["1", ["d"]],
      ["2", ["a", "c"]],
      ["10", ["b"]],
    ],
  );
});

test("puts trips the feed named no Steig for last, since that group is nowhere to walk to", () => {
  const board = [
    createStopEvent("unplaced", "1", 2, { bay: "" }),
    createStopEvent("placed", "2", 3, { bay: "3" }),
  ];

  assert.deepEqual(
    groupStopEventsByBay(board).map((group) => group.bay),
    ["3", ""],
  );
});
