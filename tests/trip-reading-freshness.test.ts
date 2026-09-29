import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { findBestRunReading, getDepartureReadInstant } from "../src/lib/trips.ts";
import { createDeparture } from "./support/fixtures.ts";

const readAt = Date.parse("2026-08-29T21:40:00Z");

/** The whole calling sequence, as every detailed board states it — with the deviation of the hour. */
const callsWithDelay = (delayMinutes: number): TripCall[] => [
  {
    stopName: "Durlacher Tor/KIT-Campus Süd (U)",
    localStopId: "durlacher-tor",
    scheduledDepartureTime: "2026-08-29T21:30:00Z",
    delayMinutes,
  },
  {
    stopName: "Kronenplatz (U)",
    localStopId: "kronenplatz",
    scheduledDepartureTime: "2026-08-29T21:32:00Z",
    delayMinutes,
  },
];

const departure = (tripCalls?: TripCall[]): Departure =>
  createDeparture({
    id: "trip-at-durlacher-tor",
    tripId: "trip",
    tripInstanceId: "trip@2026-08-29T21:30:00Z",
    lineId: "1",
    transportMode: "tram",
    destination: "Durlach",
    minutesUntilDeparture: 2,
    platformCode: "1",
    boardingLocalStopId: "durlacher-tor",
    status: "realtime",
    scheduledDepartureTime: "2026-08-29T21:30:00Z",
    tripCalls,
  });

/**
 * Rows are dated by the board they came off, exactly as the source dates the ones it publishes —
 * a calls clock only where the row carries calls for it to date.
 */
const board = (receivedAt: number, departures: Departure[]): DepartureBoard => ({
  stopId: "durlacher-tor",
  dataStatus: "live",
  receivedAt,
  feedUpdatedAt: new Date(receivedAt).toISOString(),
  departures: departures.map((departure) => ({
    ...departure,
    readAt: {
      rowReadAt: receivedAt,
      ...(departure.tripCalls?.length ? { sequenceReadAt: receivedAt } : {}),
    },
  })),
});

/** How the address finds its trip on a board; `routing.ts` spells the real one. */
const findTrip = (departures: readonly Departure[]) =>
  departures.find((candidate) => candidate.tripId === "trip");

const readDelay = (reading: Departure | undefined) => reading?.tripCalls?.[0]?.delayMinutes;

test("two whole sequences of one trip are separated by the age of the board, not by array order", () => {
  // The observation posts are read every twenty minutes and carry complete sequences, so they tie
  // with the thirty-second reading on length and used to win on being listed first.
  const observation = board(readAt - 20 * 60_000, [departure(callsWithDelay(1))]);
  const lineBoard = board(readAt, [departure(callsWithDelay(6))]);

  assert.equal(readDelay(findBestRunReading([observation, lineBoard], findTrip)), 6);
  assert.equal(readDelay(findBestRunReading([lineBoard, observation], findTrip)), 6);
});

test("the reading is dated by the board it was found on, which is what the ride discloses", () => {
  const observation = board(readAt - 20 * 60_000, [departure(callsWithDelay(1))]);

  const reading = findBestRunReading([observation], findTrip);
  assert.equal(reading && getDepartureReadInstant(reading), readAt - 20 * 60_000);
});

test("a fresher row carrying no sequence never displaces one that carries the trip", () => {
  // A plain board states no calls at all: it is the newer reading and completes nothing.
  const plain = board(readAt, [departure()]);
  const detailed = board(readAt - 90_000, [departure(callsWithDelay(4))]);

  assert.equal(readDelay(findBestRunReading([plain, detailed], findTrip)), 4);
  assert.equal(readDelay(findBestRunReading([detailed, plain], findTrip)), 4);
});

test("boards read at the same instant fall back to whichever saw more of the trip", () => {
  const partial = board(readAt, [departure(callsWithDelay(4).slice(0, 1))]);
  const whole = board(readAt, [departure(callsWithDelay(4))]);

  assert.equal(findBestRunReading([partial, whole], findTrip)?.tripCalls?.length, 2);
  assert.equal(findBestRunReading([whole, partial], findTrip)?.tripCalls?.length, 2);
});

test("a trip no board carries has no reading to date", () => {
  assert.equal(findBestRunReading([board(readAt, [])], findTrip), undefined);
});
