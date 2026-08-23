import assert from "node:assert/strict";
import test from "node:test";
import type { TripCall } from "../src/data/transit-types.ts";
import { locateOnTripCalls, MAX_FIX_ACCURACY_METERS } from "../src/lib/ride-location.ts";
import { getTripProgress } from "../src/lib/trip-progress.ts";

/** Roughly 111 m of latitude per 0.001°, which keeps the fixtures readable as distances. */
const createCall = (
  stopId: string,
  latitude: number | undefined,
  longitude: number | undefined,
  minute: number,
): TripCall => ({
  stopName: stopId,
  localStopId: stopId,
  latitude,
  longitude,
  scheduledArrivalTime: `2026-08-29T10:${String(minute).padStart(2, "0")}:00Z`,
  scheduledDepartureTime: `2026-08-29T10:${String(minute).padStart(2, "0")}:00Z`,
});

const calls = [
  createCall("a", 49.0, 8.4, 0),
  createCall("b", 49.01, 8.4, 4),
  createCall("c", 49.02, 8.4, 8),
];

test("places a fix on the link it is running along", () => {
  const location = locateOnTripCalls(calls, {
    latitude: 49.0075,
    longitude: 8.4,
    accuracyMeters: 20,
  });
  assert.equal(location?.nextCallIndex, 1);
  assert.ok(Math.abs((location?.linkProgress ?? 0) - 0.75) < 0.02);
  assert.ok((location?.metersToNextCall ?? 0) < 300);
});

test("names the following stop once the vehicle has left one behind", () => {
  const location = locateOnTripCalls(calls, {
    latitude: 49.015,
    longitude: 8.4,
    accuracyMeters: 20,
  });
  assert.equal(location?.nextCallIndex, 2);
});

test("refuses a fix too coarse to tell one stop from the next", () => {
  assert.equal(
    locateOnTripCalls(calls, {
      latitude: 49.0075,
      longitude: 8.4,
      accuracyMeters: MAX_FIX_ACCURACY_METERS + 1,
    }),
    null,
  );
});

test("refuses a fix that is nowhere near the line", () => {
  assert.equal(
    locateOnTripCalls(calls, { latitude: 49.0075, longitude: 8.5, accuracyMeters: 20 }),
    null,
  );
});

test("will not span a link across a call the feed gave no coordinates for", () => {
  const gapped = [calls[0], createCall("b", undefined, undefined, 4), calls[2]];
  assert.equal(
    locateOnTripCalls(gapped, { latitude: 49.0075, longitude: 8.4, accuracyMeters: 20 }),
    null,
  );
});

test("the timetable settles a line that passes the same ground twice", () => {
  const loop = [
    createCall("a", 49.0, 8.4, 0),
    createCall("b", 49.01, 8.4, 4),
    createCall("c", 49.0, 8.4, 8),
    createCall("d", 48.99, 8.4, 12),
  ];
  const fix = { latitude: 49.005, longitude: 8.4, accuracyMeters: 20 };
  assert.equal(locateOnTripCalls(loop, fix, 1)?.nextCallIndex, 1);
  assert.equal(locateOnTripCalls(loop, fix, 2)?.nextCallIndex, 2);
});

const feedNow = Date.parse("2026-08-29T10:03:00Z");

test("the ride reads its next stop from the position rather than from the timetable", () => {
  // The timetable has the vehicle already past b; the rider is in fact still short of it.
  const late = [
    createCall("a", 49.0, 8.4, 0),
    createCall("b", 49.01, 8.4, 1),
    createCall("c", 49.02, 8.4, 9),
  ];
  const progress = getTripProgress(late, feedNow, {
    fix: {
      latitude: 49.005,
      longitude: 8.4,
      accuracyMeters: 20,
    },
  });
  assert.equal(progress.source, "position");
  assert.equal(progress.nextCall?.stopName, "b");
  assert.equal(progress.passedCallCount, 1);
  assert.equal(getTripProgress(late, feedNow).nextCall?.stopName, "c");
});

test("counts the minutes down by how much of the link is left", () => {
  const progress = getTripProgress(calls, feedNow, {
    fix: {
      latitude: 49.0075,
      longitude: 8.4,
      accuracyMeters: 20,
    },
  });
  // A quarter of a four-minute link is left, whatever the clock says about it.
  assert.equal(progress.minutesToNextCall, 1);
  assert.ok((progress.metersToNextCall ?? 0) > 0);
});

test("falls back to the timetable when the fix cannot be placed", () => {
  const progress = getTripProgress(calls, feedNow, {
    fix: {
      latitude: 49.0075,
      longitude: 8.5,
      accuracyMeters: 20,
    },
  });
  assert.equal(progress.source, "schedule");
  assert.deepEqual(
    { next: progress.nextCall?.stopName, minutes: progress.minutesToNextCall },
    {
      next: getTripProgress(calls, feedNow).nextCall?.stopName,
      minutes: getTripProgress(calls, feedNow).minutesToNextCall,
    },
  );
});

test("a position cannot restart a ride the trip has already finished", () => {
  const finished = getTripProgress(calls, Date.parse("2026-08-29T10:30:00Z"), {
    fix: {
      latitude: 49.0075,
      longitude: 8.4,
      accuracyMeters: 20,
    },
  });
  assert.equal(finished.isFinished, true);
  assert.equal(finished.source, "schedule");
});

test("an Ausstieg the position has passed ends the ride", () => {
  const progress = getTripProgress(calls, feedNow, {
    alightingStopId: "a",
    fix: {
      latitude: 49.0075,
      longitude: 8.4,
      accuracyMeters: 20,
    },
  });
  assert.equal(progress.isFinished, true);
  assert.equal(progress.finalCall?.stopName, "a");
});
