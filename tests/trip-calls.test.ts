import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getViaSummary } from "../src/lib/departure-presentation.ts";
import { findHomePlaceName } from "../src/lib/stop-naming.ts";
import { getCallsAfterStop, mergeAddressedRun, mergeRunReading } from "../src/lib/trip-calls.ts";
import { createDeparture } from "./support/fixtures.ts";

test("keeps every published call after the current stop", () => {
  const tripCalls: TripCall[] = [
    { stopName: "Ostendorfplatz", localStopId: "ostendorfplatz", isCurrentStop: true },
    { stopName: "Marktplatz (Kaiserstraße U)", localStopId: "marktplatz" },
    { stopName: "Marktplatz (Pyramide U)", localStopId: "marktplatz" },
    { stopName: "Europaplatz", localStopId: "europaplatz" },
  ];
  const departure = createDeparture({
    boardingLocalStopId: "ostendorfplatz",
    tripCalls,
  });

  assert.deepEqual(
    getCallsAfterStop(departure, "ostendorfplatz").map(({ stopName }) => stopName),
    ["Marktplatz (Kaiserstraße U)", "Marktplatz (Pyramide U)", "Europaplatz"],
  );
});

test("keeps a second published call at the current physical stop", () => {
  const tripCalls: TripCall[] = [
    { stopName: "Hauptfriedhof", localStopId: "hauptfriedhof", isCurrentStop: true },
    { stopName: "Hauptfriedhof", localStopId: "hauptfriedhof", platformCode: "2" },
    { stopName: "Karl-Wilhelm-Platz", localStopId: "karl-wilhelm-platz" },
  ];
  const departure = createDeparture({
    boardingLocalStopId: "hauptfriedhof",
    tripCalls,
  });

  assert.deepEqual(getCallsAfterStop(departure, "hauptfriedhof"), tripCalls.slice(1));
});

test("reads past the row's own stop where the run was read at another stop", () => {
  // A run is merged into every stop's row, so a Tivoli row can carry Poststraße's current-stop
  // marker.
  const tripCalls: TripCall[] = [
    { stopName: "Werderstraße", localStopId: "werderstrasse" },
    { stopName: "Tivoli", localStopId: "tivoli" },
    { stopName: "Poststraße", localStopId: "poststrasse", isCurrentStop: true },
    { stopName: "Hauptbahnhof (Vorplatz)", localStopId: "hauptbahnhof" },
  ];
  const departure = createDeparture({ boardingLocalStopId: "tivoli", tripCalls });

  assert.deepEqual(
    getCallsAfterStop(departure, "tivoli").map(({ localStopId }) => localStopId),
    ["poststrasse", "hauptbahnhof"],
  );
});

test("states the via stops past the row's own stop, not past another stop's marker", () => {
  const departure = createDeparture({
    boardingLocalStopId: "tivoli",
    destination: "Daxlanden",
    tripCalls: [
      { stopName: "Tivoli", localStopId: "tivoli" },
      { stopName: "Poststraße", localStopId: "poststrasse", isCurrentStop: true },
      { stopName: "Hauptbahnhof (Vorplatz)", localStopId: "hauptbahnhof" },
      { stopName: "Waidweg", localStopId: "waidweg" },
    ],
  });

  assert.equal(getViaSummary(departure), "Poststraße · Hauptbahnhof (Vorplatz)");
});

test("reads the diagram's home place at the rider's stop, not at another stop's marker", () => {
  // Forststraße's board read this run last; the rider is at Tivoli.
  const tripCalls: TripCall[] = [
    {
      stopName: "Forststraße",
      localStopId: "forststrasse",
      placeName: "Rintheim",
      isCurrentStop: true,
    },
    { stopName: "Hauptfriedhof", localStopId: "hauptfriedhof", placeName: "Karlsruhe" },
    { stopName: "Tivoli", localStopId: "tivoli", placeName: "Karlsruhe" },
    { stopName: "Poststraße", localStopId: "poststrasse", placeName: "Karlsruhe" },
  ];

  assert.equal(findHomePlaceName(tripCalls, "tivoli"), "Karlsruhe");
  assert.equal(findHomePlaceName(tripCalls), "Karlsruhe");
});

const row = (id: string, stopName: string): Departure =>
  createDeparture({
    id,
    destination: "Hochstetten",
    tripCalls: [{ stopName, isCurrentStop: true }],
  }) as Departure;

test("completes a row with the run read for it and keeps the row's own facts", () => {
  const reading = {
    ...row("b", "Karlstor"),
    tripCalls: [
      { stopName: "Karlstor", isCurrentStop: true },
      { stopName: "Marktplatz (Kaiserstraße U)", scheduledDepartureTime: "2026-09-05T10:04:00" },
    ],
  } as Departure;

  const merged = mergeRunReading(row("b", "Karlstor"), reading);

  assert.equal(merged.tripCalls?.length, 2);
  // The stop row stays the departure; the run adds only its sequence.
  assert.equal(merged.destination, "Hochstetten");
});

test("a row stands when no reading has arrived", () => {
  const stopRow = row("a", "Europaplatz");

  assert.equal(mergeRunReading(stopRow, undefined), stopRow);
});

test("an addressed run takes its calls only from its own reading, never a board's", () => {
  const boardCalls: TripCall[] = [
    { stopName: "Karlstor", isCurrentStop: true, delayMinutes: 2 },
    { stopName: "Europaplatz", scheduledDepartureTime: "2026-09-05T10:04:00", delayMinutes: 2 },
  ];
  const stopRow = createDeparture({
    ...row("b", "Karlstor"),
    tripCalls: boardCalls,
    readAt: { rowReadAt: 100, sequenceReadAt: 100 },
  });
  const observed = createDeparture({ ...stopRow, readAt: { rowReadAt: 90, sequenceReadAt: 90 } });

  const unread = mergeAddressedRun(stopRow, observed, undefined);
  assert.equal(unread?.tripCalls, undefined);
  assert.equal(unread?.readAt?.sequenceReadAt, undefined);
  assert.equal(mergeAddressedRun(undefined, observed, undefined)?.tripCalls, undefined);

  const reading = createDeparture({
    ...row("b", "Karlstor"),
    tripCalls: boardCalls.map((call) => ({ ...call, delayMinutes: 0 })),
    readAt: { rowReadAt: 200, sequenceReadAt: 200 },
  });
  const read = mergeAddressedRun(stopRow, observed, reading);
  assert.equal(read?.tripCalls?.[1]?.delayMinutes, 0);
  assert.equal(read?.readAt?.sequenceReadAt, 200);
  assert.equal(read?.destination, "Hochstetten");
});

/**
 * Calls kept from the row keep the row's read time, not the time of a call-less reading offered
 * beside it.
 */
test("calls kept from the row are dated by the row that read them", () => {
  const row: Departure = createDeparture({
    id: "row",
    lineId: "1",
    transportMode: "tram",
    destination: "Durlach",
    minutesUntilDeparture: 2,
    boardingLocalStopId: "durlacher-tor",
    status: "realtime",
    scheduledDepartureTime: "2026-08-29T21:30:00Z",
    tripCalls: [
      {
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        localStopId: "durlacher-tor",
        scheduledDepartureTime: "2026-08-29T21:30:00Z",
      },
    ],
    readAt: { rowReadAt: 1_000_000, sequenceReadAt: 1_000_000 },
  });
  // The same run on a line board, two minutes later, without a sequence.
  const callLess: Departure = createDeparture({
    ...row,
    id: "other",
    tripCalls: undefined,
    readAt: { rowReadAt: 1_120_000 },
  });

  const merged = mergeRunReading(row, callLess);

  assert.deepEqual(merged.tripCalls, row.tripCalls);
  assert.deepEqual(merged.readAt, { rowReadAt: 1_000_000, sequenceReadAt: 1_000_000 });
});

/** A row with no calls has one clock. */
test("a row carrying no sequence is dated on one clock, not on two", () => {
  const row: Departure = createDeparture({
    id: "row",
    lineId: "1",
    transportMode: "tram",
    destination: "Durlach",
    minutesUntilDeparture: 2,
    boardingLocalStopId: "durlacher-tor",
    status: "realtime",
    scheduledDepartureTime: "2026-08-29T21:30:00Z",
    readAt: { rowReadAt: 1_000_000 },
  });
  const sequence: Departure = createDeparture({
    ...row,
    id: "sequence",
    tripCalls: [
      {
        stopName: "Kronenplatz (U)",
        localStopId: "kronenplatz",
        scheduledDepartureTime: "2026-08-29T21:32:00Z",
      },
    ],
    readAt: { rowReadAt: 1_000_000, sequenceReadAt: 1_120_000 },
  });

  assert.deepEqual(mergeRunReading(row, undefined).readAt, { rowReadAt: 1_000_000 });
  // A sequence read later than the row says so.
  assert.deepEqual(mergeRunReading(row, sequence).readAt, {
    rowReadAt: 1_000_000,
    sequenceReadAt: 1_120_000,
  });
});
