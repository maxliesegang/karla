import assert from "node:assert/strict";
import test from "node:test";
import type { Departure } from "../src/data/transit-types.ts";
import {
  EMPTY_LINE_OBSERVATION,
  extendLineCallStopIds,
  extendLineObservation,
  extendLineObservations,
  getLineFilterDirectionIds,
  getLineDirectionIds,
  getLineObservationStopIds,
  getLineObservationsStopIds,
  getOppositeDirectionId,
  MAX_UNFILTERED_LINE_OBSERVATION_STOPS,
  sampleLineObservationStopIds,
  seedLineObservations,
  type LineObservations,
} from "../src/lib/line-observation.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import { withStopVisit } from "../src/lib/recent-stops.ts";
import { createDeparture, createLine } from "./support/fixtures.ts";

/** The line as the network states it, before any board has been read for it. */
const line3 = createLine({ id: "3", zentrumCalls: ["kronenplatz", "europaplatz"] });

/** Line 3 as observed: ten stops, three of them posts. */
const lineStopIds = [
  "europaplatz",
  "marktplatz",
  "kronenplatz",
  "durlacher-tor",
  "karl-wilhelm-platz",
  "ettlinger-tor",
  "kongresszentrum",
  "tivoli",
  "poststrasse",
  "hauptbahnhof",
];

function lineDeparture(lineId: string, routeDirectionId: string | undefined): Departure {
  return createDeparture({
    id: `${lineId}-${routeDirectionId ?? "none"}`,
    lineId,
    transportMode: "tram",
    destination: "Ziel",
    minutesUntilDeparture: 4,
    status: "realtime",
    ...(routeDirectionId ? { routeDirectionId } : {}),
  }) as Departure;
}

function tripWithCalls(stopIds: readonly string[]): Departure {
  return createDeparture({
    ...lineDeparture("3", "kvv:21003:E:H:s26"),
    tripCalls: stopIds.map((stopId) => ({ stopName: stopId.toUpperCase(), localStopId: stopId })),
  }) as Departure;
}

test("reads every known stop of a line, so no trip can hide between observations", () => {
  const observed = getLineObservationStopIds(lineStopIds, "hauptbahnhof");

  // The rider's own board is never asked for twice.
  assert.equal(observed.includes("hauptbahnhof"), false);
  assert.deepEqual(observed, lineStopIds.slice(0, -1));
});

test("the rider's own board is not requested twice", () => {
  // The rider's board is in hand, so it is left out.
  assert.deepEqual(getLineObservationStopIds(lineStopIds, "marktplatz"), [
    "europaplatz",
    "kronenplatz",
    "durlacher-tor",
    "karl-wilhelm-platz",
    "ettlinger-tor",
    "kongresszentrum",
    "tivoli",
    "poststrasse",
    "hauptbahnhof",
  ]);
});

test("reads an observation post like any other stop on the line", () => {
  // Posts are read too: these boards are filtered to the line.
  assert.deepEqual(
    getLineObservationStopIds(["europaplatz", "kronenplatz", "hauptbahnhof", "tivoli"], "tivoli"),
    ["europaplatz", "kronenplatz", "hauptbahnhof"],
  );
});

test("does not cap discovery at a fixed board count", () => {
  const observed = getLineObservationStopIds(["a", "b", "c", "d", "e", "f"], "a");
  assert.deepEqual(observed, ["b", "c", "d", "e", "f"]);
});

test("falls back to a terminus only where the line has no stop behind it", () => {
  // A terminus board lists only return workings; on a two-stop line it is all there is.
  assert.deepEqual(getLineObservationStopIds(["a", "b"], "a"), ["b"]);
});

test("asks for nothing beyond the rider's own board on a line seen at one stop", () => {
  assert.deepEqual(getLineObservationStopIds(["tivoli"], "tivoli"), []);
});

test("the stop just read leads the list, once, and the oldest falls off it", () => {
  const first = withStopVisit([], "tivoli", "Tivoli");
  const second = withStopVisit(first, "hauptbahnhof", "Hauptbahnhof");
  const again = withStopVisit(second, "tivoli", "Tivoli");

  assert.deepEqual(
    again.map((visit) => visit.stopId),
    ["tivoli", "hauptbahnhof"],
  );

  const many = ["a", "b", "c", "d", "e"].reduce(
    (visits, stopId) => withStopVisit(visits, stopId, stopId.toUpperCase()),
    withStopVisit([], "tivoli", "Tivoli"),
  );
  assert.deepEqual(
    many.map((visit) => visit.stopId),
    ["e", "d", "c", "b"],
  );
});

test("names both directions of a line, and nothing from the lines beside it", () => {
  // A one-direction filter would lose every vehicle running the other way.
  const departures = [
    lineDeparture("3", "kvv:21003:E:H:s26"),
    lineDeparture("3", "kvv:21003:E:R:s26"),
    lineDeparture("3", "kvv:21003:E:H:s26"),
    lineDeparture("4", "kvv:21004:E:H:s26"),
  ];

  assert.deepEqual(getLineDirectionIds("3", departures), [
    "kvv:21003:E:H:s26",
    "kvv:21003:E:R:s26",
  ]);
});

test("reads no line filter from departures that state no direction", () => {
  assert.deepEqual(getLineDirectionIds("3", [lineDeparture("3", undefined)]), []);
});

test("reads the whole run a loaded trip describes, not just its core stretch", () => {
  // Core stops are already seen by the posts; the outer thirds are where marks were missing.
  const trip = tripWithCalls([
    "durlach",
    "gottesauer-platz",
    "kronenplatz",
    "europaplatz",
    "knielingen",
  ]);
  const seeded = seedLineObservations(createLineSelection("3"), [line3], () => undefined);

  assert.deepEqual(
    extendLineObservations(seeded, createLineSelection("3"), [{ departures: [trip] }]).get("3")
      ?.stopIds,
    ["kronenplatz", "europaplatz", "durlach", "gottesauer-platz", "knielingen"],
  );
});

test("combines branches and short workings instead of trusting one longest trip", () => {
  const trunk = tripWithCalls(["a", "b", "c", "d", "e"]);
  const branch = tripWithCalls(["a", "b", "x", "y"]);
  const shortWorking = tripWithCalls(["b", "c", "d"]);

  assert.deepEqual(
    extendLineObservation(EMPTY_LINE_OBSERVATION, "3", [
      { departures: [trunk, branch, shortWorking] },
    ]).stopIds,
    ["a", "b", "c", "d", "e", "x", "y"],
  );
});

test("line discovery is a stable fixed-point transition", () => {
  const known = ["a", "b"];
  const unchanged = extendLineCallStopIds(known, [tripWithCalls(["a", "b"])]);
  assert.equal(unchanged, known);

  const expanded = extendLineCallStopIds(unchanged, [tripWithCalls(["b", "x", "y"])]);
  assert.deepEqual(expanded, ["a", "b", "x", "y"]);
  assert.notEqual(expanded, known);
  assert.equal(extendLineCallStopIds(expanded, [tripWithCalls(["x", "y"])]), expanded);
});

test("falls back to the line's core stops until a trip carries its calls", () => {
  assert.deepEqual(
    seedLineObservations(createLineSelection("3"), [line3], () => undefined).get("3")?.stopIds,
    ["kronenplatz", "europaplatz"],
  );
});

test("a line read before starts from what that reading learned, not from this hour's trips", () => {
  // An outer stretch discovered once is read even when no running trip describes it.
  const remembered = { stopIds: ["knielingen", "europaplatz"], directionIds: [] };

  assert.deepEqual(
    seedLineObservations(createLineSelection("3"), [line3], () => remembered).get("3"),
    remembered,
  );
});

test("names the direction a terminus lists no departure for, because the stop states it", () => {
  // At a terminus the inbound id is on no row, but the stop names it with its line.
  const observation = extendLineObservation(EMPTY_LINE_OBSERVATION, "3", [
    {
      departures: [lineDeparture("3", "kvv:21003:E:H:s26")],
      servingLines: [
        { lineId: "3", directionId: "kvv:21003:E:H:s26" },
        { lineId: "3", directionId: "kvv:21003:E:R:s26" },
        { lineId: "4", directionId: "kvv:21004:E:H:s26" },
      ],
    },
  ]);

  assert.deepEqual(observation.directionIds, ["kvv:21003:E:H:s26", "kvv:21003:E:R:s26"]);
});

test("the opposite of a direction is the same route the other way, and nothing else", () => {
  assert.equal(getOppositeDirectionId("kvv:21003:E:H:s26"), "kvv:21003:E:R:s26");
  assert.equal(getOppositeDirectionId("kvv:21003:E:R:s26"), "kvv:21003:E:H:s26");
  assert.equal(getOppositeDirectionId("kvv:flix:N1912:H:s26"), "kvv:flix:N1912:R:s26");
  // No opposite for a direction field the provider does not use.
  assert.equal(getOppositeDirectionId("kvv:21003:E:X:s26"), undefined);
  assert.equal(getOppositeDirectionId("21003"), undefined);
});

test("a direction nobody has confirmed is never sent as a filter", () => {
  // Half a filter hides the missing direction from itself; unfiltered is shorter but whole, and
  // corrects itself next round.
  const selection = createLineSelection("3");
  const oneWay = extendLineObservations(new Map() as LineObservations, selection, [
    { departures: [lineDeparture("3", "kvv:21003:E:H:s26")] },
  ]);

  assert.deepEqual(getLineFilterDirectionIds(oneWay, selection), []);

  const bothWays = extendLineObservations(oneWay, selection, [
    { departures: [lineDeparture("3", "kvv:21003:E:R:s26")] },
  ]);
  assert.deepEqual(getLineFilterDirectionIds(bothWays, selection), [
    "kvv:21003:E:H:s26",
    "kvv:21003:E:R:s26",
  ]);
});

test("a filtered board never teaches a stop what else calls there", () => {
  // A filtered board's silence about the other direction is not evidence.
  const observation = extendLineObservation(EMPTY_LINE_OBSERVATION, "3", [
    { departures: [lineDeparture("3", "kvv:21003:E:H:s26")] },
  ]);

  assert.deepEqual(observation.directionIds, ["kvv:21003:E:H:s26"]);
});

test("a bundle is filtered only where both of its lines are known both ways", () => {
  const selection = createLineSelection("3", ["4"]);
  const observations = extendLineObservations(new Map() as LineObservations, selection, [
    {
      departures: [
        lineDeparture("3", "kvv:21003:E:H:s26"),
        lineDeparture("4", "kvv:21004:E:H:s26"),
      ],
      servingLines: [{ lineId: "3", directionId: "kvv:21003:E:R:s26" }],
    },
  ]);

  // Line 4 is not named both ways, so nothing is filtered: a filter of three of four directions
  // would drop the fourth.
  assert.deepEqual(getLineFilterDirectionIds(observations, selection), []);
});

test("a bundle reads the union of its lines' routes", () => {
  const selection = createLineSelection("3", ["4"]);
  const observations = extendLineObservations(new Map() as LineObservations, selection, [
    { departures: [{ ...tripWithCalls(["a", "b"]), lineId: "3" } as Departure] },
    { departures: [{ ...tripWithCalls(["b", "c"]), lineId: "4" } as Departure] },
  ]);

  assert.deepEqual(getLineObservationsStopIds(observations, selection), ["a", "b", "c"]);
});

test("line observation is a stable fixed-point transition", () => {
  const selection = createLineSelection("3");
  const boards = [{ departures: [tripWithCalls(["a", "b"])] }];
  const known = extendLineObservations(new Map() as LineObservations, selection, boards);

  assert.equal(extendLineObservations(known, selection, boards), known);
  assert.equal(extendLineObservation(known.get("3")!, "3", boards), known.get("3"));
});

test("a round that cannot name its filter samples the line instead of reading all of it", () => {
  // Unfiltered boards are whole stops, so a round reads only a sample.
  const sampled = sampleLineObservationStopIds(lineStopIds, MAX_UNFILTERED_LINE_OBSERVATION_STOPS);

  assert.equal(sampled.length, MAX_UNFILTERED_LINE_OBSERVATION_STOPS);
  // Spread end to end, so both directions are in.
  assert.equal(sampled[0], "europaplatz");
  assert.equal(sampled[sampled.length - 1], "hauptbahnhof");
  assert.deepEqual(sampled, [
    "europaplatz",
    "kronenplatz",
    "karl-wilhelm-platz",
    "ettlinger-tor",
    "tivoli",
    "hauptbahnhof",
  ]);
});

test("a route already within the bound is read whole, and read as the same list", () => {
  const short = ["a", "b", "c"];
  // The same array when unchanged, so nothing is re-requested.
  assert.equal(sampleLineObservationStopIds(short, MAX_UNFILTERED_LINE_OBSERVATION_STOPS), short);
});

test("a line with no row among a busy stop's few is still named by the stop", () => {
  // At the Hauptbahnhof a line can be on none of twenty rows; the stop's serving lines still name
  // its directions.
  const observation = extendLineObservation(EMPTY_LINE_OBSERVATION, "S4", [
    {
      departures: [lineDeparture("S1", "kvv:22301:E:H:s26")],
      servingLines: [
        { lineId: "S1", directionId: "kvv:22301:E:H:s26" },
        { lineId: "S1", directionId: "kvv:22301:E:R:s26" },
        { lineId: "S4", directionId: "kvv:22304:E:H:s26" },
        { lineId: "S4", directionId: "kvv:22304:E:R:s26" },
      ],
    },
  ]);

  assert.deepEqual(observation.directionIds, ["kvv:22304:E:H:s26", "kvv:22304:E:R:s26"]);
  // A whole filter, so this stop is read for the line.
  const selection = createLineSelection("S4");
  assert.deepEqual(getLineFilterDirectionIds(new Map([["S4", observation]]), selection), [
    "kvv:22304:E:H:s26",
    "kvv:22304:E:R:s26",
  ]);
});

test("an id a stop states without naming its line is not attributed to one", () => {
  // An id without its line is unusable; guessing would draw another line's rows.
  const observation = extendLineObservation(EMPTY_LINE_OBSERVATION, "S4", [
    { departures: [], servingLines: [{ directionId: "kvv:22304:E:H:s26" }] },
  ]);

  assert.deepEqual(observation.directionIds, []);
});
