import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getCallsAfterStop, mergeTripSequences } from "../src/lib/trip-calls.ts";

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

  const merged = mergeTripSequences(rows, readings);

  // The row without a reading stands as its board stated it, in its place.
  assert.equal(merged[0], rows[0]);
  assert.equal(merged[1].tripCalls?.length, 2);
  // The stop row stays the departure fact; the trip contributes only the sequence behind it.
  assert.equal(merged[1].destination, "Hochstetten");
});

test("rows stand when no reading has arrived", () => {
  const rows = [row("a", "Europaplatz"), row("b", "Karlstor")];

  assert.equal(mergeTripSequences(rows, []), rows);
});
