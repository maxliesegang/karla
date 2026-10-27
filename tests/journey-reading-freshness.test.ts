import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, StopEventBoard, Call } from "../src/data/transit-types.ts";
import { findBestDatedJourneyReading, getStopEventReadInstant } from "../src/lib/journeys.ts";
import { createStopEvent } from "./support/fixtures.ts";

const readAt = Date.parse("2026-08-29T21:40:00Z");

/** The whole calling sequence, as every detailed board states it — with the deviation of the hour. */
const callsWithDelay = (delayMinutes: number): Call[] => [
  {
    stopName: "Durlacher Tor/KIT-Campus Süd (U)",
    stopPlaceId: "durlacher-tor",
    timetabledDepartureTime: "2026-08-29T21:30:00Z",
    delayMinutes,
  },
  {
    stopName: "Kronenplatz (U)",
    stopPlaceId: "kronenplatz",
    timetabledDepartureTime: "2026-08-29T21:32:00Z",
    delayMinutes,
  },
];

const stopEvent = (calls?: Call[]): StopEvent =>
  createStopEvent({
    id: "trip-at-durlacher-tor",
    journeyRef: "trip",
    datedJourneyId: "trip@2026-08-29T21:30:00Z",
    lineId: "1",
    ptMode: "tram",
    destinationText: "Durlach",
    minutesUntilDeparture: 2,
    bay: "1",
    boardingStopPlaceId: "durlacher-tor",
    status: "realtime",
    timetabledDepartureTime: "2026-08-29T21:30:00Z",
    calls,
  });

/**
 * Rows are dated by the board they came off, exactly as the source dates the ones it publishes —
 * a calls clock only where the row carries calls for it to date.
 */
const board = (receivedAt: number, stopEvents: StopEvent[]): StopEventBoard => ({
  stopId: "durlacher-tor",
  dataStatus: "live",
  receivedAt,
  feedUpdatedAt: new Date(receivedAt).toISOString(),
  stopEvents: stopEvents.map((stopEvent) => ({
    ...stopEvent,
    readAt: {
      rowReadAt: receivedAt,
      ...(stopEvent.calls?.length ? { sequenceReadAt: receivedAt } : {}),
    },
  })),
});

/** How the address finds its trip on a board; `routing.ts` spells the real one. */
const findJourney = (stopEvents: readonly StopEvent[]) =>
  stopEvents.find((candidate) => candidate.journeyRef === "trip");

const readDelay = (reading: StopEvent | undefined) => reading?.calls?.[0]?.delayMinutes;

test("two whole sequences of one trip are separated by the age of the board, not by array order", () => {
  // The observation posts are read every twenty minutes and carry complete sequences, so they tie
  // with the thirty-second reading on length and used to win on being listed first.
  const observation = board(readAt - 20 * 60_000, [stopEvent(callsWithDelay(1))]);
  const lineBoard = board(readAt, [stopEvent(callsWithDelay(6))]);

  assert.equal(readDelay(findBestDatedJourneyReading([observation, lineBoard], findJourney)), 6);
  assert.equal(readDelay(findBestDatedJourneyReading([lineBoard, observation], findJourney)), 6);
});

test("the reading is dated by the board it was found on, which is what the ride discloses", () => {
  const observation = board(readAt - 20 * 60_000, [stopEvent(callsWithDelay(1))]);

  const reading = findBestDatedJourneyReading([observation], findJourney);
  assert.equal(reading && getStopEventReadInstant(reading), readAt - 20 * 60_000);
});

test("a fresher row carrying no sequence never displaces one that carries the trip", () => {
  // A plain board states no calls at all: it is the newer reading and completes nothing.
  const plain = board(readAt, [stopEvent()]);
  const detailed = board(readAt - 90_000, [stopEvent(callsWithDelay(4))]);

  assert.equal(readDelay(findBestDatedJourneyReading([plain, detailed], findJourney)), 4);
  assert.equal(readDelay(findBestDatedJourneyReading([detailed, plain], findJourney)), 4);
});

test("boards read at the same instant fall back to whichever saw more of the trip", () => {
  const partial = board(readAt, [stopEvent(callsWithDelay(4).slice(0, 1))]);
  const whole = board(readAt, [stopEvent(callsWithDelay(4))]);

  assert.equal(findBestDatedJourneyReading([partial, whole], findJourney)?.calls?.length, 2);
  assert.equal(findBestDatedJourneyReading([whole, partial], findJourney)?.calls?.length, 2);
});

test("a trip no board carries has no reading to date", () => {
  assert.equal(findBestDatedJourneyReading([board(readAt, [])], findJourney), undefined);
});
