import assert from "node:assert/strict";
import test from "node:test";
import type { KvvTripLocator } from "../src/data/kvv-efa-parsers.ts";
import type { Departure, RunSequence, TripCall } from "../src/data/transit-types.ts";
import { RunReadingStore } from "../src/data/run-reading-store.ts";
import { createDeparture } from "./support/fixtures.ts";

/** A run's provider address; the store keys by `line` and `tripCode`. */
const locator: KvvTripLocator = {
  tripCode: "42",
  line: "kvv:line:2:H",
  stopPointId: "7000001",
  date: "20260906",
  time: "1200",
};

/** The same run's row at another stop: only the asking point moves. */
const atStop = (stopPointId: string, time: string): KvvTripLocator => ({
  ...locator,
  stopPointId,
  time,
});

const calls = (delayMinutes: number): TripCall[] => [
  {
    stopName: "A",
    localStopId: "a",
    scheduledDepartureTime: "2026-09-06T10:00:00.000Z",
    delayMinutes,
  },
  {
    stopName: "B",
    localStopId: "b",
    scheduledArrivalTime: "2026-09-06T10:05:00.000Z",
    delayMinutes,
  },
];

/** Rows the source publishes are dated, so fixtures that rank readings are too. */
const stamp = (departure: Departure, readAt: number): Departure =>
  createDeparture({
    ...departure,
    readAt: { rowReadAt: readAt, sequenceReadAt: readAt },
  });

/** A run read on its own: its calls and when. */
const sequence = (tripCalls: readonly TripCall[], readAt: number): RunSequence => ({
  tripCalls,
  status: "realtime",
  readAt,
});

/** The run this row is a stop of, requested and answered with these calls. */
const read = (store: RunReadingStore, rowId: string, tripCalls: readonly TripCall[], at: number) =>
  store.rememberSequence(store.findRunRecordKey(rowId), sequence(tripCalls, at), at);

const departure = (id: string, stopId: string, overrides: Partial<Departure> = {}): Departure =>
  createDeparture({
    id,
    tripId: "provider-trip",
    lineId: "2",
    transportMode: "tram",
    destination: "B",
    minutesUntilDeparture: 1,
    platformCode: "1",
    boardingLocalStopId: stopId,
    status: "realtime",
    scheduledDepartureTime: "2026-09-06T10:00:00.000Z",
    ...overrides,
  });

const RUN_ENDS_AT = Date.parse("2026-09-06T10:05:00.000Z");

test("a board's embedded calls never become the run's reading; a requested sequence does", () => {
  const store = new RunReadingStore();
  store.rememberRow(stamp(departure("row", "a", { tripCalls: calls(1) }), 100), locator, 100);
  assert.equal(store.findSequence("row"), undefined);
  assert.equal(store.findRun("row")?.tripCalls, undefined);
  assert.equal(store.findRun("row")?.readAt?.sequenceReadAt, undefined);

  // A newer basic row owns the stop facts.
  store.rememberRow(stamp(departure("row", "a", { destination: "C" }), 200), locator, 200);
  assert.equal(store.findRow("row")?.departure.destination, "C");

  assert.equal(
    store.rememberSequence(store.findRunRecordKey("row"), sequence(calls(4), 300), 300),
    true,
  );
  assert.equal(store.findSequence("row")?.tripCalls[0]?.delayMinutes, 4);

  // A later board with its own calls leaves the requested reading in place.
  store.rememberRow(stamp(departure("row", "a", { tripCalls: calls(2) }), 400), locator, 400);
  assert.equal(store.findSequence("row")?.tripCalls[0]?.delayMinutes, 4);

  // The run's calls are held once by the record, not per row.
  assert.equal(store.findRow("row")?.departure.tripCalls, undefined);
  assert.equal(store.findRun("row")?.tripCalls?.[0]?.delayMinutes, 4);
});

test("an answer whose record is gone is reported as one, not swallowed", () => {
  const store = new RunReadingStore();
  store.rememberRow(stamp(departure("row", "a"), 100), locator, 100);
  const requestKey = store.findRunRecordKey("row");

  // A reading landing after the sweep removed its run must report failure, so the caller keeps
  // asking.
  const wellAfter = 100 + 5 * 60 * 60_000;
  store.rememberRow(
    stamp(departure("other", "b"), wellAfter),
    { ...locator, tripCode: "9" },
    wellAfter,
  );

  assert.equal(store.findRow("row"), undefined, "the run was retired meanwhile");
  assert.equal(store.rememberSequence(requestKey, sequence(calls(1), wellAfter), wellAfter), false);
});

test("shares one complete reading between stop rows of the same run", () => {
  const store = new RunReadingStore();
  const first = departure("row-a", "a");
  const second = departure("row-b", "b", { scheduledDepartureTime: "2026-09-06T10:05:00.000Z" });
  store.rememberRow(stamp(first, 100), locator, 100);
  store.rememberRow(stamp(second, 110), atStop("7000002", "1005"), 110);
  store.rememberSequence(store.findRunRecordKey("row-a"), sequence(calls(3), 200), 200);

  assert.equal(store.findRunRecordKey("row-a"), store.findRunRecordKey("row-b"));
  assert.equal(store.findSequence("row-b")?.readAt, 200);
});

test("refresh failures are shared by every row and cleared only by a newer sequence", () => {
  const store = new RunReadingStore();
  store.rememberRow(stamp(departure("row-a", "a"), 100), locator, 100);
  store.rememberRow(
    stamp(departure("row-b", "b", { scheduledDepartureTime: "2026-09-06T10:05:00.000Z" }), 110),
    atStop("7000002", "1005"),
    110,
  );
  const key = store.findRunRecordKey("row-a");
  store.rememberSequence(key, sequence(calls(3), 200), 200);
  store.markSequenceRefreshFailed(key, 300);
  for (const id of ["row-a", "row-b"]) {
    assert.equal(store.findRun(id)?.readAt?.sequenceRefreshFailedAt, 300);
    assert.equal(store.findRun(id)?.readAt?.sequenceReadAt, 200);
    assert.equal(store.findRun(id)?.tripCalls?.[0].delayMinutes, 3);
  }
  store.rememberRow(
    { ...departure("row-a", "a"), tripCalls: undefined, readAt: { rowReadAt: 350 } },
    locator,
    350,
  );
  assert.equal(store.findRun("row-a")?.readAt?.sequenceRefreshFailedAt, 300);
  store.rememberSequence(key, sequence(calls(0), 400), 400);
  assert.equal(store.findRun("row-a")?.readAt?.sequenceRefreshFailedAt, undefined);
  assert.equal(store.findRun("row-b")?.readAt?.sequenceRefreshFailedAt, undefined);
  store.markSequenceRefreshFailed(key, 450, 350);
  assert.equal(store.findRun("row-a")?.readAt?.sequenceRefreshFailedAt, undefined);
});

test("one run is one record from its first row, with no sequence needed to say so", () => {
  const store = new RunReadingStore();
  // Line-filtered rows carry no calls, so no dated id; only the locator names the run.
  const plain = (id: string, stopId: string, at: string) =>
    departure(id, stopId, { tripInstanceId: "provider-trip", scheduledDepartureTime: at });
  store.rememberRow(stamp(plain("row-a", "a", "2026-09-06T10:00:00.000Z"), 100), locator, 100);
  store.rememberRow(
    stamp(plain("row-b", "b", "2026-09-06T10:05:00.000Z"), 110),
    atStop("7000002", "1005"),
    110,
  );

  assert.equal(store.findRunRecordKey("row-a"), store.findRunRecordKey("row-b"));
});

test("a run crossing midnight is one record at the stops on either side of it", () => {
  const store = new RunReadingStore();
  // A run out at 23:50 states different days before and after midnight; the store reads no day, so
  // both stops are the same run.
  const before = departure("before", "o", { scheduledDepartureTime: "2026-09-06T23:50:00.000Z" });
  const runCalls: TripCall[] = [
    { stopName: "O", localStopId: "o", scheduledDepartureTime: "2026-09-06T23:50:00.000Z" },
    { stopName: "C", localStopId: "c", scheduledArrivalTime: "2026-09-07T00:30:00.000Z" },
  ];
  const after = departure("after", "c", { scheduledDepartureTime: "2026-09-07T00:30:00.000Z" });
  store.rememberRow(stamp(before, 100), locator, 100);
  store.rememberRow(stamp(after, 110), atStop("7000003", "0030"), 110);
  read(store, "before", runCalls, 120);

  assert.equal(store.findRunRecordKey("after"), store.findRunRecordKey("before"));
  // The stop after midnight gets only the sequence, never the other stop's facts.
  assert.deepEqual(store.findSequence("after")?.tripCalls, runCalls);
  assert.equal(store.findRun("after")?.id, "after");
  assert.equal(store.findRun("after")?.boardingLocalStopId, "c");
});

test("a run is retired before its trip code is issued again the next day", () => {
  const store = new RunReadingStore();
  const today = Date.parse("2026-09-06T09:55:00.000Z");
  store.rememberRow(stamp(departure("today", "a"), today), locator, today);
  read(store, "today", calls(0), today);
  assert.ok(store.findSequence("today"));

  // Tomorrow's run of the same trip shares `line|tripCode`; only the first record's retirement
  // keeps them apart.
  const tomorrow = Date.parse("2026-09-07T09:55:00.000Z");
  const next = departure("tomorrow", "a", {
    scheduledDepartureTime: "2026-09-07T10:00:00.000Z",
  });
  store.rememberRow(stamp(next, tomorrow), { ...locator, date: "20260907" }, tomorrow);

  assert.equal(store.findRow("today"), undefined, "yesterday's row is gone");
  assert.equal(store.findSequence("tomorrow"), undefined, "and cannot answer for today's run");
  assert.equal(store.findRun("tomorrow")?.tripCalls, undefined);
});

test("a run still being read is never retired, however far behind its last call is", () => {
  const store = new RunReadingStore();
  const wellAfterTheRun = RUN_ENDS_AT + 6 * 60 * 60_000;
  // A vehicle standing at its final stop is still on boards, so its record is kept.
  store.rememberRow(stamp(departure("row", "a"), wellAfterTheRun), locator, wellAfterTheRun);
  read(store, "row", calls(0), wellAfterTheRun);

  assert.ok(store.findRow("row"), "a reading is never evicted by the sweep its arrival triggered");
  assert.ok(store.findSequence("row"));
});

test("spends the cap on runs that are over before the vehicles still out", () => {
  const store = new RunReadingStore(2);
  const now = Date.parse("2026-09-06T10:01:00.000Z");
  const endingAt = (id: string, arrival: string, code: string) => {
    store.rememberRow(
      stamp(departure(id, "a", { tripId: id }), now),
      { ...locator, tripCode: code },
      now,
    );
    read(
      store,
      id,
      [
        { stopName: "A", localStopId: "a", scheduledDepartureTime: arrival },
        { stopName: "B", localStopId: "b", scheduledArrivalTime: arrival },
      ],
      now,
    );
  };

  // The finished run sits between running ones, so neither age nor order picks it.
  endingAt("running", "2026-09-06T11:00:00.000Z", "1");
  endingAt("finished", "2026-09-06T10:00:00.000Z", "2");
  endingAt("new", "2026-09-06T11:00:00.000Z", "3");

  assert.equal(store.findRow("finished"), undefined);
  assert.ok(store.findRow("running"));
  assert.ok(store.findRow("new"));
});

test("keeps the fuller sequence when two readings of one instant disagree in length", () => {
  const store = new RunReadingStore();
  const full = [...calls(1), { stopName: "C", localStopId: "c", delayMinutes: 1 }];
  store.rememberRow(stamp(departure("row", "a"), 100), locator, 100);
  read(store, "row", full, 100);
  // A reading of the same instant replaces another only where it says more.
  read(store, "row", calls(1), 100);

  assert.equal(store.findSequence("row")?.tripCalls.length, 3);
});

test("a sequence lands on the run it was asked for, whatever the boards did meanwhile", () => {
  const store = new RunReadingStore();
  store.rememberRow(stamp(departure("row-a", "a"), 100), locator, 100);
  const requestKey = store.findRunRecordKey("row-a");

  // Boards keep arriving during a request; records never move, so the answer lands on its key.
  store.rememberRow(stamp(departure("row-b", "b"), 110), atStop("7000002", "1005"), 110);
  store.rememberRow(stamp(departure("row-a", "a", { destination: "C" }), 120), locator, 120);

  store.rememberSequence(requestKey, sequence(calls(2), 300), 300);

  assert.equal(store.findSequence("row-a")?.readAt, 300);
  assert.equal(store.findSequence("row-b")?.readAt, 300);
});

test("a row that learns its locator moves onto the run it names", () => {
  const store = new RunReadingStore();
  store.rememberRow(stamp(departure("known", "a"), 100), locator, 100);
  read(store, "known", calls(1), 100);
  // From a board without a locator, so only its id addresses it.
  store.rememberRow(stamp(departure("late", "b"), 110), undefined, 110);
  assert.notEqual(store.findRunRecordKey("late"), store.findRunRecordKey("known"));

  store.rememberRow(stamp(departure("late", "b"), 120), atStop("7000002", "1005"), 120);

  assert.equal(store.findRunRecordKey("late"), store.findRunRecordKey("known"));
  assert.deepEqual(store.findSequence("late")?.tripCalls, calls(1));
  // It is on one record only.
  assert.equal(store.findRow("late")?.departure.readAt?.rowReadAt, 120);
});

test("answers every view with one reading, and the same object until something is read", () => {
  const store = new RunReadingStore();
  const row = departure("row", "a");
  store.rememberRow(stamp(row, 100), locator, 100);

  // A row with nothing read for it answers as itself.
  const bare = store.findRun("row");
  assert.equal(bare?.tripCalls, undefined);
  assert.equal(store.findRun("row"), bare, "an unchanged reading is not a new object");

  store.rememberSequence(store.findRunRecordKey("row"), sequence(calls(3), 200), 200);
  const completed = store.findRun("row");
  assert.notEqual(completed, bare, "a reading that landed is a new object");
  assert.equal(completed?.tripCalls?.[0]?.delayMinutes, 3);
  assert.deepEqual(completed?.readAt, { rowReadAt: 100, sequenceReadAt: 200 });
  assert.equal(store.findRun("row"), completed);
});

test("one record holds a bounded number of rows, oldest read first out", () => {
  const store = new RunReadingStore();
  // One run read at more stops than any run has: the per-record row cap bounds it.
  for (let index = 0; index < 80; index += 1) {
    const at = 100 + index;
    store.rememberRow(stamp(departure(`row-${index}`, "a"), at), atStop(`700${index}`, "1200"), at);
  }

  assert.equal(store.findRow("row-0"), undefined, "the least recently read row left");
  assert.ok(store.findRow("row-79"), "the freshest stayed");
  assert.equal(store.findRunRecordKey("row-0"), "row:row-0", "and is addressable by nothing else");
});

test("tells subscribers once for the batch a board arrives in", async () => {
  const store = new RunReadingStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(["one", "two", "three"], () => {
    notifications += 1;
  });

  const before = store.getVersion(["one", "two", "three"]);
  for (const id of ["one", "two", "three"]) {
    store.rememberRow(stamp(departure(id, "a", { tripId: id }), 100), locator, 100);
  }
  assert.notEqual(store.getVersion(["one", "two", "three"]), before);
  assert.equal(notifications, 0, "nothing is told mid-batch");

  await Promise.resolve();
  assert.equal(notifications, 1);

  unsubscribe();
  store.rememberRow(stamp(departure("four", "a", { tripId: "four" }), 100), locator, 100);
  await Promise.resolve();
  assert.equal(notifications, 1, "an unsubscribed view is not told");
});

test("notifies only subscribers whose runs changed", async () => {
  const store = new RunReadingStore();
  let firstNotifications = 0;
  let secondNotifications = 0;
  store.subscribe(["first"], () => {
    firstNotifications += 1;
  });
  store.subscribe(["second"], () => {
    secondNotifications += 1;
  });

  store.rememberRow(stamp(departure("first", "a"), 100), locator, 100);
  await Promise.resolve();

  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 0);
});

test("a sequence refresh makes its run most recent for capacity eviction", () => {
  const store = new RunReadingStore(2);
  store.rememberRow(stamp(departure("first", "a"), 100), locator, 100);
  store.rememberRow(stamp(departure("second", "b"), 110), { ...locator, tripCode: "second" }, 110);
  store.rememberSequence(store.findRunRecordKey("first"), sequence(calls(1), 120), 120);
  store.rememberRow(stamp(departure("third", "c"), 130), { ...locator, tripCode: "third" }, 130);

  assert.ok(store.findRow("first"), "the freshly requested run remains");
  assert.equal(store.findRow("second"), undefined, "the least recently written run leaves");
});

test("learns a farther run end from a reading that does not replace the current sequence", () => {
  const store = new RunReadingStore();
  const laterEnd = "2026-09-06T11:00:00.000Z";
  store.rememberRow(stamp(departure("row", "a"), 100), locator, 100);
  store.rememberSequence(store.findRunRecordKey("row"), sequence(calls(2), 200), 200);
  // An older reading loses the display contest but still extends the known lifetime.
  store.rememberSequence(
    store.findRunRecordKey("row"),
    sequence(
      [...calls(3), { stopName: "C", localStopId: "c", scheduledArrivalTime: laterEnd }],
      150,
    ),
    150,
  );

  store.rememberRow(
    stamp(departure("trigger", "a"), Date.parse(laterEnd) + 5 * 60_000),
    { ...locator, tripCode: "trigger" },
    Date.parse(laterEnd) + 5 * 60_000,
  );
  assert.ok(store.findRow("row"), "the farther known end prevents premature retirement");
});

test("a newer unconfirmed excerpt keeps known coverage and its original age", () => {
  const store = new RunReadingStore();
  const full = calls(1);
  store.rememberRow(stamp(departure("row", "a"), 100), locator, 100);
  read(store, "row", full, 100);
  read(store, "row", [{ ...full[0], delayMinutes: 4 }], 200);
  const reading = store.findSequence("row");
  assert.equal(reading?.tripCalls.length, full.length);
  assert.equal(reading?.tripCalls[0]?.delayMinutes, 4);
  assert.equal(reading?.readAt, 200);
  assert.equal(reading?.coverageReadAt, 100);
});

test("a foreign response and future row cannot alter the active instance", () => {
  const store = new RunReadingStore();
  store.rememberRow(stamp(departure("today", "a"), 100), locator, 100);
  read(store, "today", calls(0), 100);
  const future = departure("future", "a", { scheduledDepartureTime: "2026-09-07T10:00:00Z" });
  store.rememberRow(stamp(future, 200), { ...locator, date: "20260907" }, 200);
  assert.equal(store.canReadRun("future"), false);
  assert.equal(store.findRun("future")?.tripCalls, undefined);
  assert.equal(store.findRunRow(store.findRunRecordKey("today"))?.departure.id, "today");
  assert.equal(
    store.rememberSequence(
      store.findRunRecordKey("today"),
      sequence([{ ...calls(0)[0], scheduledDepartureTime: "2026-09-07T10:00:00Z" }], 300),
      300,
    ),
    false,
  );
  assert.equal(store.findSequence("today")?.readAt, 100);
});

test("today can take ownership when tomorrow's basic row was observed first", () => {
  const store = new RunReadingStore();
  const now = Date.parse("2026-09-06T10:00:00Z");
  store.rememberRow(
    departure("future", "a", { scheduledDepartureTime: "2026-09-07T10:00:00Z" }),
    { ...locator, date: "20260907" },
    now,
  );
  store.rememberRow(stamp(departure("today", "a"), now + 1), locator, now + 1);
  read(store, "today", calls(0), now + 1);
  assert.equal(store.canReadRun("today"), true);
  assert.equal(store.canReadRun("future"), false);
  assert.equal(store.findRun("today")?.tripCalls?.length, 2);
  assert.equal(store.findRun("future")?.tripCalls, undefined);
});

test("a confirmed shorter terminus replaces older coverage", () => {
  const store = new RunReadingStore();
  const full = calls(0);
  store.rememberRow(stamp(departure("row", "a"), 100), locator, 100);
  read(store, "row", full, 100);
  const final = {
    ...full[0],
    scheduledArrivalTime: full[0].scheduledDepartureTime,
    scheduledDepartureTime: undefined,
  };
  store.rememberSequence(store.findRunRecordKey("row"), sequence([final], 200), 200);
  assert.equal(store.findSequence("row")?.tripCalls.length, 1);
  assert.equal(store.findSequence("row")?.coverageReadAt, undefined);
});
