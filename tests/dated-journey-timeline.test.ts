import assert from "node:assert/strict";
import test from "node:test";
import { getDatedJourneyTimeline } from "../src/lib/dated-journey-timeline.ts";
import { findFinalCallInstant, getCallInstant } from "../src/lib/calls.ts";
import { isDatedJourneyInArea } from "../src/lib/dated-journey-discovery.ts";
import { createStopEvent } from "./support/fixtures.ts";

test("position, area membership and retirement carry the same sparse delay", () => {
  const start = Date.parse("2026-10-07T12:00:00Z");
  const calls = ["marktplatz", "kronenplatz", "durlacher-tor"].map((stopPlaceId, index) => ({
    stopPlaceId,
    stopName: stopPlaceId,
    timetabledArrivalTime: new Date(start + index * 5 * 60_000).toISOString(),
    timetabledDepartureTime: new Date(start + index * 5 * 60_000).toISOString(),
    ...(index === 0 ? { delayMinutes: 10 } : {}),
  }));
  assert.equal(getDatedJourneyTimeline(calls).at(-1)?.departure, start + 20 * 60_000);
  assert.equal(findFinalCallInstant(calls), start + 20 * 60_000);
  assert.equal(
    isDatedJourneyInArea(
      createStopEvent({ calls }),
      start + 18 * 60_000,
      new Set(["kronenplatz", "durlacher-tor"]),
    ),
    true,
  );
});

test("an untimed final call never turns an earlier timed call into a run end", () => {
  assert.equal(
    findFinalCallInstant([
      { stopName: "first", timetabledDepartureTime: "2026-10-07T12:00:00Z" },
      { stopName: "unknown" },
    ]),
    undefined,
  );
});

test("carrying a later prediction backwards preserves separate arrival and departure delays", () => {
  const calls = [
    {
      stopName: "first",
      timetabledArrivalTime: "2026-10-07T12:00:00Z",
      timetabledDepartureTime: "2026-10-07T12:03:00Z",
    },
    {
      stopName: "second",
      timetabledArrivalTime: "2026-10-07T12:10:00Z",
      timetabledDepartureTime: "2026-10-07T12:12:00Z",
      arrivalDelayMinutes: 4,
      delayMinutes: 1,
    },
  ];
  assert.equal(getDatedJourneyTimeline(calls)[0].arrival, Date.parse("2026-10-07T12:04:00Z"));
  assert.equal(getDatedJourneyTimeline(calls)[0].departure, Date.parse("2026-10-07T12:04:00Z"));
});

test("a prediction to the second wins over its rounded delay and carries on to unmonitored calls", () => {
  const calls = [
    {
      stopName: "first",
      timetabledDepartureTime: "2026-10-17T21:01:00Z",
      estimatedDepartureTime: "2026-10-17T21:05:12Z",
      delayMinutes: 4,
    },
    { stopName: "second", timetabledArrivalTime: "2026-10-17T21:03:00Z" },
  ];
  const [first, second] = getDatedJourneyTimeline(calls);
  assert.equal(first.departure, Date.parse("2026-10-17T21:05:12Z"));
  assert.equal(second.arrival, Date.parse("2026-10-17T21:07:12Z"));
  assert.equal(getCallInstant(calls[0]), Date.parse("2026-10-17T21:05:12Z"));
});
