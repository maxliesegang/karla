import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getSmoothTripPlacement } from "../src/lib/vehicle-positioning.ts";

const start = Date.parse("2026-08-23T10:00:00Z");

function call(stopId: string, minute: number, delayMinutes = 0): TripCall {
  const time = new Date(start + minute * 60_000).toISOString();
  return {
    stopName: stopId.toUpperCase(),
    localStopId: stopId,
    scheduledArrivalTime: time,
    scheduledDepartureTime: time,
    delayMinutes,
  };
}

function departure(id: string, calls: readonly TripCall[]): Departure {
  return {
    id,
    tripId: id,
    lineId: "2",
    transportMode: "tram",
    destination: "D",
    minutesUntilDeparture: 0,
    platformName: "1",
    boardingStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: calls,
  };
}

test("stands at a call before using the full remaining interval to reach the next one", () => {
  const trip = departure("position-dwell", [call("a", 0), call("b", 2), call("c", 4)]);

  assert.deepEqual(getSmoothTripPlacement(trip, start + 19_000), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
  });

  const running = getSmoothTripPlacement(trip, start + 95_000);
  assert.ok(running && running.progress > 0.74 && running.progress < 0.76);
});

test("walks through a large forward estimate correction instead of jumping over calls", () => {
  const original = departure("position-forward", [
    call("a", 0),
    call("b", 2),
    call("c", 4),
    call("d", 6),
    call("e", 8),
  ]);
  const corrected = departure("position-forward", [
    call("a", 0),
    call("b", 2, -2),
    call("c", 4, -3),
    call("d", 6, -4),
    call("e", 8, -4),
  ]);

  const before = getSmoothTripPlacement(original, start + 60_000);
  const after = getSmoothTripPlacement(corrected, start + 61_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(after?.fromStopId, "a");
  assert.ok(after && before && after.progress > before.progress);
  assert.ok(after && after.progress < 0.5);
});

test("never follows a backward revision: the mark waits for the trip to catch up", () => {
  const original = departure("position-backward", [call("a", 0), call("b", 2), call("c", 4)]);
  const corrected = departure("position-backward", [
    call("a", 0),
    call("b", 2, 3),
    call("c", 4, 3),
  ]);

  const before = getSmoothTripPlacement(original, start + 95_000);
  const held = getSmoothTripPlacement(corrected, start + 96_000);
  const later = getSmoothTripPlacement(corrected, start + 141_000);

  assert.equal(held?.progress, before?.progress);
  assert.equal(later?.progress, before?.progress);
});

test("keeps its ground when a fresher reading times a call inside the link it is on", () => {
  // Every board leaves out the one call it was read at, so two boards describe the same vehicle
  // with different links: read at B this trip runs A to C without stopping, read anywhere else it
  // calls at B on the way. The mark is most of the way to B, and the two readings have to agree
  // about that — a link that gains a call is not a train that has gone back down it.
  const withoutB = departure("position-recut-link", [call("a", 0), call("c", 4)]);
  const withB = departure("position-recut-link", [call("a", 0), call("b", 2), call("c", 4)]);

  const before = getSmoothTripPlacement(withoutB, start + 110_000);
  const rebased = getSmoothTripPlacement(withB, start + 111_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(before?.toStopId, "c");
  assert.equal(rebased?.fromStopId, "a");
  assert.equal(rebased?.toStopId, "b");
  // Both readings put it a minute and a half past A, which is nine tenths of the way to B and
  // fewer than half of the way to C. Carrying the number rather than the ground halved that.
  assert.ok(before && before.progress > 0.4 && before.progress < 0.5);
  assert.ok(rebased && rebased.progress > 0.8);
});

test("holds its ground when a fresher board states an earlier feed clock", () => {
  const trip = departure("position-clock-step", [call("a", 0), call("b", 2), call("c", 4)]);

  const before = getSmoothTripPlacement(trip, start + 95_000);
  const stepped = getSmoothTripPlacement(trip, start + 92_000);
  const after = getSmoothTripPlacement(trip, start + 96_000);

  assert.equal(stepped?.progress, before?.progress);
  // The step back is not credited as travelled time either: the mark resumes from where it stood.
  assert.ok(after && before && after.progress > before.progress && after.progress < 0.8);
});

test("stays on its own link when the observed sequence is re-cut around it", () => {
  const seen = departure("position-recut", [call("a", 0), call("b", 2), call("c", 4)]);
  // The same trip read off a board further back: every index has shifted by one.
  const extended = departure("position-recut", [
    call("z", -2),
    call("a", 0),
    call("b", 2),
    call("c", 4),
  ]);

  const before = getSmoothTripPlacement(seen, start + 95_000);
  const rebased = getSmoothTripPlacement(extended, start + 96_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(rebased?.fromStopId, "a");
  assert.ok(rebased && before && rebased.progress >= before.progress);
});

/** A call whose two ends differ: separate scheduled times, and a deviation for each of them. */
function dwellCall(
  stopId: string,
  arrivalMinute: number,
  departureMinute: number,
  { arrivalDelayMinutes, delayMinutes }: Pick<TripCall, "arrivalDelayMinutes" | "delayMinutes">,
): TripCall {
  return {
    stopName: stopId.toUpperCase(),
    localStopId: stopId,
    scheduledArrivalTime: new Date(start + arrivalMinute * 60_000).toISOString(),
    scheduledDepartureTime: new Date(start + departureMinute * 60_000).toISOString(),
    arrivalDelayMinutes,
    delayMinutes,
  };
}

test("carries the last stated deviation across the calls the feed does not monitor", () => {
  // The vehicle is four minutes down where the feed watches it and unstated from there on. Read as
  // on time, those calls are timed before the ones behind them and the run reads as already over.
  const trip = departure("position-unmonitored", [
    call("a", 0, 4),
    call("b", 2, 4),
    { ...call("c", 4), delayMinutes: undefined },
    { ...call("d", 6), delayMinutes: undefined },
  ]);

  const placement = getSmoothTripPlacement(trip, start + 6.5 * 60_000);

  assert.equal(placement?.fromStopId, "b");
  assert.equal(placement?.toStopId, "c");
  // Standing at B until 6:20 on its shifted clock, then the hundred seconds left to reach C.
  assert.ok(placement && placement.progress > 0.05 && placement.progress < 0.15);
});

test("keeps the two ends of a call apart: a late arrival is not a late departure", () => {
  // Four minutes down into B, where five minutes of layover let it leave on time again. The mark
  // has to still be short of B while the delay lasts, not standing on it.
  const trip = departure("position-recovering-dwell", [
    call("a", 0, 4),
    dwellCall("b", 5, 10, { arrivalDelayMinutes: 4, delayMinutes: 0 }),
    call("c", 12, 0),
  ]);

  const running = getSmoothTripPlacement(trip, start + 6 * 60_000);
  assert.equal(running?.fromStopId, "a");
  assert.equal(running?.toStopId, "b");
  assert.ok(running && running.progress > 0.3 && running.progress < 0.4);

  // Standing at B through the layover it recovers in, and away on the published departure minute.
  const standing = getSmoothTripPlacement(trip, start + 9.5 * 60_000);
  assert.deepEqual(standing, { fromStopId: "b", toStopId: "c", progress: 0 });
  const away = getSmoothTripPlacement(trip, start + 11 * 60_000);
  assert.ok(away && away.progress > 0);
});

test("the board row's own prediction moves the mark its stale sequence has already let go", () => {
  const trip = {
    ...departure("position-row-prediction", [call("a", 0), call("b", 2), call("c", 4)]),
    // The sequence was read three minutes ago and says on time; the row beside it, read now, says
    // this vehicle has not left its stop yet.
    predictedDepartureTime: new Date(start + 3 * 60_000).toISOString(),
    delayMinutes: 3,
  };

  assert.deepEqual(getSmoothTripPlacement(trip, start + 3 * 60_000), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
  });
});

test("a row the vehicle has already left is history, not a correction to carry down the run", () => {
  // The reading a retained ride keeps restating: its row still says "+3 at A" minutes after the
  // vehicle left A, while the sequence it was re-read with states the truth ahead of it.
  const trip = {
    ...departure("position-departed-row", [call("a", 0), call("b", 4), call("c", 8)]),
    predictedDepartureTime: new Date(start + 3 * 60_000).toISOString(),
    delayMinutes: 3,
  };

  // Still at A on both accounts: the row is a prediction and is taken.
  assert.deepEqual(getSmoothTripPlacement({ ...trip, id: "row-ahead" }, start + 2 * 60_000), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
  });

  // Long past it: the stale row must not push B and C three minutes down the line with it.
  const placement = getSmoothTripPlacement({ ...trip, id: "row-behind" }, start + 6 * 60_000);
  assert.equal(placement?.fromStopId, "b");
  assert.ok(placement && placement.progress > 0.4 && placement.progress < 0.6);
});
