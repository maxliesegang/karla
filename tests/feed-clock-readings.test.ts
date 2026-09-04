import assert from "node:assert/strict";
import test from "node:test";
import type { Departure } from "../src/data/transit-types.ts";
import { getCountdownMinutes } from "../src/lib/feed-clock.ts";
import {
  getDepartureStatusLabel,
  getDepartureTimeReading,
  getTripCallTimeReading,
} from "../src/lib/departure-presentation.ts";
import { parseDepartureBoardResponse } from "../src/data/kvv-efa-parsers.ts";
import { sortDeparturesByExpectedTime } from "../src/lib/departure-order.ts";

const createDeparture = (overrides: Partial<Departure> = {}): Departure => ({
  id: "trip-1",
  lineId: "1",
  transportMode: "tram",
  destination: "Durlach Turmberg",
  minutesUntilDeparture: 7,
  platformCode: "1",
  boardingLocalStopId: "marktplatz",
  status: "realtime",
  scheduledDepartureTime: "2026-08-30T17:32:00+02:00",
  ...overrides,
});

/**
 * The feed's clock carries seconds and its own board does not count them: EFA publishes `17:34`
 * less `17:27` as seven, not the six a reading to the second would floor to. A rider at the stop
 * is holding this board up against the KVV display over the platform, so counting the seconds put
 * every row of it one minute below the sign beside it, all day.
 */
test("a countdown is counted against the feed's clock at the minute, as the operator's own board is", () => {
  const departure = createDeparture({ delayMinutes: 2 });
  const feedNow = Date.parse("2026-08-30T17:27:24+02:00");

  assert.equal(getCountdownMinutes(departure, feedNow), 7);
});

test("a departure still passes on its own once the minute it was due has gone by", () => {
  const departure = createDeparture({ delayMinutes: 2 });

  assert.equal(getCountdownMinutes(departure, Date.parse("2026-08-30T17:33:59+02:00")), 1);
  assert.equal(getCountdownMinutes(departure, Date.parse("2026-08-30T17:34:00+02:00")), 0);
  assert.equal(getCountdownMinutes(departure, Date.parse("2026-08-30T17:40:00+02:00")), 0);
});

/**
 * The feed truncates the delay it states and does not truncate the prediction beside it, so about
 * one monitored row in twenty carries `delay: 0` against a `realDateTime` a minute later. Read from
 * the delay alone such a row publishes the schedule and calls the trip punctual — a measurement the
 * feed never made.
 */
test("the published time is the feed's own prediction, not the schedule plus its truncated delay", () => {
  const departure = createDeparture({
    delayMinutes: 0,
    predictedDepartureTime: "2026-08-30T17:33:00+02:00",
  });
  const reading = getDepartureTimeReading(departure);

  assert.equal(reading?.expectedTime, "17:33");
  assert.equal(reading?.scheduledTime, "17:32");
  assert.equal(reading?.punctuality, "late");
  assert.equal(getCountdownMinutes(departure, Date.parse("2026-08-30T17:27:24+02:00")), 6);
});

test("a trip the feed made no prediction for still reads as unmonitored rather than punctual", () => {
  const departure = createDeparture({ delayMinutes: undefined });
  const reading = getDepartureTimeReading(departure);

  assert.equal(reading?.punctuality, "unmonitored");
  assert.equal(reading?.scheduledTime, undefined);
  assert.equal(getDepartureStatusLabel(departure), "nach Fahrplan");
});

test("a cancelled trip is moved by neither the prediction nor the delay", () => {
  const reading = getDepartureTimeReading(
    createDeparture({
      status: "cancelled",
      delayMinutes: 3,
      predictedDepartureTime: "2026-08-30T17:35:00+02:00",
    }),
  );

  assert.equal(reading?.expectedTime, "17:32");
  assert.equal(reading?.punctuality, "unmonitored");
});

/** The order a board is read in has to be the order of the times printed on it, to the minute. */
test("the board is ordered by the prediction the rows publish, not by the delay stated beside it", () => {
  const predicted = createDeparture({
    id: "predicted",
    delayMinutes: 0,
    predictedDepartureTime: "2026-08-30T17:33:00+02:00",
  });
  const stated = createDeparture({
    id: "stated",
    scheduledDepartureTime: "2026-08-30T17:32:30+02:00",
  });

  assert.deepEqual(
    sortDeparturesByExpectedTime([predicted, stated]).map(({ id }) => id),
    ["stated", "predicted"],
  );
});

/**
 * A stop sequence carries scheduled times and deviations alone, so the call the *row* completes —
 * the trip's call at the board's own stop — is the only one with a prediction behind it. Left on
 * the stated delay it publishes a minute before the row it was read from, which is the board and
 * the diagram beside it disagreeing about one departure.
 */
test("the call a row completes carries the same published time as the row itself", () => {
  const board = parseDepartureBoardResponse(
    {
      parameters: [{ name: "serverTime", value: "2026-08-30T17:27:24" }],
      departureList: [
        {
          stopID: "7001003",
          nameWO: "Marktplatz",
          countdown: "5",
          dateTime: { year: "2026", month: "8", day: "30", hour: "17", minute: "32" },
          realDateTime: { year: "2026", month: "8", day: "30", hour: "17", minute: "33" },
          servingLine: { symbol: "1", number: "1", direction: "Durlach", motType: "4", delay: "0" },
          onwardStopSeq: [
            {
              nameWO: "Kronenplatz",
              ref: { id: "7001002", depDateTimeSec: "20260830 17:34:00", depDelay: "0" },
            },
          ],
        },
      ],
    },
    "marktplatz",
  );
  const departure = board.departures[0];
  const ownCall = departure.tripCalls?.find((call) => call.isCurrentStop);
  const feedNow = Date.parse(board.serverTime);

  assert.equal(getDepartureTimeReading(departure)?.expectedTime, "17:33");
  assert.equal(getTripCallTimeReading(ownCall!, feedNow)?.expectedTime, "17:33");
});
