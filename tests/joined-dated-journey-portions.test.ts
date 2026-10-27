import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import { getJoinedDatedJourneyPortionPairs } from "../src/lib/joined-dated-journey-portions.ts";
import { createStopEvent } from "./support/fixtures.ts";

const start = Date.parse("2026-08-26T12:00:00Z");

function call(stopId: string, minute: number, hasStopEvent = true): Call {
  const time = new Date(start + minute * 60_000).toISOString();
  return {
    stopName: stopId.toUpperCase(),
    stopPlaceId: stopId,
    timetabledArrivalTime: time,
    timetabledDepartureTime: hasStopEvent ? time : undefined,
  };
}

function stopEvent(id: string, destination: string, calls: readonly Call[]): StopEvent {
  return createStopEvent({
    id,
    journeyRef: id,
    datedJourneyId: `${id}@today`,
    publishedJourneyNumber: "85653",
    lineId: "S8",
    ptMode: "lightRail",
    destinationText: destination,
    minutesUntilDeparture: 10,
    bay: "24",
    boardingStopPlaceId: "hauptbahnhof",
    status: "realtime",
    timetabledDepartureTime: new Date(start).toISOString(),
    calls,
  });
}

test("recognises a separately addressed portion that terminates along a shared timed route", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("freudenstadt", 30, false)];
  const terminating = stopEvent("short", "Freudenstadt Hbf", shared);
  const continuing = stopEvent("long", "Bondorf", [
    ...shared.slice(0, -1),
    call("freudenstadt", 30),
    call("eutingen", 40),
    call("bondorf", 50, false),
  ]);

  const [joined] = getJoinedDatedJourneyPortionPairs([terminating, continuing]);

  assert.equal(joined?.terminating, terminating);
  assert.equal(joined?.continuing, continuing);
  assert.equal(joined?.sharedUntil.stopPlaceId, "freudenstadt");
});

test("treats a missing time on one portion as unknown when later shared calls confirm it", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30), call("e", 40)];
  const terminating = stopEvent("short", "E", [
    { ...shared[0], timetabledArrivalTime: undefined, timetabledDepartureTime: undefined },
    ...shared.slice(1),
  ]);
  const continuing = stopEvent("long", "F", [...shared, call("f", 50)]);

  assert.equal(getJoinedDatedJourneyPortionPairs([terminating, continuing]).length, 1);
});

test("uses the shared train number and route when one portion has no valid call times", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const terminating = stopEvent(
    "short",
    "D",
    shared.map((callAtStop) => ({
      ...callAtStop,
      timetabledArrivalTime: undefined,
      timetabledDepartureTime: undefined,
    })),
  );
  const continuing = stopEvent("long", "E", [...shared, call("e", 40)]);

  assert.equal(getJoinedDatedJourneyPortionPairs([terminating, continuing]).length, 1);
});

test("does not infer joining for branches, identical routes or mismatched passage times", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const base = stopEvent("base", "D", shared);

  assert.deepEqual(
    getJoinedDatedJourneyPortionPairs([
      base,
      stopEvent("branch", "E", [...shared.slice(0, -1), call("e", 30), call("f", 40)]),
    ]),
    [],
  );
  assert.deepEqual(
    getJoinedDatedJourneyPortionPairs([base, stopEvent("duplicate", "D", shared)]),
    [],
  );
  assert.deepEqual(
    getJoinedDatedJourneyPortionPairs([
      base,
      stopEvent("later", "E", [...shared.slice(0, -1), call("d", 31), call("e", 40)]),
    ]),
    [],
  );
});

test("does not infer joining without a shared operator train number", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const terminating = stopEvent("short", "D", shared);
  const continuing = stopEvent("long", "E", [...shared, call("e", 40)]);

  assert.deepEqual(
    getJoinedDatedJourneyPortionPairs([
      { ...terminating, publishedJourneyNumber: undefined },
      continuing,
    ]),
    [],
  );
  assert.deepEqual(
    getJoinedDatedJourneyPortionPairs([
      terminating,
      { ...continuing, publishedJourneyNumber: "85654" },
    ]),
    [],
  );
});

test("leaves an ambiguous group of three portions unchanged", () => {
  const shared = [call("a", 0), call("b", 10), call("c", 20), call("d", 30)];
  const stopEvents = [
    stopEvent("short", "D", shared),
    stopEvent("middle", "E", [...shared, call("e", 40)]),
    stopEvent("long", "F", [...shared, call("e", 40), call("f", 50)]),
  ];

  assert.deepEqual(getJoinedDatedJourneyPortionPairs(stopEvents), []);
});
