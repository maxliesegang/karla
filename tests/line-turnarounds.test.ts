import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { findTurnarounds } from "../src/lib/line-turnarounds.ts";
import {
  buildLineDiagramStops,
  getLineDiagramVehicles,
  getVehicleRowCoordinate,
} from "../src/lib/line-diagram.ts";
import type { TransitNetwork } from "../src/data/transit-types.ts";
import { createCall, run } from "./support/calls.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import { createDeparture } from "./support/fixtures.ts";

/** One drawing's motion record, shared across this file. */
const motions = createRunMotions();

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);

function departure(id: string, lineId: string, calls: readonly TripCall[]): Departure {
  const runCalls = run(calls);
  return createDeparture({
    id,
    tripId: id,
    tripInstanceId: `${id}@today`,
    lineId,
    destination: calls[calls.length - 1].stopName,
    boardingLocalStopId: calls[0].localStopId ?? "a",
    scheduledDepartureTime: calls[0].scheduledDepartureTime ?? new Date(start).toISOString(),
    tripCalls: runCalls,
  });
}

test("pairs an arrival with the departure that turns out of it, once", () => {
  const arriving = departure("in", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  // Two candidates out of C: one four minutes after the arrival, one twenty-five minutes after.
  const turning = departure("out-soon", "2", [call("c", 12), call("b", 16), call("a", 20)]);
  const later = departure("out-later", "2", [call("c", 33), call("b", 37), call("a", 41)]);

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    turning,
    later,
  ]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in@today", "out-soon@today"]]);
  assert.deepEqual(
    [...standFromByDepartureKey],
    [["out-soon@today", start + 8 * 60_000]],
    "the stand begins when the arrival is due in, and only the nearest departure claims it",
  );
});

test("draws an arrival and a same-instant departure as the two vehicles they are", () => {
  // A departure at the arrival's own instant is two vehicles crossing, not a turn.
  const network: TransitNetwork = {
    stops: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 4), call("c", 8)]);
  const arriving = departure("in-immediate", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const turning = departure("out-immediate", "2", [call("c", 8), call("b", 12), call("a", 16)]);
  const turnaroundIndex = findTurnarounds([arriving, turning]);

  assert.equal(turnaroundIndex.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(turnaroundIndex.standFromByDepartureKey.size, 0);

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 8 * 60_000,
    { motions, turnaroundIndex },
  );

  assert.deepEqual(vehicles.map(({ departure }) => departure.id).sort(), [
    "in-immediate",
    "out-immediate",
  ]);
});

test("a turn timed at the arrival's own instant is not handed on to the next departure", () => {
  // Line 1 at Wolfartsweier Nord: a tram in and out on the same second, every ten minutes. No stand
  // is drawn, and the arrival must not pair with the following departure instead.
  const arriving = departure("in-instant", "1", [call("a", 0), call("b", 4), call("c", 8)]);
  const straightBackOut = departure("out-instant", "1", [
    call("c", 8),
    call("b", 12),
    call("a", 16),
  ]);
  const following = departure("out-following", "1", [call("c", 18), call("b", 22), call("a", 26)]);

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    straightBackOut,
    following,
  ]);

  assert.equal(turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(
    standFromByDepartureKey.size,
    0,
    "the departure ten minutes later gets no stand from an arrival that had already left",
  );
});

test("never pairs across a line, a stop, or a departure that has already gone", () => {
  const arriving = departure("in", "2", [call("a", 0), call("c", 8)]);
  const otherLine = departure("other-line", "5", [call("c", 11), call("a", 19)]);
  const otherStop = departure("other-stop", "2", [call("b", 11), call("a", 19)]);
  // A departure before the arrival is due is the working ahead.
  const before = departure("before", "2", [call("c", 6), call("a", 14)]);

  const index = findTurnarounds([arriving, otherLine, otherStop, before]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("never pairs across a whole headway of the line's own service", () => {
  // A ten-minute service out of C: a twelve-minute stand is the next vehicle's turn.
  const arriving = departure("in", "3", [call("a", -8), call("b", -4), call("c", 0)]);
  const starts = [12, 22, 32].map((minute) =>
    departure(`out-${minute}`, "3", [
      call("c", minute),
      call("b", minute + 4),
      call("a", minute + 8),
    ]),
  );

  const index = findTurnarounds([arriving, ...starts]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("pairs a turn longer than the tightest takt where the line's own headway allows it", () => {
  // Line 1 stands eleven minutes at Neureut-Heide on a twenty-minute evening service; the headway
  // allows it.
  const arriving = departure("in-heide", "1", [call("a", -20), call("b", -10), call("c", 0)]);
  const starts = [11, 31, 51].map((minute) =>
    departure(`out-${minute}`, "1", [
      call("c", minute),
      call("b", minute + 10),
      call("a", minute + 20),
    ]),
  );

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    ...starts,
  ]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in-heide@today", "out-11@today"]]);
  assert.equal(standFromByDepartureKey.get("out-11@today"), start);
});

test("never stands a vehicle for most of a sparse evening headway", () => {
  // Every 25 minutes: the stand is capped well below the gap.
  const starts = [0, 25, 50].map((minute) =>
    departure(`out-${minute}`, "4", [
      call("c", minute),
      call("b", minute + 6),
      call("a", minute + 12),
    ]),
  );
  const tooLongBefore = departure("in-21", "4", [call("a", -33), call("b", -27), call("c", -21)]);
  const withinCap = departure("in-19", "4", [call("a", -31), call("b", -25), call("c", -19)]);

  assert.equal(
    findTurnarounds([tooLongBefore, ...starts]).standFromByDepartureKey.size,
    0,
    "twenty-one minutes standing is past what this will claim",
  );
  assert.deepEqual(
    [...findTurnarounds([withinCap, ...starts]).turningDepartureKeyByArrivalKey],
    [["in-19@today", "out-0@today"]],
  );
});

test("pairs the arrivals in the order they come in rather than by the shortest stand", () => {
  // Two in, two out: pairing shortest-stand-first would cross the pairings.
  const first = departure("in-first", "3", [call("a", -8), call("b", -4), call("c", 0)]);
  const second = departure("in-second", "3", [call("a", -2), call("b", 2), call("c", 6)]);
  const soon = departure("out-soon", "3", [call("c", 8), call("b", 12), call("a", 16)]);
  const later = departure("out-later", "3", [call("c", 18), call("b", 22), call("a", 26)]);

  const { turningDepartureKeyByArrivalKey } = findTurnarounds([first, second, soon, later]);

  assert.deepEqual(
    [...turningDepartureKeyByArrivalKey],
    [["in-first@today", "out-soon@today"]],
    "the tram that arrived first takes the departure in front of it, and the second waits",
  );
});

test("pairs on the published times, so a late run does not re-pair the terminus around it", () => {
  // Five minutes late, the arrival lands after its departure's scheduled time; the pairing is by
  // plan and holds, only the drawn stand moves.
  const arriving = departure("in-late", "2", [call("a", 0), call("b", 4), call("c", 8, 5)]);
  const turning = departure("out-late", "2", [call("c", 12), call("b", 16), call("a", 20)]);

  const { turningDepartureKeyByArrivalKey, standFromByDepartureKey } = findTurnarounds([
    arriving,
    turning,
  ]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in-late@today", "out-late@today"]]);
  assert.equal(
    standFromByDepartureKey.get("out-late@today"),
    start + 13 * 60_000,
    "the stand begins when the vehicle is really expected in, not when the plan said",
  );
});

test("draws a turnaround as one standing mark rather than an arrival beside a departure", () => {
  const network: TransitNetwork = {
    stops: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 4), call("c", 8)]);
  const arriving = departure("in", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const turning = departure("out", "2", [call("c", 14), call("b", 18), call("a", 22)]);

  const [approaching] = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 7 * 60_000,
    { motions },
  );
  assert.equal(approaching.departure.id, "in");

  // Nine minutes in: the arrival is due at C, the departure six minutes away.
  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 9 * 60_000,
    { motions },
  );

  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].departure.id, "out");
  assert.equal(
    vehicles[0].markerKey,
    approaching.markerKey,
    "the arriving mark keeps its identity when the outbound run takes it over",
  );
  assert.equal(vehicles[0].phase, "beforeStart");
  assert.equal(vehicles[0].directionArrow, "↑");
  const terminusIndex = diagramStops.findIndex(({ stopId }) => stopId === "c");
  assert.equal(
    getVehicleRowCoordinate(vehicles[0]),
    terminusIndex,
    "the turnaround mark is placed on the terminus, not on an intermediate link",
  );
  assert.equal(vehicles[0].rowIndex, terminusIndex, "the terminus row owns the standing mark");
});

test("stands a paired departure at its terminus for the whole of a long turnaround", () => {
  const arriving = departure("in-long", "2", [call("a", 0), call("c", 8)]);
  // Ten minutes standing: longer than a lone trip is drawn.
  const turning = departure("out-long", "2", [call("c", 18), call("a", 26)]);
  const { standFromByDepartureKey } = findTurnarounds([arriving, turning]);

  assert.equal(standFromByDepartureKey.get("out-long@today"), start + 8 * 60_000);
});

test("keeps the arriving mark when the departure it turns into cannot be drawn here", () => {
  const network: TransitNetwork = {
    stops: ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase() })),
    lines: [],
  };
  const diagramStops = buildLineDiagramStops(network, [call("a", 0), call("b", 4), call("c", 8)]);
  const arriving = departure("in-offdiagram", "2", [
    call("d", -2),
    call("a", 0),
    call("b", 4),
    call("c", 8),
  ]);
  // The departure goes back over a stop this diagram does not draw, so the arrival stays shown.
  const turning = departure("out-offdiagram", "2", [call("c", 12), call("d", 16)]);

  const vehicles = getLineDiagramVehicles(
    diagramStops,
    [arriving, turning],
    [],
    undefined,
    start + 9 * 60_000,
    { motions },
  );

  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].departure.id, "in-offdiagram");
  assert.equal(vehicles[0].phase, "afterEnd");
});

test("never pairs at a stop where neither run actually ends", () => {
  // Timed at both ends everywhere: C is passed through, not a terminus.
  const passing = (id: string, calls: readonly TripCall[]): Departure =>
    createDeparture({
      ...departure(id, "2", calls),
      tripCalls: calls,
    });
  const arriving = passing("in-passing", [call("a", 0), call("b", 4), call("c", 8)]);
  const leaving = passing("out-passing", [call("c", 12), call("b", 16), call("a", 20)]);

  const index = findTurnarounds([arriving, leaving]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("never pairs a run that ends with one that carries on the same way", () => {
  // A run leaving C outwards, over ground the arrival never covered, is not a turn.
  const arriving = departure("in-short", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const onwards = departure("out-onwards", "2", [call("c", 12), call("d", 16), call("e", 20)]);

  const index = findTurnarounds([arriving, onwards]);

  assert.equal(index.turningDepartureKeyByArrivalKey.size, 0);
  assert.equal(index.standFromByDepartureKey.size, 0);
});

test("pairs a vehicle that turns through a terminus loop rather than backing out of a stub", () => {
  // A balloon loop rejoins the line a stop along; it still turned.
  const arriving = departure("in-loop", "2", [call("a", 0), call("b", 4), call("c", 8)]);
  const turning = departure("out-loop", "2", [call("c", 12), call("loop", 13), call("b", 16)]);

  const { turningDepartureKeyByArrivalKey } = findTurnarounds([arriving, turning]);

  assert.deepEqual([...turningDepartureKeyByArrivalKey], [["in-loop@today", "out-loop@today"]]);
});

const terminusNetwork: TransitNetwork = {
  stops: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase() })),
  lines: [],
};
const terminusDiagram = () =>
  buildLineDiagramStops(terminusNetwork, [call("a", 0), call("b", 4), call("c", 8)]);

test("draws one mark where an arrival and a waiting departure share a terminus unpaired", () => {
  // Forty seconds is too quick to pair, so both stand at C; the arrival wins the platform.
  const arriving = departure("in-unpaired", "3", [call("a", 0), call("b", 4), call("c", 8)]);
  const waiting = departure("out-unpaired", "3", [call("c", 8.7), call("b", 12), call("a", 16)]);

  assert.equal(
    findTurnarounds([arriving, waiting]).standFromByDepartureKey.size,
    0,
    "nothing turns a tram around in forty seconds, so no stand is inferred",
  );

  const vehicles = getLineDiagramVehicles(
    terminusDiagram(),
    [arriving, waiting],
    [],
    undefined,
    start + 8.5 * 60_000,
    { motions },
  );

  assert.deepEqual(
    vehicles.map(({ departure: { id }, phase }) => [id, phase]),
    [["in-unpaired", "afterEnd"]],
    "the waiting mark stands down while a run is still ending at the same stop",
  );
});

test("draws no waiting mark at a terminus the vehicle has not reached yet", () => {
  // The instant turn at Wolfartsweier Nord: nothing stands there in the lead before it.
  const arriving = departure("in-instant-lead", "3", [call("a", 0), call("b", 4), call("c", 10)]);
  const waiting = departure("out-instant-lead", "3", [
    call("c", 10.5),
    call("b", 14),
    call("a", 18),
  ]);

  const vehicles = getLineDiagramVehicles(
    terminusDiagram(),
    [arriving, waiting],
    [],
    undefined,
    start + 5 * 60_000,
    { motions },
  );

  assert.deepEqual(
    vehicles.map(({ departure: { id } }) => id),
    ["in-instant-lead"],
    "only the tram still running towards the terminus is drawn",
  );
});

test("stands a lone waiting trip at its terminus for the whole of a long turn", () => {
  // Line 3 turns at Forststraße on eleven minutes. With one departure caught the headway is
  // unknown, so no pairing; the outgoing trip's own lead covers the turn.
  const arriving = departure("in-long-turn", "3", [call("a", 0), call("b", 4), call("c", 8)]);
  const waiting = departure("out-long-turn", "3", [call("c", 21), call("b", 25), call("a", 29)]);

  assert.equal(findTurnarounds([arriving, waiting]).standFromByDepartureKey.size, 0);

  const vehicles = getLineDiagramVehicles(
    terminusDiagram(),
    [arriving, waiting],
    [],
    undefined,
    start + 13 * 60_000,
    { motions },
  );

  const terminusIndex = terminusDiagram().findIndex(({ stopId }) => stopId === "c");
  assert.deepEqual(
    vehicles.map(({ departure: { id }, phase }) => [id, phase]),
    [["out-long-turn", "beforeStart"]],
  );
  assert.equal(getVehicleRowCoordinate(vehicles[0]), terminusIndex);
});
