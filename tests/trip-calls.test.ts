import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getCallsAfterStop } from "../src/lib/trip-calls.ts";

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
