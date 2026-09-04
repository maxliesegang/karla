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
  // must keep that platform and its arrival while retaining the missing departure as the boundary.
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

  assert.deepEqual(collapsed, [
    call("a"),
    call("rheinstetten", {
      platformLabel: "Gleis 1",
      scheduledDepartureTime: undefined,
      delayMinutes: 3,
    }),
  ]);
  assert.deepEqual(collapseTurnaroundCalls([runEnd("rheinstetten", "Gleis 2"), publicArrival]), [
    call("rheinstetten", {
      platformLabel: "Gleis 1",
      scheduledDepartureTime: undefined,
      delayMinutes: 3,
    }),
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
