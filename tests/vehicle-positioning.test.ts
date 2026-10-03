import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  getRunPlacement as getSmoothTripPlacement,
  getRunTrajectoryProgress as getTripTrajectoryProgress,
} from "../src/lib/vehicle-positioning.ts";
import { createCall, run } from "./support/calls.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import { createDeparture } from "./support/fixtures.ts";

/** One drawing's motion record, shared across this file. */
const motions = createRunMotions();

const start = Date.parse("2026-08-23T10:00:00Z");
const call = createCall(start);

function departure(id: string, calls: readonly TripCall[]): Departure {
  return createDeparture({
    id,
    tripId: id,
    lineId: "2",
    transportMode: "tram",
    destination: "D",
    minutesUntilDeparture: 0,
    platformCode: "1",
    boardingLocalStopId: "a",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    tripCalls: calls,
  });
}

/** How far along an A-B-C-D chain a placement is, as one number. */
const getCallDistance = (placement: { fromStopId: string; progress: number }) =>
  "abcde".indexOf(placement.fromStopId) + placement.progress;

const placementOnly = (placement: ReturnType<typeof getSmoothTripPlacement>) => {
  if (!placement) return placement;
  const position = { ...placement };
  // These assertions are about position, not animation.
  delete position.trajectory;
  delete position.placedAfterLinks;
  return position;
};

test("leaves at the published departure and reaches the next published arrival", () => {
  const trip = departure("position-dwell", [call("a", 0), call("b", 2), call("c", 4)]);

  const departing = getSmoothTripPlacement(motions, trip, start + 19_000);
  assert.ok(departing && departing.progress > 0.09 && departing.progress < 0.11);

  const running = getSmoothTripPlacement(motions, trip, start + 95_000);
  assert.ok(running && running.progress > 0.83 && running.progress < 0.87);
  assert.equal(running?.trajectory?.arrivesAt, start + 2 * 60_000);
});

test("a revised arrival inherits the velocity already visible on the link", () => {
  const original = departure("position-velocity", [call("a", 0), call("b", 2), call("c", 4)]);
  const delayed = departure("position-velocity", [call("a", 0), call("b", 2, 1), call("c", 4, 1)]);
  const sampledAt = start + 60_000;
  const before = getSmoothTripPlacement(motions, original, sampledAt);
  const trajectory = before?.trajectory;
  assert.ok(trajectory);
  const previousVelocity =
    (getTripTrajectoryProgress(trajectory, sampledAt + 1_000) -
      getTripTrajectoryProgress(trajectory, sampledAt)) /
    1_000;

  const revised = getSmoothTripPlacement(motions, delayed, sampledAt + 1_000);
  assert.ok(revised?.trajectory);
  assert.ok(revised.trajectory.startVelocity > 0);
  assert.ok(
    Math.abs(revised.trajectory.startVelocity - previousVelocity) < previousVelocity * 0.05,
    "the new plan starts at the old plan's speed instead of restarting its acceleration",
  );
});

test("does not traverse a duplicated first stop before leaving it", () => {
  // The sequence's first call and the board row at the same stop are one stop, not a dwell link.
  const trip = departure("position-duplicate-first-stop", [
    {
      ...call("a", 0),
      scheduledDepartureTime: new Date(start + 36_000).toISOString(),
    },
    { ...call("a", 0), scheduledArrivalTime: undefined, isCurrentStop: true },
    call("b", 1.2),
    call("c", 2.4),
  ]);

  assert.deepEqual(placementOnly(getSmoothTripPlacement(motions, trip, start + 15_000)), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "running",
    motion: "placed",
  });

  const running = getSmoothTripPlacement(motions, trip, start + 55_000);
  assert.equal(running?.fromStopId, "a");
  assert.equal(running?.toStopId, "b");
  assert.ok(running && running.progress > 0);
});

test("traverses two genuinely timed calls at the same stop as separate platforms", () => {
  const trip = departure("position-same-stop-platforms", [
    call("a", 0),
    call("a", 2),
    call("b", 4),
  ]);

  const crossing = getSmoothTripPlacement(motions, trip, start + 60_000);
  assert.equal(crossing?.fromStopId, "a");
  assert.equal(crossing?.toStopId, "a");
  assert.ok(crossing && crossing.progress > 0.49 && crossing.progress < 0.51);
});

test("places a large forward correction instead of animating an unobserved journey", () => {
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

  const before = getSmoothTripPlacement(motions, original, start + 60_000);
  const after = getSmoothTripPlacement(motions, corrected, start + 61_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(after?.fromStopId, "c");
  assert.equal(after?.motion, "placed");
  assert.ok(before && after && getCallDistance(after) > getCallDistance(before));
  // Well past a link, so the drawing snaps it.
  assert.ok(after && (after.placedAfterLinks ?? 0) > 1);
});

test("a placement that barely moved the mark is stated as one a drawing may correct", () => {
  // Drawn a little down its first link; the re-read run says it has not left. The move back is a
  // fraction of a link, a correction rather than a journey.
  const calls = [call("a", 0), call("b", 2), call("c", 4)];
  const drawn = getSmoothTripPlacement(
    motions,
    departure("position-travel-small", calls),
    start + 30_000,
  );
  assert.ok(drawn && drawn.fromStopId === "a" && drawn.progress > 0.1);
  // A first paint has no drawn mark to measure against.
  assert.equal(drawn?.placedAfterLinks, undefined);

  // Pulled in on time, and now due away two minutes late.
  const held = departure("position-travel-small", [
    { ...call("a", 0, 2), arrivalDelayMinutes: 0 },
    call("b", 2, 2),
    call("c", 4, 2),
  ]);
  const placed = getSmoothTripPlacement(motions, held, start + 31_000);

  assert.equal(placed?.motion, "placed");
  assert.equal(placed?.fromStopId, "a");
  assert.ok(placed && placed.placedAfterLinks !== undefined && placed.placedAfterLinks <= 1);
});

test("a backward revision re-times the link instead of moving the mark back", () => {
  // Three minutes added while the mark is most of the way to B: it keeps its ground and reaches B
  // on the revised clock, never creeping back towards A or standing at B early.
  const original = departure("position-backward", [call("a", 0), call("b", 2), call("c", 4)]);
  const corrected = departure("position-backward", [
    call("a", 0),
    call("b", 2, 3),
    call("c", 4, 3),
  ]);

  const before = getSmoothTripPlacement(motions, original, start + 115_000);
  const revised = getSmoothTripPlacement(motions, corrected, start + 116_000);
  const settling = getSmoothTripPlacement(motions, corrected, start + 125_000);
  const running = getSmoothTripPlacement(motions, corrected, start + 135_000);
  const waiting = getSmoothTripPlacement(motions, corrected, start + 250_000);
  const arriving = getSmoothTripPlacement(motions, corrected, start + 299_000);
  const arrived = getSmoothTripPlacement(motions, corrected, start + 301_000);

  assert.ok(before && before.progress > 0.9);
  // Travelling on, not placed, and never back.
  assert.equal(revised?.fromStopId, "a");
  assert.equal(revised?.motion, "travelled");
  assert.ok(revised && revised.progress >= before.progress);
  // No reading leaves it further back than the one before.
  assert.ok(settling && settling.progress >= revised.progress);
  assert.ok(running && running.progress >= settling.progress);
  // Still short of B after the old reading would have had it there…
  assert.ok(waiting && waiting.progress < 1);
  // …arriving on the corrected clock.
  assert.ok(arriving && arriving.progress > 0.95);
  assert.equal(arrived?.fromStopId, "b");
});

test("a delay that keeps growing bends the pace instead of dragging the mark back", () => {
  // Every refresh restates the run a minute later; the mark must hold its ground rather than
  // retreat after a receding target.
  const tripId = "position-growing-delay";
  let shown = getSmoothTripPlacement(
    motions,
    departure(tripId, [call("a", 0), call("b", 2), call("c", 4)]),
    start + 95_000,
  );
  assert.ok(shown && shown.progress > 0.7);
  let previous = shown.progress;
  for (let minute = 1; minute <= 5; minute += 1) {
    const revised = departure(tripId, [
      { ...call("a", 0), delayMinutes: undefined },
      call("b", 2, minute),
      call("c", 4, minute),
    ]);
    shown = getSmoothTripPlacement(motions, revised, start + 95_000 + minute * 30_000);
    assert.ok(shown);
    assert.equal(shown.motion, "travelled");
    assert.ok(shown.progress >= previous);
    previous = shown.progress;
  }
});

test("a lead built by a receding reading is given back by the tick, never by a fall", () => {
  // A delay restated a minute later each refresh and carried back over earlier calls slides the
  // reading under a standing mark. The mark gives ground back a tick at a time, never jumping back
  // a visible part of a link and never placed.
  const stops = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // Eight calls a minute apart, six minutes under way, monitored from E on.
  const reading = (delayMinutes: number) =>
    departure(
      "position-receding-reading",
      run(stops.map((stopId, index) => call(stopId, index - 6, index >= 4 ? delayMinutes : 0))),
    );

  // The same reading with no history: where a snapped mark would stand, to measure the lead.
  const readingAlone = (delayMinutes: number, at: number, tick: number) =>
    getSmoothTripPlacement(
      motions,
      { ...reading(delayMinutes), id: `alone-${tick}`, tripId: `alone-${tick}` },
      at,
    );

  let previous: number | null = null;
  let leadReachedBand = false;
  for (let tick = 0; tick <= 600; tick += 1) {
    const at = start + tick * 1_000;
    const delayMinutes = Math.floor(tick / 30);
    const shown = getSmoothTripPlacement(motions, reading(delayMinutes), at);
    const read = readingAlone(delayMinutes, at, tick);
    assert.ok(shown && read, `no mark at ${tick}s`);
    // Only the first paint is a placement.
    if (tick > 0) assert.equal(shown.motion, "travelled", `placed at ${tick}s`);
    const distance = stops.indexOf(shown.fromStopId) + shown.progress;
    leadReachedBand ||= distance - (stops.indexOf(read.fromStopId) + read.progress) > 1.9;
    // Half a link per frame is the limit; the original fault jumped more than two calls.
    if (previous !== null) {
      assert.ok(previous - distance < 0.5, `fell ${previous - distance} calls at ${tick}s`);
    }
    previous = distance;
  }
  // …and the lead really reached the band.
  assert.ok(leadReachedBand);
});

test("keeps its ground when a fresher reading times a call inside the link it is on", () => {
  // Each board omits its own call, so one reading runs A to C and another calls at B. Both must
  // place the mark most of the way to B.
  const withoutB = departure("position-recut-link", [call("a", 0), call("c", 4)]);
  const withB = departure("position-recut-link", [call("a", 0), call("b", 2), call("c", 4)]);

  const before = getSmoothTripPlacement(motions, withoutB, start + 110_000);
  const rebased = getSmoothTripPlacement(motions, withB, start + 111_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(before?.toStopId, "c");
  assert.equal(rebased?.fromStopId, "a");
  assert.equal(rebased?.toStopId, "b");
  // Ninety seconds past A: nine tenths to B, under half to C.
  assert.ok(before && before.progress > 0.4 && before.progress < 0.5);
  assert.ok(rebased && rebased.progress > 0.8);
});

test("holds its ground when a fresher board states an earlier feed clock", () => {
  const trip = departure("position-clock-step", [call("a", 0), call("b", 2), call("c", 4)]);

  const before = getSmoothTripPlacement(motions, trip, start + 95_000);
  const stepped = getSmoothTripPlacement(motions, trip, start + 92_000);
  const after = getSmoothTripPlacement(motions, trip, start + 96_000);

  assert.equal(stepped?.progress, before?.progress);
  // Not credited as travelled time: it resumes from where it stood.
  assert.ok(after && before && after.progress > before.progress && after.progress < 1);
});

test("stays on its own link when the observed sequence is re-cut around it", () => {
  const seen = departure("position-recut", [call("a", 0), call("b", 2), call("c", 4)]);
  // The same trip from a board further back: indexes shift by one.
  const extended = departure("position-recut", [
    call("z", -2),
    call("a", 0),
    call("b", 2),
    call("c", 4),
  ]);

  const before = getSmoothTripPlacement(motions, seen, start + 95_000);
  const rebased = getSmoothTripPlacement(motions, extended, start + 96_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(rebased?.fromStopId, "a");
  assert.ok(rebased && before && rebased.progress >= before.progress);
});

/** A call with different scheduled ends and a deviation for each. */
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
  // Four minutes late where monitored, unstated after; read as on time, the run would read as over.
  const trip = departure("position-unmonitored", [
    call("a", 0, 4),
    call("b", 2, 4),
    { ...call("c", 4), delayMinutes: undefined },
    { ...call("d", 6), delayMinutes: undefined },
  ]);

  const placement = getSmoothTripPlacement(motions, trip, start + 6.5 * 60_000);

  assert.equal(placement?.fromStopId, "b");
  assert.equal(placement?.toStopId, "c");
  // Thirty seconds into a two-minute link: early acceleration.
  assert.ok(placement && placement.progress > 0.19 && placement.progress < 0.22);
});

test("keeps the two ends of a call apart: a late arrival is not a late departure", () => {
  // Four minutes late into B, five minutes' layover, leaving on time: short of B while late.
  const trip = departure("position-recovering-dwell", [
    call("a", 0, 4),
    dwellCall("b", 5, 10, { arrivalDelayMinutes: 4, delayMinutes: 0 }),
    call("c", 12, 0),
  ]);

  const running = getSmoothTripPlacement(motions, trip, start + 6 * 60_000);
  assert.equal(running?.fromStopId, "a");
  assert.equal(running?.toStopId, "b");
  assert.ok(running && running.progress > 0.36 && running.progress < 0.4);

  // Standing at B, then away on the published minute.
  const standing = getSmoothTripPlacement(motions, trip, start + 9.5 * 60_000);
  assert.deepEqual(placementOnly(standing), {
    fromStopId: "b",
    toStopId: "c",
    progress: 0,
    phase: "running",
    motion: "placed",
  });
  const away = getSmoothTripPlacement(motions, trip, start + 11 * 60_000);
  assert.ok(away && away.progress > 0);
});

test("stands a monitored trip at the terminus it is due out of, once its turnaround is nearly over", () => {
  const trip = departure("position-before-start", run([call("a", 0), call("b", 2), call("c", 4)]));

  // Four minutes before departure: standing at the first call.
  assert.deepEqual(placementOnly(getSmoothTripPlacement(motions, trip, start - 4 * 60_000)), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });

  // Further out than the turnaround: nothing to show yet.
  assert.equal(
    getSmoothTripPlacement(
      motions,
      { ...trip, id: "position-long-before-start" },
      start - 12 * 60_000,
    ),
    null,
  );
});

test("a waiting mark stays at its terminus while the sequence around it is re-timed", () => {
  // A run that has not begun stays at its first stop even when a re-timing (a deviation carried
  // back from four calls on) arrives; re-planning would send it down the first link early.
  const plain = (tripCall: TripCall): TripCall => ({ ...tripCall, delayMinutes: undefined });
  const reading = (delayMinutes: number) =>
    departure(
      "position-waiting-retimed",
      run([
        plain(call("a", 0)),
        plain(call("b", 5)),
        plain(call("c", 10)),
        call("d", 15, delayMinutes),
      ]),
    );

  const waiting = getSmoothTripPlacement(motions, reading(0), start - 5 * 60_000);
  assert.equal(waiting?.phase, "beforeStart");

  for (const minutesOut of [4, 3, 2, 1]) {
    const held = getSmoothTripPlacement(
      motions,
      reading(minutesOut % 2),
      start - minutesOut * 60_000,
    );
    assert.deepEqual(placementOnly(held), {
      fromStopId: "a",
      toStopId: "b",
      progress: 0,
      phase: "beforeStart",
      motion: "travelled",
    });
  }

  // It leaves on its own departure.
  const leaving = getSmoothTripPlacement(motions, reading(0), start + 60_000);
  assert.equal(leaving?.phase, "running");
  assert.ok(leaving && leaving.progress > 0.13 && leaving.progress < 0.17);
});

test("draws no waiting mark for a run the feed is not watching", () => {
  // Nothing monitored: a timetable line, not evidence of a vehicle at the terminus.
  const trip = {
    ...departure(
      "position-unmonitored-start",
      [call("a", 0), call("b", 2), call("c", 4)].map((tripCall) => ({
        ...tripCall,
        delayMinutes: undefined,
      })),
    ),
    status: "scheduled" as const,
  };

  assert.equal(getSmoothTripPlacement(motions, trip, start - 2 * 60_000), null);
});

test("keeps a finished trip standing at its final call before letting the mark go", () => {
  const calls = run([call("a", 0), call("b", 2), call("c", 4)]);

  assert.deepEqual(
    placementOnly(
      getSmoothTripPlacement(motions, departure("position-arrived", calls), start + 4.5 * 60_000),
    ),
    {
      fromStopId: "b",
      toStopId: "c",
      progress: 1,
      phase: "afterEnd",
      motion: "placed",
    },
  );

  assert.equal(
    getSmoothTripPlacement(motions, departure("position-arrived-gone", calls), start + 6 * 60_000),
    null,
  );
});

test("draws no stand at either end of a reading that stops short of the run", () => {
  // Every call timed at both ends: the feed states no run end, so neither end may carry a stand.
  const cut = departure("position-cut-sequence", [call("a", 0), call("b", 2), call("c", 4)]);

  assert.equal(getSmoothTripPlacement(motions, cut, start - 4 * 60_000), null);
  assert.equal(
    getSmoothTripPlacement(
      motions,
      { ...cut, id: "position-cut-sequence-end" },
      start + 4.5 * 60_000,
    ),
    null,
  );
});

test("a stand at the stop a run starts from is drawn there, not where the mark last stood", () => {
  const calls = run([call("a", 0), call("b", 10), call("c", 20), call("d", 30)]);
  const trip = departure("position-turnaround-stand", calls);

  // Travelled two calls along.
  const running = getSmoothTripPlacement(motions, trip, start + 21 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  // A revision puts the run forty minutes later, not started; its turnaround says the stand began,
  // so it stands, and only at its first stop.
  const delayed = departure(
    "position-turnaround-stand",
    calls.map((tripCall) => ({ ...tripCall, delayMinutes: 40 })),
  );
  const standing = getSmoothTripPlacement(
    motions,
    delayed,
    start + 22 * 60_000,
    start + 20 * 60_000,
  );

  assert.deepEqual(placementOnly(standing), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });
});

test("a revision that re-times a run's origin does not un-start a run the mark has left", () => {
  // A deviation stated ahead is carried back to the origin, but the run has begun: the mark keeps
  // its ground and re-times its link, not hauled back to the start.
  const calls = run([call("a", 0), call("b", 4), call("c", 8), call("d", 12), call("e", 16)]);
  const trip = departure("position-unstarted", calls);

  const running = getSmoothTripPlacement(motions, trip, start + 10 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  const revised = departure(
    "position-unstarted",
    calls.map((tripCall) => ({ ...tripCall, delayMinutes: 4 })),
  );
  const after = getSmoothTripPlacement(motions, revised, start + 10 * 60_000 + 1_000);

  assert.equal(after?.phase, "running");
  // Never back at the first stop.
  assert.ok(after && ["c", "d"].includes(after.fromStopId));
});

test("a delay that overtakes the mark re-times the link it is on instead of hauling it back", () => {
  // Twelve minutes stated ahead put the reading a call and a half behind the mark; it keeps its
  // ground and reaches D when the revised reading does.
  const calls = run([call("a", 0), call("b", 10), call("c", 20), call("d", 30)]);
  const trip = departure("position-replaced", calls);

  const running = getSmoothTripPlacement(motions, trip, start + 21 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  const revised = departure(
    "position-replaced",
    run([
      { ...call("a", 0), delayMinutes: undefined },
      call("b", 10, 12),
      call("c", 20, 12),
      call("d", 30, 12),
    ]),
  );
  const holding = getSmoothTripPlacement(motions, revised, start + 21 * 60_000 + 1_000);
  assert.equal(holding?.motion, "travelled");
  assert.ok(holding && getCallDistance(holding) > 2 && getCallDistance(holding) < 2.2);

  // Every hundred seconds, inside the freshness window: travelling, never further back.
  let previous = getCallDistance(holding);
  for (let at = 22 * 60_000; at <= 41 * 60_000; at += 100_000) {
    const shown = getSmoothTripPlacement(motions, revised, start + at);
    assert.ok(shown);
    assert.equal(shown.motion, "travelled");
    assert.ok(getCallDistance(shown) >= previous);
    previous = getCallDistance(shown);
  }
  // Into D on the corrected clock.
  const arriving = getSmoothTripPlacement(motions, revised, start + 41 * 60_000 + 50_000);
  assert.ok(arriving && getCallDistance(arriving) > 2.9);
});

test("a carried delay several calls behind does not reverse a departed mark", () => {
  // A delay carried from calls ahead is not evidence the vehicle is still at the last stop, so the
  // link is re-timed instead of moving back.
  const calls = run([call("a", 0), call("b", 2), call("c", 4), call("d", 6), call("e", 8)]);
  const trip = departure("position-contradicted", calls);

  const running = getSmoothTripPlacement(motions, trip, start + 7 * 60_000);
  assert.equal(running?.fromStopId, "d");

  const revised = departure(
    "position-contradicted",
    run([
      { ...call("a", 0), delayMinutes: undefined },
      call("b", 2, 6),
      call("c", 4, 6),
      call("d", 6, 6),
      call("e", 8, 6),
    ]),
  );
  const placed = getSmoothTripPlacement(motions, revised, start + 7 * 60_000 + 1_000);

  assert.equal(placed?.motion, "travelled");
  assert.equal(placed?.fromStopId, "d");
});

test("a departure re-stated later brings a departed mark back to the terminus it left from", () => {
  // The origin's departure is re-stated 25 minutes later: the vehicle is at the terminus, so the
  // mark goes back there and stands.
  const calls = run([call("a", 0), call("b", 10), call("c", 20), call("d", 30)]);
  const trip = departure("position-origin-restated", calls);

  const running = getSmoothTripPlacement(motions, trip, start + 21 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  const held = departure(
    "position-origin-restated",
    run([call("a", 0, 25), call("b", 10, 25), call("c", 20, 25), call("d", 30, 25)]),
  );
  const standing = getSmoothTripPlacement(motions, held, start + 21 * 60_000 + 1_000);

  assert.deepEqual(placementOnly(standing), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });
});

test("a stand read a link ahead of a standing mark is placed there, not travelled to", () => {
  // Drawn standing at B; the next reading has it standing at C. The link was never drawn, so it is
  // a placement, corrected over a few seconds.
  const tripId = "position-stand-link-ahead";
  const held = departure(
    tripId,
    run([
      call("a", 0),
      // At B: on time in, departure two minutes late.
      { ...call("b", 2, 2), arrivalDelayMinutes: 0 },
      call("c", 4),
      call("d", 6),
    ]),
  );
  const standing = getSmoothTripPlacement(motions, held, start + 2.5 * 60_000);
  assert.equal(standing?.fromStopId, "b");
  assert.equal(standing?.progress, 0);

  const moved = departure(
    tripId,
    run([
      call("a", 0),
      call("b", 2),
      // At C: on time in, departure two minutes late.
      { ...call("c", 3, 2), arrivalDelayMinutes: 0 },
      call("d", 6),
    ]),
  );
  const placed = getSmoothTripPlacement(motions, moved, start + 3.17 * 60_000);

  assert.equal(placed?.fromStopId, "c");
  assert.equal(placed?.progress, 0);
  assert.equal(placed?.motion, "placed");
  assert.equal(placed?.placedAfterLinks, 1);
});

test("a stand read behind the mark is a re-timing, not a vehicle reversing", () => {
  // The reading puts a stand at B (held four minutes) while the mark is halfway C to D: the mark
  // keeps its ground instead of jumping back.
  const tripId = "position-stand-behind";
  const running = getSmoothTripPlacement(
    motions,
    departure(tripId, [call("a", 0), call("b", 2), call("c", 4), call("d", 6)]),
    start + 5 * 60_000,
  );
  assert.equal(running?.fromStopId, "c");
  assert.ok(running && running.progress > 0.4);

  const held = getSmoothTripPlacement(
    motions,
    departure(tripId, [
      call("a", 0),
      // On time in, departure four minutes late, carried ahead.
      { ...call("b", 2, 4), arrivalDelayMinutes: 0 },
      call("c", 4),
      call("d", 6),
    ]),
    start + 5 * 60_000 + 1_000,
  );
  assert.equal(held?.motion, "travelled");
  assert.equal(held?.fromStopId, "c");
  assert.ok(held && held.progress >= running.progress);
});

test("lets a finished run go, however often the diagram asks for it", () => {
  // A finished run drops its mark, however often the diagram asks.
  const trip = departure("position-finished", run([call("a", 0), call("b", 5), call("c", 10)]));

  const arriving = getSmoothTripPlacement(motions, trip, start + 9 * 60_000);
  assert.equal(arriving?.phase, "running");

  // Standing at the terminus during its stand…
  for (const minute of [10, 10.5, 11, 11.4]) {
    const standing = getSmoothTripPlacement(motions, trip, start + minute * 60_000);
    assert.equal(standing?.phase, "afterEnd", `at ${minute}`);
    assert.equal(standing?.toStopId, "c");
  }

  // …then gone, whenever the next tick comes.
  for (let tick = 11.6; tick <= 40; tick += 1 / 60) {
    assert.equal(getSmoothTripPlacement(motions, trip, start + tick * 60_000), null);
  }
});

test("a mark held over readings that place nothing is not held for ever", () => {
  // The hold over empty readings is measured from the last reading, not the last drawing, so a
  // reading that stays cut short lets go.
  const calls = [call("a", 0), call("b", 4), call("c", 8), call("d", 12)];
  const placed = getSmoothTripPlacement(
    motions,
    departure("position-held", calls),
    start + 7 * 60_000,
  );
  assert.ok(placed && placed.fromStopId === "b" && placed.progress > 0.74);

  // Cut short of the vehicle, refreshed every second.
  const cut = departure("position-held", calls.slice(0, 3));
  const heldAt = (second: number) =>
    getSmoothTripPlacement(motions, cut, start + 7 * 60_000 + second * 1_000);
  let held: ReturnType<typeof getSmoothTripPlacement> = null;
  for (let second = 1; second <= 150; second += 1) held = heldAt(second);
  assert.ok(held && held.fromStopId === "b", "held while the hold lasts");
  // Two minutes past the last placing reading, gone for good.
  for (let second = 181; second <= 900; second += 1) {
    assert.equal(heldAt(second), null, `still held ${second}s in`);
  }
});

test("a trip that cannot be placed for a moment keeps the ground the mark stood on", () => {
  // A reading with nothing placeable must not make the mark forget its position.
  const calls = [call("a", 0), call("b", 2), call("c", 4), call("d", 6)];
  const trip = departure("position-gap", calls);
  const before = getSmoothTripPlacement(motions, trip, start + 260_000);
  assert.ok(before && before.fromStopId === "c");

  // Nothing for a tick…
  assert.equal(
    getSmoothTripPlacement(motions, departure("position-gap", [calls[0]]), start + 261_000),
    null,
  );
  // …then a reading two minutes behind: the mark holds at C until the reading catches up.
  const behind = departure(
    "position-gap",
    calls.map((tripCall) => ({ ...tripCall, delayMinutes: 2 })),
  );
  const after = getSmoothTripPlacement(motions, behind, start + 262_000);
  assert.equal(after?.motion, "travelled");
  assert.ok(after && getCallDistance(after) > 1.99);
  // Still there half a minute later, then away on the re-timed schedule.
  const holding = getSmoothTripPlacement(motions, behind, start + 370_000);
  assert.ok(holding && getCallDistance(holding) > 1.99);
  const onward = getSmoothTripPlacement(motions, behind, start + 385_000);
  assert.ok(onward && getCallDistance(onward) > 2);
});

test("a board row never re-times its run: every view places one run in one place", () => {
  // Rows from different boards disagree on stop, prediction and clocks; placement reads only the
  // run's calls, so every view puts the vehicle in one place.
  const calls = [call("a", 0), call("b", 2, 1), call("c", 4, 1)];
  const bare = departure("position-one-reading", calls);
  const rows: Departure[] = [
    {
      ...bare,
      boardingLocalStopId: "b",
      predictedDepartureTime: new Date(start + 6 * 60_000).toISOString(),
      delayMinutes: 4,
      readAt: { rowReadAt: start + 2 * 60_000, sequenceReadAt: start },
    },
    {
      ...bare,
      boardingLocalStopId: "c",
      status: "scheduled",
      predictedDepartureTime: undefined,
      delayMinutes: undefined,
      readAt: { rowReadAt: start - 5 * 60_000, sequenceReadAt: start },
    },
  ];

  for (const instant of [start + 30_000, start + 2.5 * 60_000, start + 4.5 * 60_000]) {
    const expected = placementOnly(getSmoothTripPlacement(createRunMotions(), bare, instant));
    for (const row of rows) {
      assert.deepEqual(
        placementOnly(getSmoothTripPlacement(createRunMotions(), row, instant)),
        expected,
      );
    }
  }
});
