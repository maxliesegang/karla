import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getCallsAfterStop, mergeRunReading, mergeRunSequences } from "../src/lib/trip-calls.ts";

test("keeps every published call after the current stop", () => {
  const tripCalls: TripCall[] = [
    { stopName: "Ostendorfplatz", localStopId: "ostendorfplatz", isCurrentStop: true },
    { stopName: "Marktplatz (Kaiserstraße U)", localStopId: "marktplatz" },
    { stopName: "Marktplatz (Pyramide U)", localStopId: "marktplatz" },
    { stopName: "Europaplatz", localStopId: "europaplatz" },
  ];
  const departure = {
    boardingLocalStopId: "ostendorfplatz",
    tripCalls,
  } as Departure;

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
  const departure = {
    boardingLocalStopId: "hauptfriedhof",
    tripCalls,
  } as Departure;

  assert.deepEqual(getCallsAfterStop(departure, "hauptfriedhof"), tripCalls.slice(1));
});

const row = (id: string, stopName: string): Departure =>
  ({
    id,
    destination: "Hochstetten",
    tripCalls: [{ stopName, isCurrentStop: true }],
  }) as Departure;

test("completes each row with the trip read for it and keeps the row's own facts", () => {
  const rows = [row("a", "Europaplatz"), row("b", "Karlstor")];
  const readings = [
    {
      ...row("b", "Karlstor"),
      tripCalls: [
        { stopName: "Karlstor", isCurrentStop: true },
        { stopName: "Marktplatz (Kaiserstraße U)", scheduledDepartureTime: "2026-09-05T10:04:00" },
      ],
    },
  ] as Departure[];

  const merged = mergeRunSequences(rows, readings);

  // The row without a reading stands as its board stated it, in its place.
  assert.equal(merged[0], rows[0]);
  assert.equal(merged[1].tripCalls?.length, 2);
  // The stop row stays the departure fact; the trip contributes only the sequence behind it.
  assert.equal(merged[1].destination, "Hochstetten");
});

test("rows stand when no reading has arrived", () => {
  const rows = [row("a", "Europaplatz"), row("b", "Karlstor")];

  assert.equal(mergeRunSequences(rows, []), rows);
});

/**
 * A run looked for across the line's boards is found as a *row* far more often than as a sequence:
 * the boards along a line are read without calling sequences at all. So the reading offered to the
 * merge as the completion regularly carries none, and the row keeps the calls it already had — with
 * the clock of the reading that took them, not of the one that happened to be offered beside it.
 */
test("calls kept from the row are dated by the row that read them", () => {
  const row: Departure = {
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
  };
  // The same run on a line board, read two minutes later and carrying no sequence at all.
  const callLess: Departure = {
    ...row,
    id: "other",
    tripCalls: undefined,
    readAt: { rowReadAt: 1_120_000 },
  };

  const merged = mergeRunReading(row, callLess);

  assert.deepEqual(merged.tripCalls, row.tripCalls);
  assert.deepEqual(merged.readAt, { rowReadAt: 1_000_000, sequenceReadAt: 1_000_000 });
});

/** A row with no calls behind it states one clock, because only one reading was ever taken. */
test("a row carrying no sequence is dated on one clock, not on two", () => {
  const row: Departure = {
    id: "row",
    lineId: "1",
    transportMode: "tram",
    destination: "Durlach",
    minutesUntilDeparture: 2,
    boardingLocalStopId: "durlacher-tor",
    status: "realtime",
    scheduledDepartureTime: "2026-08-29T21:30:00Z",
    readAt: { rowReadAt: 1_000_000 },
  };
  const sequence: Departure = {
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
  };

  assert.deepEqual(mergeRunReading(row, undefined).readAt, { rowReadAt: 1_000_000 });
  // A sequence genuinely read later than the row still says so: that is the case the stamp is for.
  assert.deepEqual(mergeRunReading(row, sequence).readAt, {
    rowReadAt: 1_000_000,
    sequenceReadAt: 1_120_000,
  });
});
