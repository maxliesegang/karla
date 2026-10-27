import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, DatedJourneyCalls, Call } from "../src/data/transit-types.ts";
import { DatedJourneyReadingStore } from "../src/data/dated-journey-reading-store.ts";
import { createStopEvent } from "./support/fixtures.ts";

const calls = (delayMinutes: number): Call[] => [
  {
    stopName: "A",
    stopPlaceId: "a",
    timetabledDepartureTime: "2026-09-06T10:00:00.000Z",
    delayMinutes,
  },
  {
    stopName: "B",
    stopPlaceId: "b",
    timetabledArrivalTime: "2026-09-06T10:05:00.000Z",
    delayMinutes,
  },
];

/** Rows the source publishes are dated, so fixtures that rank readings are too. */
const stamp = (stopEvent: StopEvent, readAt: number): StopEvent =>
  createStopEvent({
    ...stopEvent,
    readAt: { rowReadAt: readAt, sequenceReadAt: readAt },
  });

/** A run read on its own: its calls and when. */
const sequence = (journeyCalls: readonly Call[], readAt: number): DatedJourneyCalls => ({
  calls: journeyCalls,
  status: "realtime",
  readAt,
});

/** The run this row is a stop of, requested and answered with these calls. */
const read = (
  store: DatedJourneyReadingStore,
  rowId: string,
  journeyCalls: readonly Call[],
  at: number,
) => store.rememberSequence(store.findJourneyRecordKey(rowId), sequence(journeyCalls, at), at);

/** A row of `provider-trip` on 2026-09-06, unless the overrides name another dated journey. */
const stopEvent = (id: string, stopId: string, overrides: Partial<StopEvent> = {}): StopEvent => {
  const journeyRef = "journeyRef" in overrides ? overrides.journeyRef : "provider-trip";
  const operatingDayRef = overrides.operatingDayRef ?? "2026-09-06";
  return createStopEvent({
    id,
    journeyRef,
    operatingDayRef,
    ...(journeyRef ? { datedJourneyId: `${journeyRef}@${operatingDayRef}` } : {}),
    lineId: "2",
    ptMode: "tram",
    destinationText: "B",
    minutesUntilDeparture: 1,
    bay: "1",
    boardingStopPlaceId: stopId,
    status: "realtime",
    timetabledDepartureTime: "2026-09-06T10:00:00.000Z",
    ...overrides,
  });
};

const DATED_JOURNEY_ENDS_AT = Date.parse("2026-09-06T10:05:00.000Z");

test("a board's embedded calls never become the run's reading; a requested sequence does", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("row", "a", { calls: calls(1) }), 100), 100);
  assert.equal(store.findSequence("row"), undefined);
  assert.equal(store.findDatedJourney("row")?.calls, undefined);
  assert.equal(store.findDatedJourney("row")?.readAt?.sequenceReadAt, undefined);

  // A newer basic row owns the stop facts.
  store.rememberRow(stamp(stopEvent("row", "a", { destinationText: "C" }), 200), 200);
  assert.equal(store.findRow("row")?.stopEvent.destinationText, "C");

  assert.equal(
    store.rememberSequence(store.findJourneyRecordKey("row"), sequence(calls(4), 300), 300),
    true,
  );
  assert.equal(store.findSequence("row")?.calls[0]?.delayMinutes, 4);

  // A later board with its own calls leaves the requested reading in place.
  store.rememberRow(stamp(stopEvent("row", "a", { calls: calls(2) }), 400), 400);
  assert.equal(store.findSequence("row")?.calls[0]?.delayMinutes, 4);

  // The run's calls are held once by the record, not per row.
  assert.equal(store.findRow("row")?.stopEvent.calls, undefined);
  assert.equal(store.findDatedJourney("row")?.calls?.[0]?.delayMinutes, 4);
});

test("an answer whose record is gone is reported as one, not swallowed", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("row", "a"), 100), 100);
  const requestKey = store.findJourneyRecordKey("row");

  // A reading landing after the sweep removed its run must report failure, so the caller keeps
  // asking.
  const wellAfter = 100 + 5 * 60 * 60_000;
  store.rememberRow(stamp(stopEvent("other", "b", { journeyRef: "9" }), wellAfter), wellAfter);

  assert.equal(store.findRow("row"), undefined, "the run was retired meanwhile");
  assert.equal(store.rememberSequence(requestKey, sequence(calls(1), wellAfter), wellAfter), false);
});

test("shares one complete reading between stop rows of the same run", () => {
  const store = new DatedJourneyReadingStore();
  const first = stopEvent("row-a", "a");
  const second = stopEvent("row-b", "b", { timetabledDepartureTime: "2026-09-06T10:05:00.000Z" });
  store.rememberRow(stamp(first, 100), 100);
  store.rememberRow(stamp(second, 110), 110);
  store.rememberSequence(store.findJourneyRecordKey("row-a"), sequence(calls(3), 200), 200);

  assert.equal(store.findJourneyRecordKey("row-a"), store.findJourneyRecordKey("row-b"));
  assert.equal(store.findSequence("row-b")?.readAt, 200);
});

test("a failed first read is marked until a sequence lands", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("row-a", "a"), 100), 100);
  const key = store.findJourneyRecordKey("row-a");
  assert.equal(store.findDatedJourney("row-a")?.readAt?.sequenceRefreshFailedAt, undefined);

  store.markSequenceRefreshFailed(key, 300);
  assert.equal(store.findDatedJourney("row-a")?.readAt?.sequenceRefreshFailedAt, 300);
  assert.equal(store.findDatedJourney("row-a")?.calls, undefined);

  store.rememberSequence(key, sequence(calls(0), 400), 400);
  assert.equal(store.findDatedJourney("row-a")?.readAt?.sequenceRefreshFailedAt, undefined);
});

test("refresh failures are shared by every row and cleared only by a newer sequence", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("row-a", "a"), 100), 100);
  store.rememberRow(
    stamp(stopEvent("row-b", "b", { timetabledDepartureTime: "2026-09-06T10:05:00.000Z" }), 110),
    110,
  );
  const key = store.findJourneyRecordKey("row-a");
  store.rememberSequence(key, sequence(calls(3), 200), 200);
  store.markSequenceRefreshFailed(key, 300);
  for (const id of ["row-a", "row-b"]) {
    assert.equal(store.findDatedJourney(id)?.readAt?.sequenceRefreshFailedAt, 300);
    assert.equal(store.findDatedJourney(id)?.readAt?.sequenceReadAt, 200);
    assert.equal(store.findDatedJourney(id)?.calls?.[0].delayMinutes, 3);
  }
  store.rememberRow(
    { ...stopEvent("row-a", "a"), calls: undefined, readAt: { rowReadAt: 350 } },
    350,
  );
  assert.equal(store.findDatedJourney("row-a")?.readAt?.sequenceRefreshFailedAt, 300);
  store.rememberSequence(key, sequence(calls(0), 400), 400);
  assert.equal(store.findDatedJourney("row-a")?.readAt?.sequenceRefreshFailedAt, undefined);
  assert.equal(store.findDatedJourney("row-b")?.readAt?.sequenceRefreshFailedAt, undefined);
  store.markSequenceRefreshFailed(key, 450, 350);
  assert.equal(store.findDatedJourney("row-a")?.readAt?.sequenceRefreshFailedAt, undefined);
});

test("one run is one record from its first row, with no sequence needed to say so", () => {
  const store = new DatedJourneyReadingStore();
  // Line-filtered rows carry no calls; the journey alone names the dated journey.
  const plain = (id: string, stopId: string, at: string) =>
    stopEvent(id, stopId, { datedJourneyId: "provider-trip", timetabledDepartureTime: at });
  store.rememberRow(stamp(plain("row-a", "a", "2026-09-06T10:00:00.000Z"), 100), 100);
  store.rememberRow(stamp(plain("row-b", "b", "2026-09-06T10:05:00.000Z"), 110), 110);

  assert.equal(store.findJourneyRecordKey("row-a"), store.findJourneyRecordKey("row-b"));
});

test("a run crossing midnight is one record at the stops on either side of it", () => {
  const store = new DatedJourneyReadingStore();
  // Both stops state the run's operating day, not the calendar day.
  const before = stopEvent("before", "o", { timetabledDepartureTime: "2026-09-06T23:50:00.000Z" });
  const datedJourneyCalls: Call[] = [
    { stopName: "O", stopPlaceId: "o", timetabledDepartureTime: "2026-09-06T23:50:00.000Z" },
    { stopName: "C", stopPlaceId: "c", timetabledArrivalTime: "2026-09-07T00:30:00.000Z" },
  ];
  const after = stopEvent("after", "c", { timetabledDepartureTime: "2026-09-07T00:30:00.000Z" });
  store.rememberRow(stamp(before, 100), 100);
  store.rememberRow(stamp(after, 110), 110);
  read(store, "before", datedJourneyCalls, 120);

  assert.equal(store.findJourneyRecordKey("after"), store.findJourneyRecordKey("before"));
  // The stop after midnight gets only the sequence, never the other stop's facts.
  assert.deepEqual(store.findSequence("after")?.calls, datedJourneyCalls);
  assert.equal(store.findDatedJourney("after")?.id, "after");
  assert.equal(store.findDatedJourney("after")?.boardingStopPlaceId, "c");
});

test("the same journey on the next operating day is a record of its own", () => {
  const store = new DatedJourneyReadingStore();
  const now = Date.parse("2026-09-06T09:55:00.000Z");
  store.rememberRow(stamp(stopEvent("today", "a"), now), now);
  read(store, "today", calls(0), now);
  // Tomorrow's row is already on a board while today's run is still out.
  const next = stopEvent("tomorrow", "a", {
    operatingDayRef: "2026-09-07",
    timetabledDepartureTime: "2026-09-07T10:00:00.000Z",
  });
  store.rememberRow(stamp(next, now + 1), now + 1);

  assert.notEqual(store.findJourneyRecordKey("tomorrow"), store.findJourneyRecordKey("today"));
  assert.equal(store.findSequence("tomorrow"), undefined);
  assert.equal(store.findDatedJourney("tomorrow")?.calls, undefined);
  assert.equal(store.findSequence("today")?.readAt, now);
  assert.equal(
    store.findDatedJourneyRow(store.findJourneyRecordKey("today"))?.stopEvent.id,
    "today",
  );
});

test("a run still being read is never retired, however far behind its last call is", () => {
  const store = new DatedJourneyReadingStore();
  const wellAfterTheDatedJourney = DATED_JOURNEY_ENDS_AT + 6 * 60 * 60_000;
  // A vehicle standing at its final stop is still on boards, so its record is kept.
  store.rememberRow(
    stamp(stopEvent("row", "a"), wellAfterTheDatedJourney),
    wellAfterTheDatedJourney,
  );
  read(store, "row", calls(0), wellAfterTheDatedJourney);

  assert.ok(store.findRow("row"), "a reading is never evicted by the sweep its arrival triggered");
  assert.ok(store.findSequence("row"));
});

test("spends the cap on runs that are over before the vehicles still out", () => {
  const store = new DatedJourneyReadingStore(2);
  const now = Date.parse("2026-09-06T10:01:00.000Z");
  const endingAt = (id: string, arrival: string, code: string) => {
    store.rememberRow(stamp(stopEvent(id, "a", { journeyRef: code }), now), now);
    read(
      store,
      id,
      [
        { stopName: "A", stopPlaceId: "a", timetabledDepartureTime: arrival },
        { stopName: "B", stopPlaceId: "b", timetabledArrivalTime: arrival },
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
  const store = new DatedJourneyReadingStore();
  const full = [...calls(1), { stopName: "C", stopPlaceId: "c", delayMinutes: 1 }];
  store.rememberRow(stamp(stopEvent("row", "a"), 100), 100);
  read(store, "row", full, 100);
  // A reading of the same instant replaces another only where it says more.
  read(store, "row", calls(1), 100);

  assert.equal(store.findSequence("row")?.calls.length, 3);
});

test("a sequence lands on the run it was asked for, whatever the boards did meanwhile", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("row-a", "a"), 100), 100);
  const requestKey = store.findJourneyRecordKey("row-a");

  // Boards keep arriving during a request; records never move, so the answer lands on its key.
  store.rememberRow(stamp(stopEvent("row-b", "b"), 110), 110);
  store.rememberRow(stamp(stopEvent("row-a", "a", { destinationText: "C" }), 120), 120);

  store.rememberSequence(requestKey, sequence(calls(2), 300), 300);

  assert.equal(store.findSequence("row-a")?.readAt, 300);
  assert.equal(store.findSequence("row-b")?.readAt, 300);
});

test("a row that learns its journey moves onto the dated journey it names", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("known", "a"), 100), 100);
  read(store, "known", calls(1), 100);
  // From a row without a journey, so only its id addresses it.
  store.rememberRow(stamp(stopEvent("late", "b", { journeyRef: undefined }), 110), 110);
  assert.notEqual(store.findJourneyRecordKey("late"), store.findJourneyRecordKey("known"));

  store.rememberRow(stamp(stopEvent("late", "b"), 120), 120);

  assert.equal(store.findJourneyRecordKey("late"), store.findJourneyRecordKey("known"));
  assert.deepEqual(store.findSequence("late")?.calls, calls(1));
  // It is on one record only.
  assert.equal(store.findRow("late")?.stopEvent.readAt?.rowReadAt, 120);
});

test("answers every view with one reading, and the same object until something is read", () => {
  const store = new DatedJourneyReadingStore();
  const row = stopEvent("row", "a");
  store.rememberRow(stamp(row, 100), 100);

  // A row with nothing read for it answers as itself.
  const bare = store.findDatedJourney("row");
  assert.equal(bare?.calls, undefined);
  assert.equal(store.findDatedJourney("row"), bare, "an unchanged reading is not a new object");

  store.rememberSequence(store.findJourneyRecordKey("row"), sequence(calls(3), 200), 200);
  const completed = store.findDatedJourney("row");
  assert.notEqual(completed, bare, "a reading that landed is a new object");
  assert.equal(completed?.calls?.[0]?.delayMinutes, 3);
  assert.deepEqual(completed?.readAt, { rowReadAt: 100, sequenceReadAt: 200 });
  assert.equal(store.findDatedJourney("row"), completed);
});

test("one record holds a bounded number of rows, oldest read first out", () => {
  const store = new DatedJourneyReadingStore();
  // One run read at more stops than any run has: the per-record row cap bounds it.
  for (let index = 0; index < 80; index += 1) {
    const at = 100 + index;
    store.rememberRow(stamp(stopEvent(`row-${index}`, "a"), at), at);
  }

  assert.equal(store.findRow("row-0"), undefined, "the least recently read row left");
  assert.ok(store.findRow("row-79"), "the freshest stayed");
  assert.equal(
    store.findJourneyRecordKey("row-0"),
    "row:row-0",
    "and is addressable by nothing else",
  );
});

test("tells subscribers once for the batch a board arrives in", async () => {
  const store = new DatedJourneyReadingStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(["one", "two", "three"], () => {
    notifications += 1;
  });

  const before = store.getVersion(["one", "two", "three"]);
  for (const id of ["one", "two", "three"]) {
    store.rememberRow(stamp(stopEvent(id, "a", { journeyRef: id }), 100), 100);
  }
  assert.notEqual(store.getVersion(["one", "two", "three"]), before);
  assert.equal(notifications, 0, "nothing is told mid-batch");

  await Promise.resolve();
  assert.equal(notifications, 1);

  unsubscribe();
  store.rememberRow(stamp(stopEvent("four", "a", { journeyRef: "four" }), 100), 100);
  await Promise.resolve();
  assert.equal(notifications, 1, "an unsubscribed view is not told");
});

test("notifies only subscribers whose runs changed", async () => {
  const store = new DatedJourneyReadingStore();
  let firstNotifications = 0;
  let secondNotifications = 0;
  store.subscribe(["first"], () => {
    firstNotifications += 1;
  });
  store.subscribe(["second"], () => {
    secondNotifications += 1;
  });

  store.rememberRow(stamp(stopEvent("first", "a"), 100), 100);
  await Promise.resolve();

  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 0);
});

test("a sequence refresh makes its run most recent for capacity eviction", () => {
  const store = new DatedJourneyReadingStore(2);
  store.rememberRow(stamp(stopEvent("first", "a"), 100), 100);
  store.rememberRow(stamp(stopEvent("second", "b", { journeyRef: "second" }), 110), 110);
  store.rememberSequence(store.findJourneyRecordKey("first"), sequence(calls(1), 120), 120);
  store.rememberRow(stamp(stopEvent("third", "c", { journeyRef: "third" }), 130), 130);

  assert.ok(store.findRow("first"), "the freshly requested run remains");
  assert.equal(store.findRow("second"), undefined, "the least recently written run leaves");
});

test("learns a farther run end from a reading that does not replace the current sequence", () => {
  const store = new DatedJourneyReadingStore();
  const laterEnd = "2026-09-06T11:00:00.000Z";
  store.rememberRow(stamp(stopEvent("row", "a"), 100), 100);
  store.rememberSequence(store.findJourneyRecordKey("row"), sequence(calls(2), 200), 200);
  // An older reading loses the display contest but still extends the known lifetime.
  store.rememberSequence(
    store.findJourneyRecordKey("row"),
    sequence(
      [...calls(3), { stopName: "C", stopPlaceId: "c", timetabledArrivalTime: laterEnd }],
      150,
    ),
    150,
  );

  store.rememberRow(
    stamp(stopEvent("trigger", "a", { journeyRef: "trigger" }), Date.parse(laterEnd) + 5 * 60_000),
    Date.parse(laterEnd) + 5 * 60_000,
  );
  assert.ok(store.findRow("row"), "the farther known end prevents premature retirement");
});

test("a newer unconfirmed excerpt keeps known coverage and its original age", () => {
  const store = new DatedJourneyReadingStore();
  const full = calls(1);
  store.rememberRow(stamp(stopEvent("row", "a"), 100), 100);
  read(store, "row", full, 100);
  read(store, "row", [{ ...full[0], delayMinutes: 4 }], 200);
  const reading = store.findSequence("row");
  assert.equal(reading?.calls.length, full.length);
  assert.equal(reading?.calls[0]?.delayMinutes, 4);
  assert.equal(reading?.readAt, 200);
  assert.equal(reading?.coverageReadAt, 100);
});

test("a row without its operating day shares no record, even with a journey of its code", () => {
  const store = new DatedJourneyReadingStore();
  store.rememberRow(stamp(stopEvent("dated", "a"), 100), 100);
  read(store, "dated", calls(0), 100);
  const undated = stopEvent("undated", "b", { operatingDayRef: undefined });
  store.rememberRow(stamp(undated, 110), 110);

  assert.notEqual(store.findJourneyRecordKey("undated"), store.findJourneyRecordKey("dated"));
  assert.equal(store.findSequence("undated"), undefined);
});

test("a confirmed shorter terminus replaces older coverage", () => {
  const store = new DatedJourneyReadingStore();
  const full = calls(0);
  store.rememberRow(stamp(stopEvent("row", "a"), 100), 100);
  read(store, "row", full, 100);
  const final = {
    ...full[0],
    timetabledArrivalTime: full[0].timetabledDepartureTime,
    timetabledDepartureTime: undefined,
  };
  store.rememberSequence(store.findJourneyRecordKey("row"), sequence([final], 200), 200);
  assert.equal(store.findSequence("row")?.calls.length, 1);
  assert.equal(store.findSequence("row")?.coverageReadAt, undefined);
});
