import assert from "node:assert/strict";
import test from "node:test";
import type { TripCall } from "../src/data/transit-types.ts";
import { collapseTurnaroundCalls } from "../src/lib/trip-calls.ts";

const call = (localStopId: string, overrides: Partial<TripCall> = {}): TripCall => ({
  stopName: localStopId.toUpperCase(),
  localStopId,
  scheduledArrivalTime: "2026-09-04T08:00:00+02:00",
  scheduledDepartureTime: "2026-09-04T08:00:30+02:00",
  ...overrides,
});

/** The feed's own mark for the origin of a run: timed out of, never into. */
const runStart = (localStopId: string, platformLabel: string) =>
  call(localStopId, { platformLabel, scheduledArrivalTime: undefined });

/** And the other end of the same statement: timed into, never out of. */
const runEnd = (localStopId: string, platformLabel: string) =>
  call(localStopId, { platformLabel, scheduledDepartureTime: undefined });

test("a run's origin and the platform it pulls forward to are one call", () => {
  // Hirtenweg/Technologiepark, as line 4 to Oberreut really reports it: `Gleis 3` timed out of at
  // 08:46 with no arrival and no boarding, then the public `Gleis 1` call at 08:47. One stop of the
  // passenger route, carrying the public platform and time while still stating that the run starts.
  const calls = [runStart("hirtenweg", "Gleis 3"), call("hirtenweg", { platformLabel: "Gleis 1" })];

  assert.deepEqual(collapseTurnaroundCalls([...calls, call("hauptfriedhof")]), [
    { ...calls[1], scheduledArrivalTime: undefined },
    call("hauptfriedhof"),
  ]);
  // The diagram reads toward the destination from top to bottom and therefore reverses the trip.
  assert.deepEqual(collapseTurnaroundCalls([...calls].reverse()), [
    { ...calls[1], scheduledArrivalTime: undefined },
  ]);
});

test("a turnaround keeps the passenger arrival and the feed's run-end mark", () => {
  // The public call is the first half at a run end; the turning track follows it. Folding the pair
  // keeps that platform with everything the feed timed for it — the arrival, and the departure
  // that is the published end the row beside the diagram counts down to.
  const publicArrival = call("rheinstetten", {
    platformLabel: "Gleis 1",
    arrivalDelayMinutes: 3,
    delayMinutes: 1,
  });
  const collapsed = collapseTurnaroundCalls([
    call("a"),
    publicArrival,
    runEnd("rheinstetten", "Gleis 2"),
  ]);

  assert.deepEqual(collapsed, [call("a"), publicArrival]);
  assert.deepEqual(collapseTurnaroundCalls([runEnd("rheinstetten", "Gleis 2"), publicArrival]), [
    publicArrival,
  ]);
});

test("a run end the feed states twice keeps the arrival half and its deviation", () => {
  // Both halves timed into and out of nothing: the fold keeps the later call, whose arrival is
  // the headline, and states beside it the deviation that arrival was read with.
  const kept = call("rheinstetten", {
    platformLabel: "Gleis 2",
    scheduledDepartureTime: undefined,
    arrivalDelayMinutes: 2,
  });
  const earlier = call("rheinstetten", {
    platformLabel: "Gleis 1",
    scheduledDepartureTime: undefined,
  });

  assert.deepEqual(collapseTurnaroundCalls([earlier, kept]), [{ ...kept, delayMinutes: 2 }]);
});

test("a terminus reported at three platforms folds its run-end pair only", () => {
  // Waidweg, as line 3 reports a terminating run: the loop's entry point (Gleis 1), the public
  // Gleis 3 — the row's own call — and the Gleis 2 track the feed says the run ends on. The pair
  // the feed itself marks folds to one call, kept whole; the entry point keeps its place beside
  // it, exactly as Europaplatz's two street platforms do.
  const publicCall = call("waidweg", {
    platformLabel: "Gleis 3",
    isCurrentStop: true,
    delayMinutes: 0,
  });
  const calls = [
    call("waidweg", { platformLabel: "Gleis 1" }),
    publicCall,
    runEnd("waidweg", "Gleis 2"),
  ];

  assert.deepEqual(collapseTurnaroundCalls(calls), [
    call("waidweg", { platformLabel: "Gleis 1" }),
    publicCall,
  ]);
});

test("a stop a route really does reach twice keeps both of its calls", () => {
  // Europaplatz's two street platforms are a minute of driving apart, and Marktplatz's two tunnels
  // are two hundred metres. Neither pair is a run boundary, and folding either takes a link a rider
  // rides off the diagram.
  const calls = [
    call("karlstor"),
    call("europaplatz", { platformLabel: "Gleis 3" }),
    call("europaplatz", { platformLabel: "Gleis 5" }),
    call("muehlburger-tor"),
  ];

  assert.deepEqual(collapseTurnaroundCalls(calls), calls);
});

test("a sequence with nothing repeated is returned as it stands", () => {
  const calls = [call("a"), call("b"), call("c")];
  assert.deepEqual(collapseTurnaroundCalls(calls), calls);
});
