import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import { getViaSummary } from "../src/lib/stop-event-presentation.ts";
import { findHomePlaceName } from "../src/lib/stop-naming.ts";
import {
  getCallsAfterStop,
  mergeAddressedDatedJourney,
  mergeDatedJourneyReading,
} from "../src/lib/calls.ts";
import { createStopEvent } from "./support/fixtures.ts";

test("keeps every published call after the current stop", () => {
  const calls: Call[] = [
    { stopName: "Ostendorfplatz", stopPlaceId: "ostendorfplatz", isThisCall: true },
    { stopName: "Marktplatz (Kaiserstraße U)", stopPlaceId: "marktplatz" },
    { stopName: "Marktplatz (Pyramide U)", stopPlaceId: "marktplatz" },
    { stopName: "Europaplatz", stopPlaceId: "europaplatz" },
  ];
  const stopEvent = createStopEvent({
    boardingStopPlaceId: "ostendorfplatz",
    calls,
  });

  assert.deepEqual(
    getCallsAfterStop(stopEvent, "ostendorfplatz").map(({ stopName }) => stopName),
    ["Marktplatz (Kaiserstraße U)", "Marktplatz (Pyramide U)", "Europaplatz"],
  );
});

test("keeps a second published call at the current physical stop", () => {
  const calls: Call[] = [
    { stopName: "Hauptfriedhof", stopPlaceId: "hauptfriedhof", isThisCall: true },
    { stopName: "Hauptfriedhof", stopPlaceId: "hauptfriedhof", bay: "2" },
    { stopName: "Karl-Wilhelm-Platz", stopPlaceId: "karl-wilhelm-platz" },
  ];
  const stopEvent = createStopEvent({
    boardingStopPlaceId: "hauptfriedhof",
    calls,
  });

  assert.deepEqual(getCallsAfterStop(stopEvent, "hauptfriedhof"), calls.slice(1));
});

test("reads past the row's own stop where the journey was read at another stop", () => {
  // A journey is merged into every stop's row, so a Tivoli row can carry Poststraße's current-stop
  // marker.
  const calls: Call[] = [
    { stopName: "Werderstraße", stopPlaceId: "werderstrasse" },
    { stopName: "Tivoli", stopPlaceId: "tivoli" },
    { stopName: "Poststraße", stopPlaceId: "poststrasse", isThisCall: true },
    { stopName: "Hauptbahnhof (Vorplatz)", stopPlaceId: "hauptbahnhof" },
  ];
  const stopEvent = createStopEvent({ boardingStopPlaceId: "tivoli", calls });

  assert.deepEqual(
    getCallsAfterStop(stopEvent, "tivoli").map(({ stopPlaceId }) => stopPlaceId),
    ["poststrasse", "hauptbahnhof"],
  );
});

test("states the via stops past the row's own stop, not past another stop's marker", () => {
  const stopEvent = createStopEvent({
    boardingStopPlaceId: "tivoli",
    destinationText: "Daxlanden",
    calls: [
      { stopName: "Tivoli", stopPlaceId: "tivoli" },
      { stopName: "Poststraße", stopPlaceId: "poststrasse", isThisCall: true },
      { stopName: "Hauptbahnhof (Vorplatz)", stopPlaceId: "hauptbahnhof" },
      { stopName: "Waidweg", stopPlaceId: "waidweg" },
    ],
  });

  assert.equal(getViaSummary(stopEvent), "Poststraße · Hauptbahnhof (Vorplatz)");
});

test("reads the diagram's home place at the rider's stop, not at another stop's marker", () => {
  // Forststraße's board read this journey last; the rider is at Tivoli.
  const calls: Call[] = [
    {
      stopName: "Forststraße",
      stopPlaceId: "forststrasse",
      placeName: "Rintheim",
      isThisCall: true,
    },
    { stopName: "Hauptfriedhof", stopPlaceId: "hauptfriedhof", placeName: "Karlsruhe" },
    { stopName: "Tivoli", stopPlaceId: "tivoli", placeName: "Karlsruhe" },
    { stopName: "Poststraße", stopPlaceId: "poststrasse", placeName: "Karlsruhe" },
  ];

  assert.equal(findHomePlaceName(calls, "tivoli"), "Karlsruhe");
  assert.equal(findHomePlaceName(calls), "Karlsruhe");
});

const row = (id: string, stopName: string): StopEvent =>
  createStopEvent({
    id,
    destinationText: "Hochstetten",
    calls: [{ stopName, isThisCall: true }],
  }) as StopEvent;

test("completes a row with the journey read for it and keeps the row's own facts", () => {
  const reading = {
    ...row("b", "Karlstor"),
    calls: [
      { stopName: "Karlstor", isThisCall: true },
      { stopName: "Marktplatz (Kaiserstraße U)", timetabledDepartureTime: "2026-09-05T10:04:00" },
    ],
  } as StopEvent;

  const merged = mergeDatedJourneyReading(row("b", "Karlstor"), reading);

  assert.equal(merged.calls?.length, 2);
  // The stop row stays the departure; the journey adds only its sequence.
  assert.equal(merged.destinationText, "Hochstetten");
});

test("a row stands when no reading has arrived", () => {
  const stopRow = row("a", "Europaplatz");

  assert.equal(mergeDatedJourneyReading(stopRow, undefined), stopRow);
});

test("an addressed journey takes its calls only from its own reading, never a board's", () => {
  const boardCalls: Call[] = [
    { stopName: "Karlstor", isThisCall: true, delayMinutes: 2 },
    { stopName: "Europaplatz", timetabledDepartureTime: "2026-09-05T10:04:00", delayMinutes: 2 },
  ];
  const stopRow = createStopEvent({
    ...row("b", "Karlstor"),
    calls: boardCalls,
    readAt: { rowReadAt: 100, sequenceReadAt: 100 },
  });
  const observed = createStopEvent({ ...stopRow, readAt: { rowReadAt: 90, sequenceReadAt: 90 } });

  const unread = mergeAddressedDatedJourney(stopRow, observed, undefined);
  assert.equal(unread?.calls, undefined);
  assert.equal(unread?.readAt?.sequenceReadAt, undefined);
  assert.equal(mergeAddressedDatedJourney(undefined, observed, undefined)?.calls, undefined);

  const reading = createStopEvent({
    ...row("b", "Karlstor"),
    calls: boardCalls.map((call) => ({ ...call, delayMinutes: 0 })),
    readAt: { rowReadAt: 200, sequenceReadAt: 200 },
  });
  const read = mergeAddressedDatedJourney(stopRow, observed, reading);
  assert.equal(read?.calls?.[1]?.delayMinutes, 0);
  assert.equal(read?.readAt?.sequenceReadAt, 200);
  assert.equal(read?.destinationText, "Hochstetten");
});

/**
 * Calls kept from the row keep the row's read time, not the time of a call-less reading offered
 * beside it.
 */
test("calls kept from the row are dated by the row that read them", () => {
  const row: StopEvent = createStopEvent({
    id: "row",
    lineId: "1",
    ptMode: "tram",
    destinationText: "Durlach",
    minutesUntilDeparture: 2,
    boardingStopPlaceId: "durlacher-tor",
    status: "realtime",
    timetabledDepartureTime: "2026-08-29T21:30:00Z",
    calls: [
      {
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        stopPlaceId: "durlacher-tor",
        timetabledDepartureTime: "2026-08-29T21:30:00Z",
      },
    ],
    readAt: { rowReadAt: 1_000_000, sequenceReadAt: 1_000_000 },
  });
  // The same journey on a line board, two minutes later, without a sequence.
  const callLess: StopEvent = createStopEvent({
    ...row,
    id: "other",
    calls: undefined,
    readAt: { rowReadAt: 1_120_000 },
  });

  const merged = mergeDatedJourneyReading(row, callLess);

  assert.deepEqual(merged.calls, row.calls);
  assert.deepEqual(merged.readAt, { rowReadAt: 1_000_000, sequenceReadAt: 1_000_000 });
});

/** A row with no calls has one clock. */
test("a row carrying no sequence is dated on one clock, not on two", () => {
  const row: StopEvent = createStopEvent({
    id: "row",
    lineId: "1",
    ptMode: "tram",
    destinationText: "Durlach",
    minutesUntilDeparture: 2,
    boardingStopPlaceId: "durlacher-tor",
    status: "realtime",
    timetabledDepartureTime: "2026-08-29T21:30:00Z",
    readAt: { rowReadAt: 1_000_000 },
  });
  const sequence: StopEvent = createStopEvent({
    ...row,
    id: "sequence",
    calls: [
      {
        stopName: "Kronenplatz (U)",
        stopPlaceId: "kronenplatz",
        timetabledDepartureTime: "2026-08-29T21:32:00Z",
      },
    ],
    readAt: { rowReadAt: 1_000_000, sequenceReadAt: 1_120_000 },
  });

  assert.deepEqual(mergeDatedJourneyReading(row, undefined).readAt, { rowReadAt: 1_000_000 });
  // A sequence read later than the row says so.
  assert.deepEqual(mergeDatedJourneyReading(row, sequence).readAt, {
    rowReadAt: 1_000_000,
    sequenceReadAt: 1_120_000,
  });
});
