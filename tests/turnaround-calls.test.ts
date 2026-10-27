import assert from "node:assert/strict";
import test from "node:test";
import type { Call } from "../src/data/transit-types.ts";
import { collapseTurnaroundCalls } from "../src/lib/calls.ts";

const call = (stopPlaceId: string, overrides: Partial<Call> = {}): Call => ({
  stopName: stopPlaceId.toUpperCase(),
  stopPlaceId,
  timetabledArrivalTime: "2026-09-04T08:00:00+02:00",
  timetabledDepartureTime: "2026-09-04T08:00:30+02:00",
  ...overrides,
});

/** The feed's mark for a run origin: timed out of, never into. */
const datedJourneyStart = (stopPlaceId: string, bayText: string) =>
  call(stopPlaceId, { bayText, timetabledArrivalTime: undefined });

/** The run end: timed into, never out of. */
const datedJourneyEnd = (stopPlaceId: string, bayText: string) =>
  call(stopPlaceId, { bayText, timetabledDepartureTime: undefined });

test("a run's origin and the platform it pulls forward to are one call", () => {
  // Hirtenweg as line 4 reports it: out of `Gleis 3` at 08:46 (no arrival, no boarding), then the
  // public `Gleis 1` call at 08:47. One stop, keeping the public platform and time and the run
  // start.
  const calls = [
    datedJourneyStart("hirtenweg", "Gleis 3"),
    call("hirtenweg", { bayText: "Gleis 1" }),
  ];

  assert.deepEqual(collapseTurnaroundCalls([...calls, call("hauptfriedhof")]), [
    { ...calls[1], timetabledArrivalTime: undefined },
    call("hauptfriedhof"),
  ]);
  // The diagram reverses the trip.
  assert.deepEqual(collapseTurnaroundCalls([...calls].reverse()), [
    { ...calls[1], timetabledArrivalTime: undefined },
  ]);
});

test("a turnaround keeps the passenger arrival and the feed's run-end mark", () => {
  // At a run end the public call comes first; the fold keeps its arrival and the departure the row
  // counts down to.
  const publicArrival = call("rheinstetten", {
    bayText: "Gleis 1",
    arrivalDelayMinutes: 3,
    delayMinutes: 1,
  });
  const collapsed = collapseTurnaroundCalls([
    call("a"),
    publicArrival,
    datedJourneyEnd("rheinstetten", "Gleis 2"),
  ]);

  assert.deepEqual(collapsed, [call("a"), publicArrival]);
  assert.deepEqual(
    collapseTurnaroundCalls([datedJourneyEnd("rheinstetten", "Gleis 2"), publicArrival]),
    [publicArrival],
  );
});

test("a run end the feed states twice keeps the arrival half and its deviation", () => {
  // Both halves end runs: the fold keeps the later call and its arrival deviation.
  const kept = call("rheinstetten", {
    bayText: "Gleis 2",
    timetabledDepartureTime: undefined,
    arrivalDelayMinutes: 2,
  });
  const earlier = call("rheinstetten", {
    bayText: "Gleis 1",
    timetabledDepartureTime: undefined,
  });

  assert.deepEqual(collapseTurnaroundCalls([earlier, kept]), [{ ...kept, delayMinutes: 2 }]);
});

test("a terminus reported at three platforms folds its run-end pair only", () => {
  // Waidweg as line 3 reports a terminating run: loop entry (Gleis 1), the row's public Gleis 3,
  // and the end track Gleis 2. The marked pair folds; the entry point stays.
  const publicCall = call("waidweg", {
    bayText: "Gleis 3",
    isThisCall: true,
    delayMinutes: 0,
  });
  const calls = [
    call("waidweg", { bayText: "Gleis 1" }),
    publicCall,
    datedJourneyEnd("waidweg", "Gleis 2"),
  ];

  assert.deepEqual(collapseTurnaroundCalls(calls), [
    call("waidweg", { bayText: "Gleis 1" }),
    publicCall,
  ]);
});

test("a stop a route really does reach twice keeps both of its calls", () => {
  // Europaplatz's street platforms and Marktplatz's tunnels are real travel, not run boundaries.
  const calls = [
    call("karlstor"),
    call("europaplatz", { bayText: "Gleis 3" }),
    call("europaplatz", { bayText: "Gleis 5" }),
    call("muehlburger-tor"),
  ];

  assert.deepEqual(collapseTurnaroundCalls(calls), calls);
});

test("a sequence with nothing repeated is returned as it stands", () => {
  const calls = [call("a"), call("b"), call("c")];
  assert.deepEqual(collapseTurnaroundCalls(calls), calls);
});
