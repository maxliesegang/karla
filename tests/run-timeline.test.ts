import assert from "node:assert/strict";
import test from "node:test";
import { getRunTimeline } from "../src/lib/run-timeline.ts";
import { findFinalCallInstant } from "../src/lib/trip-calls.ts";
import { isRunInArea } from "../src/lib/run-discovery.ts";
import { createDeparture } from "./support/fixtures.ts";

test("position, area membership and retirement carry the same sparse delay", () => {
  const start = Date.parse("2026-10-07T12:00:00Z");
  const calls = ["marktplatz", "kronenplatz", "durlacher-tor"].map((localStopId, index) => ({
    localStopId,
    stopName: localStopId,
    scheduledArrivalTime: new Date(start + index * 5 * 60_000).toISOString(),
    scheduledDepartureTime: new Date(start + index * 5 * 60_000).toISOString(),
    ...(index === 0 ? { delayMinutes: 10 } : {}),
  }));
  assert.equal(getRunTimeline(calls).at(-1)?.departure, start + 20 * 60_000);
  assert.equal(findFinalCallInstant(calls), start + 20 * 60_000);
  assert.equal(
    isRunInArea(
      createDeparture({ tripCalls: calls }),
      start + 18 * 60_000,
      new Set(["kronenplatz", "durlacher-tor"]),
    ),
    true,
  );
});

test("an untimed final call never turns an earlier timed call into a run end", () => {
  assert.equal(
    findFinalCallInstant([
      { stopName: "first", scheduledDepartureTime: "2026-10-07T12:00:00Z" },
      { stopName: "unknown" },
    ]),
    undefined,
  );
});

test("carrying a later prediction backwards preserves separate arrival and departure delays", () => {
  const calls = [
    {
      stopName: "first",
      scheduledArrivalTime: "2026-10-07T12:00:00Z",
      scheduledDepartureTime: "2026-10-07T12:03:00Z",
    },
    {
      stopName: "second",
      scheduledArrivalTime: "2026-10-07T12:10:00Z",
      scheduledDepartureTime: "2026-10-07T12:12:00Z",
      arrivalDelayMinutes: 4,
      delayMinutes: 1,
    },
  ];
  assert.equal(getRunTimeline(calls)[0].arrival, Date.parse("2026-10-07T12:04:00Z"));
  assert.equal(getRunTimeline(calls)[0].departure, Date.parse("2026-10-07T12:04:00Z"));
});
