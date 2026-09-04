import assert from "node:assert/strict";
import test from "node:test";
import type { Departure } from "../src/data/transit-types.ts";
import {
  getExpectedDepartureTime,
  groupDeparturesByPlatform,
  sortDeparturesByExpectedTime,
} from "../src/lib/departure-order.ts";

const BASE = Date.parse("2026-08-24T14:30:00+02:00");

const createDeparture = (
  id: string,
  lineId: string,
  minutes: number,
  overrides: Partial<Departure> = {},
): Departure => ({
  id,
  lineId,
  transportMode: "tram",
  destination: "Durlach Turmberg",
  minutesUntilDeparture: minutes,
  platformCode: "1",
  boardingLocalStopId: "marktplatz",
  status: "realtime",
  scheduledDepartureTime: new Date(BASE + minutes * 60_000).toISOString(),
  ...overrides,
});

test("orders a board by the time its countdowns are counted to, not by the schedule", () => {
  const delayed = createDeparture("delayed", "1", 3, { delayMinutes: 6 });
  const punctual = createDeparture("punctual", "2", 5, { delayMinutes: 0 });

  assert.deepEqual(
    sortDeparturesByExpectedTime([delayed, punctual]).map((departure) => departure.id),
    ["punctual", "delayed"],
  );
});

test("leaves an unmonitored departure on its schedule", () => {
  const unmonitored = createDeparture("unmonitored", "1", 7);

  assert.equal(getExpectedDepartureTime(unmonitored), BASE + 7 * 60_000);
});

test("applies no deviation to a cancelled trip, which is expected nowhere", () => {
  const cancelled = createDeparture("cancelled", "1", 4, { status: "cancelled", delayMinutes: 9 });

  assert.equal(getExpectedDepartureTime(cancelled), BASE + 4 * 60_000);
});

test("sorts a departure the feed stated no schedule for last, rather than to an invented time", () => {
  const untimed = createDeparture("untimed", "1", 2, { scheduledDepartureTime: "" });
  const timed = createDeparture("timed", "2", 8);

  assert.deepEqual(
    sortDeparturesByExpectedTime([untimed, timed]).map((departure) => departure.id),
    ["timed", "untimed"],
  );
  // With the feed's clock in hand its own countdown is all there is, and it is used.
  assert.equal(getExpectedDepartureTime(untimed, BASE), BASE + 2 * 60_000);
});

test("keeps departures the feed states no time for in the order it listed them", () => {
  const first = createDeparture("first", "1", 2, { scheduledDepartureTime: "" });
  const second = createDeparture("second", "2", 4, { scheduledDepartureTime: "" });

  assert.deepEqual(
    sortDeparturesByExpectedTime([first, second]).map((departure) => departure.id),
    ["first", "second"],
  );
});

test("gathers a board by Steig, in platform order, keeping each group in departure order", () => {
  const board = [
    createDeparture("a", "1", 2, { platformCode: "2" }),
    createDeparture("b", "2", 3, { platformCode: "10" }),
    createDeparture("c", "3", 4, { platformCode: "2" }),
    createDeparture("d", "4", 5, { platformCode: "1" }),
  ];

  assert.deepEqual(
    groupDeparturesByPlatform(board).map((group) => [
      group.platformCode,
      group.departures.map((departure) => departure.id),
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
    createDeparture("unplaced", "1", 2, { platformCode: "" }),
    createDeparture("placed", "2", 3, { platformCode: "3" }),
  ];

  assert.deepEqual(
    groupDeparturesByPlatform(board).map((group) => group.platformCode),
    ["3", ""],
  );
});
