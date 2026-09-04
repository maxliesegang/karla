import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { getTripPlacement as getSmoothTripPlacement } from "../src/lib/vehicle-positioning.ts";
import { createCall, run } from "./support/calls.ts";

const start = Date.parse("2026-08-23T10:00:00Z");
const call = createCall(start);

function departure(id: string, calls: readonly TripCall[]): Departure {
  return {
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
  };
}

/** How far along a four-stop A-B-C-D chain a placement is, as one number, for readability below. */
const getCallDistance = (placement: { fromStopId: string; progress: number }) =>
  "abcde".indexOf(placement.fromStopId) + placement.progress;

const placementOnly = (placement: ReturnType<typeof getSmoothTripPlacement>) => {
  if (!placement) return placement;
  const position = { ...placement };
  delete position.trajectory;
  return position;
};

test("leaves at the published departure and reaches the next published arrival", () => {
  const trip = departure("position-dwell", [call("a", 0), call("b", 2), call("c", 4)]);

  const departing = getSmoothTripPlacement(trip, start + 19_000);
  assert.ok(departing && departing.progress > 0.15 && departing.progress < 0.17);

  const running = getSmoothTripPlacement(trip, start + 95_000);
  assert.ok(running && running.progress > 0.79 && running.progress < 0.8);
  assert.equal(running?.trajectory?.arrivesAt, start + 2 * 60_000);
});

test("does not traverse a duplicated first stop before leaving it", () => {
  // EFA can combine the detailed sequence's first call with the board row that was read at the
  // same stop. They are two observations of one physical stop, not a link with dwell time.
  const trip = departure("position-duplicate-first-stop", [
    {
      ...call("a", 0),
      scheduledDepartureTime: new Date(start + 36_000).toISOString(),
    },
    { ...call("a", 0), scheduledArrivalTime: undefined, isCurrentStop: true },
    call("b", 1.2),
    call("c", 2.4),
  ]);

  assert.deepEqual(placementOnly(getSmoothTripPlacement(trip, start + 15_000)), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "running",
    motion: "placed",
  });

  const running = getSmoothTripPlacement(trip, start + 55_000);
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

  const crossing = getSmoothTripPlacement(trip, start + 60_000);
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

  const before = getSmoothTripPlacement(original, start + 60_000);
  const after = getSmoothTripPlacement(corrected, start + 61_000);

  assert.equal(before?.fromStopId, "a");
  assert.equal(after?.fromStopId, "c");
  assert.equal(after?.motion, "placed");
  assert.ok(before && after && getCallDistance(after) > getCallDistance(before));
});

test("a backward revision re-times the link instead of moving the mark back", () => {
  // Three minutes are added to the calls ahead while the mark is most of the way to B. The revised
  // trip puts the vehicle barely past A — but the vehicle did not go backwards, and neither does
  // the mark: it keeps the ground it had and spends the re-timed link arriving at B exactly when
  // the revised reading says the vehicle does. It must never creep back towards A, the way an
  // eased retreat did whenever delays kept growing, and never stand at B while the vehicle is
  // minutes away.
  const original = departure("position-backward", [call("a", 0), call("b", 2), call("c", 4)]);
  const corrected = departure("position-backward", [
    call("a", 0),
    call("b", 2, 3),
    call("c", 4, 3),
  ]);

  const before = getSmoothTripPlacement(original, start + 115_000);
  const revised = getSmoothTripPlacement(corrected, start + 116_000);
  const settling = getSmoothTripPlacement(corrected, start + 125_000);
  const running = getSmoothTripPlacement(corrected, start + 135_000);
  const waiting = getSmoothTripPlacement(corrected, start + 250_000);
  const arriving = getSmoothTripPlacement(corrected, start + 299_000);
  const arrived = getSmoothTripPlacement(corrected, start + 301_000);

  assert.ok(before && before.progress > 0.9);
  // The revision costs the mark no ground: travelling on, not placed, and never back.
  assert.equal(revised?.fromStopId, "a");
  assert.equal(revised?.motion, "travelled");
  assert.ok(revised && revised.progress >= before.progress);
  // And no reading of the series leaves it further back than the one before it.
  assert.ok(settling && settling.progress >= revised.progress);
  assert.ok(running && running.progress >= settling.progress);
  // Still short of B long after the old reading would have had it there…
  assert.ok(waiting && waiting.progress < 1);
  // …and arriving on the corrected clock: just short of it at 4:59, standing on it a second past.
  assert.ok(arriving && arriving.progress > 0.95);
  assert.equal(arrived?.fromStopId, "b");
});

test("a delay that keeps growing bends the pace instead of dragging the mark back", () => {
  // The shape that unstitched the eased retreat: every refresh restates the run a minute later
  // than the last, so the reading sits behind the mark again and again. Answering each restatement
  // with a retreat chased a target that kept receding — the mark crept backwards link after link,
  // towards the terminus it had left. Re-timed instead, the mark holds its ground: no reading of
  // the series leaves it further back than the one before it.
  const tripId = "position-growing-delay";
  let shown = getSmoothTripPlacement(
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
    shown = getSmoothTripPlacement(revised, start + 95_000 + minute * 30_000);
    assert.ok(shown);
    assert.equal(shown.motion, "travelled");
    assert.ok(shown.progress >= previous);
    previous = shown.progress;
  }
});

test("a lead built by a receding reading is given back by the tick, never by a fall", () => {
  // The drop a rider sees on a whole diagram at once. A delay is restated a minute later on every
  // refresh and stated ahead of the vehicle, so it is carried back over the calls behind it too
  // (`resolveCallShifts`) and the reading slides back under a mark that is standing still. Nothing
  // contradicts the mark — each restatement moves the reading a fraction of a link — but the lead
  // ratchets up, and read as a contradiction the moment it crossed the band it hauled the mark
  // more than two calls back in a single frame. A refresh restates a whole board together, so
  // every mark that had built a lead fell at the same moment, which is a diagram dropping its
  // vehicles down the line in unison. Held to the band instead, the mark gives the ground back a
  // tick at a time: no frame of the series moves it back by any visible part of a link, and none
  // of them places it.
  const stops = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // A run of eight calls a minute apart, already six minutes under way, monitored from E on.
  const reading = (delayMinutes: number) =>
    departure(
      "position-receding-reading",
      run(stops.map((stopId, index) => call(stopId, index - 6, index >= 4 ? delayMinutes : 0))),
    );

  // The same reading placed with no history behind it: where a mark that had just been snapped to
  // this reading would stand, so the lead the smoothed mark is carrying can be read off the pair.
  const readingAlone = (delayMinutes: number, at: number, tick: number) =>
    getSmoothTripPlacement(
      { ...reading(delayMinutes), id: `alone-${tick}`, tripId: `alone-${tick}` },
      at,
    );

  let previous: number | null = null;
  let leadReachedBand = false;
  for (let tick = 0; tick <= 600; tick += 1) {
    const at = start + tick * 1_000;
    const delayMinutes = Math.floor(tick / 30);
    const shown = getSmoothTripPlacement(reading(delayMinutes), at);
    const read = readingAlone(delayMinutes, at, tick);
    assert.ok(shown && read, `no mark at ${tick}s`);
    // The first paint is a placement by definition; every tick after it is the mark travelling.
    if (tick > 0) assert.equal(shown.motion, "travelled", `placed at ${tick}s`);
    const distance = stops.indexOf(shown.fromStopId) + shown.progress;
    leadReachedBand ||= distance - (stops.indexOf(read.fromStopId) + read.progress) > 1.9;
    // Half a link is the measure that matters: the ground a refresh's own restatement moves the
    // reading is a fraction of one, and the fall this test exists for was better than two whole
    // calls. Nothing in between is a shape either side of the fix produces.
    if (previous !== null) {
      assert.ok(previous - distance < 0.5, `fell ${previous - distance} calls at ${tick}s`);
    }
    previous = distance;
  }
  // …and the series really did drive the lead into the band the mark used to fall out of.
  assert.ok(leadReachedBand);
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
  // Away at B's shifted departure, with ninety seconds of the two-minute link covered.
  assert.ok(placement && placement.progress > 0.24 && placement.progress < 0.26);
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
  assert.ok(running && running.progress > 0.39 && running.progress < 0.41);

  // Standing at B through the layover it recovers in, and away on the published departure minute.
  const standing = getSmoothTripPlacement(trip, start + 9.5 * 60_000);
  assert.deepEqual(placementOnly(standing), {
    fromStopId: "b",
    toStopId: "c",
    progress: 0,
    phase: "running",
    motion: "placed",
  });
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

  assert.deepEqual(placementOnly(getSmoothTripPlacement(trip, start + 3 * 60_000)), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "running",
    motion: "placed",
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
  assert.deepEqual(
    placementOnly(getSmoothTripPlacement({ ...trip, id: "row-ahead" }, start + 2 * 60_000)),
    {
      fromStopId: "a",
      toStopId: "b",
      progress: 0,
      phase: "running",
      motion: "placed",
    },
  );

  // Long past it: the stale row must not push B and C three minutes down the line with it.
  const placement = getSmoothTripPlacement({ ...trip, id: "row-behind" }, start + 6 * 60_000);
  assert.equal(placement?.fromStopId, "b");
  assert.ok(placement && placement.progress > 0.4 && placement.progress < 0.6);
});

test("stands a monitored trip at the terminus it is due out of, once its turnaround is nearly over", () => {
  const trip = departure("position-before-start", run([call("a", 0), call("b", 2), call("c", 4)]));

  // Four minutes before it is due away: the mark stands on its first call, and says so.
  assert.deepEqual(placementOnly(getSmoothTripPlacement(trip, start - 4 * 60_000)), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });

  // Further out than the turnaround it is drawn for, there is nothing to show at that stop yet.
  assert.equal(
    getSmoothTripPlacement({ ...trip, id: "position-long-before-start" }, start - 12 * 60_000),
    null,
  );
});

test("a waiting mark stays at its terminus while the sequence around it is re-timed", () => {
  // A run that has not begun is standing at the stop it is due out of, and a refresh that re-times
  // the sequence — a deviation stated four calls down the line, carried back over the rest — says
  // nothing to the contrary. Re-planning the current link from the ground the mark has covered is
  // the right answer for a vehicle under way and an invented departure for one still at its stop:
  // it set the waiting mark off down the first link minutes before its vehicle left, and every
  // further refresh re-planned it from further along, so a terminus scrolled out of view had its
  // tram halfway down the diagram before it had moved at all.
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

  const waiting = getSmoothTripPlacement(reading(0), start - 5 * 60_000);
  assert.equal(waiting?.phase, "beforeStart");

  for (const minutesOut of [4, 3, 2, 1]) {
    const held = getSmoothTripPlacement(reading(minutesOut % 2), start - minutesOut * 60_000);
    assert.deepEqual(placementOnly(held), {
      fromStopId: "a",
      toStopId: "b",
      progress: 0,
      phase: "beforeStart",
      motion: "travelled",
    });
  }

  // And it leaves when its own departure says so, not before.
  const leaving = getSmoothTripPlacement(reading(0), start + 60_000);
  assert.equal(leaving?.phase, "running");
  assert.ok(leaving && leaving.progress > 0.19 && leaving.progress < 0.21);
});

test("draws no waiting mark for a run the feed is not watching", () => {
  // Nothing here is monitored: a scheduled row and calls the feed states no deviation for. That is
  // a line in a timetable, not evidence of a vehicle standing at the terminus.
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

  assert.equal(getSmoothTripPlacement(trip, start - 2 * 60_000), null);
});

test("keeps a finished trip standing at its final call before letting the mark go", () => {
  const calls = run([call("a", 0), call("b", 2), call("c", 4)]);

  assert.deepEqual(
    placementOnly(
      getSmoothTripPlacement(departure("position-arrived", calls), start + 4.5 * 60_000),
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
    getSmoothTripPlacement(departure("position-arrived-gone", calls), start + 6 * 60_000),
    null,
  );
});

test("draws no stand at either end of a reading that stops short of the run", () => {
  // Every call here is timed at both ends, which is what a sequence looks like where the vehicle
  // goes on past it: the feed marks the call it terminates at by publishing no departure for it.
  // Neither end of such a reading is an end of the line, so neither may carry a standing mark.
  const cut = departure("position-cut-sequence", [call("a", 0), call("b", 2), call("c", 4)]);

  assert.equal(getSmoothTripPlacement(cut, start - 4 * 60_000), null);
  assert.equal(
    getSmoothTripPlacement({ ...cut, id: "position-cut-sequence-end" }, start + 4.5 * 60_000),
    null,
  );
});

test("a stand at the stop a run starts from is drawn there, not where the mark last stood", () => {
  const calls = run([call("a", 0), call("b", 10), call("c", 20), call("d", 30)]);
  const trip = departure("position-turnaround-stand", calls);

  // The mark has travelled: the reading in hand puts the vehicle two calls along.
  const running = getSmoothTripPlacement(trip, start + 21 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  // A revision puts the whole run forty minutes later, so the trip has not started at all. The
  // turnaround it stands out of says the stand began twenty minutes in, so it is drawn standing —
  // and the only stop it can be standing at is the one its run starts from.
  const delayed = departure(
    "position-turnaround-stand",
    calls.map((tripCall) => ({ ...tripCall, delayMinutes: 40 })),
  );
  const standing = getSmoothTripPlacement(delayed, start + 22 * 60_000, start + 20 * 60_000);

  assert.deepEqual(placementOnly(standing), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });
});

test("a revision that re-times a run's origin does not un-start a run the mark has left", () => {
  // The feed monitors the calls near the vehicle and says nothing about the ones behind it, so a
  // deviation stated ahead is carried back over the earlier calls too (`resolveCallShifts`). Four
  // minutes stated ahead of a vehicle that set out ten minutes ago therefore re-time its origin
  // four minutes later — and the run still reads as one that has begun. The mark is neither hauled
  // back to the stop the run starts from nor snapped to the reading's own position for the vehicle:
  // it keeps the ground it had and re-times the link it is on, which is within a call of where the
  // reading now puts the vehicle.
  const calls = run([call("a", 0), call("b", 4), call("c", 8), call("d", 12), call("e", 16)]);
  const trip = departure("position-unstarted", calls);

  const running = getSmoothTripPlacement(trip, start + 10 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  const revised = departure(
    "position-unstarted",
    calls.map((tripCall) => ({ ...tripCall, delayMinutes: 4 })),
  );
  const after = getSmoothTripPlacement(revised, start + 10 * 60_000 + 1_000);

  assert.equal(after?.phase, "running");
  // Still where it was, or a little further on. Never back at the stop the run starts from.
  assert.ok(after && ["c", "d"].includes(after.fromStopId));
});

test("a delay that overtakes the mark re-times the link it is on instead of hauling it back", () => {
  // Twelve minutes stated ahead of a mark drawn on the on-time reading: the reading now puts the
  // vehicle on the first link, a call and a half behind where the mark was running. The vehicle
  // did not go backwards, and neither does the mark: it keeps the ground it had, leads the newer
  // estimate by less than the band allows, and the two meet at D — the mark arriving there exactly
  // when the re-timed reading says the vehicle does, not when the optimistic one did.
  const calls = run([call("a", 0), call("b", 10), call("c", 20), call("d", 30)]);
  const trip = departure("position-replaced", calls);

  const running = getSmoothTripPlacement(trip, start + 21 * 60_000);
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
  const holding = getSmoothTripPlacement(revised, start + 21 * 60_000 + 1_000);
  assert.equal(holding?.motion, "travelled");
  assert.ok(holding && getCallDistance(holding) > 2 && getCallDistance(holding) < 2.2);

  // Read every hundred seconds from there — inside the freshness window, so every reading is the
  // mark travelling on, and no reading of the series leaves it further back than the one before.
  let previous = getCallDistance(holding);
  for (let at = 22 * 60_000; at <= 41 * 60_000; at += 100_000) {
    const shown = getSmoothTripPlacement(revised, start + at);
    assert.ok(shown);
    assert.equal(shown.motion, "travelled");
    assert.ok(getCallDistance(shown) >= previous);
    previous = getCallDistance(shown);
  }
  // And it comes into D on the corrected reading's clock: half a minute short of it, the mark is
  // all but there.
  const arriving = getSmoothTripPlacement(revised, start + 41 * 60_000 + 50_000);
  assert.ok(arriving && getCallDistance(arriving) > 2.9);
});

test("a carried delay several calls behind does not reverse a departed mark", () => {
  // The monitored calls ahead have acquired six minutes, but the call the vehicle last left has no
  // direct observation saying it is still there. Moving the mark back would turn a carried delay
  // into evidence about a platform it was not read at, so the existing link is re-timed instead.
  const calls = run([call("a", 0), call("b", 2), call("c", 4), call("d", 6), call("e", 8)]);
  const trip = departure("position-contradicted", calls);

  const running = getSmoothTripPlacement(trip, start + 7 * 60_000);
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
  const placed = getSmoothTripPlacement(revised, start + 7 * 60_000 + 1_000);

  assert.equal(placed?.motion, "travelled");
  assert.equal(placed?.fromStopId, "d");
});

test("a departure re-stated later brings a departed mark back to the terminus it left from", () => {
  // The vehicle is still standing where the run starts from: the feed has re-stated its monitored
  // origin twenty-five minutes down. The mark had already been drawn running on the earlier,
  // optimistic reading — and the terminus is where the vehicle in fact is, so that is where the
  // mark goes, to stand there with the pause icon until the run actually begins.
  const calls = run([call("a", 0), call("b", 10), call("c", 20), call("d", 30)]);
  const trip = departure("position-origin-restated", calls);

  const running = getSmoothTripPlacement(trip, start + 21 * 60_000);
  assert.equal(running?.phase, "running");
  assert.equal(running?.fromStopId, "c");

  const held = departure(
    "position-origin-restated",
    run([call("a", 0, 25), call("b", 10, 25), call("c", 20, 25), call("d", 30, 25)]),
  );
  const standing = getSmoothTripPlacement(held, start + 21 * 60_000 + 1_000);

  assert.deepEqual(placementOnly(standing), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });
});

test("a row that disagrees by less than a minute with its sequence is rounding, not a correction", () => {
  // The row publishes its times to the minute and the sequence to the second, so the same on-time
  // departure reads 09:14 on one and 09:14:48 on the other. Taken as a correction the row pulled
  // the departure back before the vehicle was due out and ran the mark early; read as rounding it
  // moves nothing.
  const trip = {
    ...departure("position-row-rounding", run([call("a", 0), call("b", 2), call("c", 4)])),
    predictedDepartureTime: new Date(start - 48_000).toISOString(),
  };

  assert.deepEqual(placementOnly(getSmoothTripPlacement(trip, start - 30_000)), {
    fromStopId: "a",
    toStopId: "b",
    progress: 0,
    phase: "beforeStart",
    motion: "placed",
  });
});

test("lets a finished run go, however often the diagram asks for it", () => {
  // A run that is over is a statement, not a silence: the vehicle it was drawn for is off the line.
  // Held as though the reading were merely unplaceable — which is how every empty reading was read
  // — the mark stood at the stop the trip ended at for as long as a board kept listing that trip,
  // and the guard meant to bound that could never fire: it measured the gap since the mark was last
  // *drawn*, and a diagram redrawing every second closes that gap with the very tick that widens it.
  const trip = departure("position-finished", run([call("a", 0), call("b", 5), call("c", 10)]));

  const arriving = getSmoothTripPlacement(trip, start + 9 * 60_000);
  assert.equal(arriving?.phase, "running");

  // Standing at the terminus it has reached, for the stand its final call is held for…
  for (const minute of [10, 10.5, 11, 11.4]) {
    const standing = getSmoothTripPlacement(trip, start + minute * 60_000);
    assert.equal(standing?.phase, "afterEnd", `at ${minute}`);
    assert.equal(standing?.toStopId, "c");
  }

  // …and gone once it is over, whether the next tick comes a second or an hour later.
  for (let tick = 11.6; tick <= 40; tick += 1 / 60) {
    assert.equal(getSmoothTripPlacement(trip, start + tick * 60_000), null);
  }
});

test("a mark held over readings that place nothing is not held for ever", () => {
  // The hold below is for a refresh or two of nothing placeable. Measured against the last drawing
  // it never expired at all — a diagram redrawing every second closes that gap with the very tick
  // that widens it — so a sequence that stayed cut short left its mark parked mid-route for as long
  // as the trip was offered. Measured against the last reading of the trip, it lets go.
  const calls = [call("a", 0), call("b", 4), call("c", 8), call("d", 12)];
  const placed = getSmoothTripPlacement(departure("position-held", calls), start + 7 * 60_000);
  assert.ok(placed && placed.fromStopId === "b" && placed.progress > 0.74);

  // A reading cut short of the vehicle, refreshed every second and never catching up with it.
  const cut = departure("position-held", calls.slice(0, 3));
  const heldAt = (second: number) =>
    getSmoothTripPlacement(cut, start + 7 * 60_000 + second * 1_000);
  let held: ReturnType<typeof getSmoothTripPlacement> = null;
  for (let second = 1; second <= 150; second += 1) held = heldAt(second);
  assert.ok(held && held.fromStopId === "b", "held while the hold lasts");
  // Two minutes past the last reading that placed anything, the mark is gone — and stays gone,
  // however long the cut reading keeps arriving.
  for (let second = 181; second <= 900; second += 1) {
    assert.equal(heldAt(second), null, `still held ${second}s in`);
  }
});

test("a trip that cannot be placed for a moment keeps the ground the mark stood on", () => {
  // A board refresh can hand over a reading with nothing placeable in it — one call, no times, a
  // sequence trimmed past the vehicle. Forgetting the mark's position over that gap is what let it
  // come back behind itself and travel down the track to where it already was.
  const calls = [call("a", 0), call("b", 2), call("c", 4), call("d", 6)];
  const trip = departure("position-gap", calls);
  const before = getSmoothTripPlacement(trip, start + 260_000);
  assert.ok(before && before.fromStopId === "c");

  // Nothing to draw for a tick…
  assert.equal(
    getSmoothTripPlacement(departure("position-gap", [calls[0]]), start + 261_000),
    null,
  );
  // …and then a reading two minutes behind the one before it. The mark is standing at C, and the
  // reading has the vehicle back between B and C — but the mark holds the call it was standing at
  // and lets the reading come up to it, rather than easing back down the link it had arrived on.
  const behind = departure(
    "position-gap",
    calls.map((tripCall) => ({ ...tripCall, delayMinutes: 2 })),
  );
  const after = getSmoothTripPlacement(behind, start + 262_000);
  assert.equal(after?.motion, "travelled");
  assert.ok(after && getCallDistance(after) > 1.99);
  // Still there half a minute later — the hold is not a pause on the way back — and away on the
  // re-timed schedule once the reading has come up to the call.
  const holding = getSmoothTripPlacement(behind, start + 370_000);
  assert.ok(holding && getCallDistance(holding) > 1.99);
  const onward = getSmoothTripPlacement(behind, start + 385_000);
  assert.ok(onward && getCallDistance(onward) > 2);
});
