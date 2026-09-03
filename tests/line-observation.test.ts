import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TransitLine } from "../src/data/transit-types.ts";
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

/** The line as the network states it, before any board has been read for it. */
const line3 = { id: "3", zentrumStopIds: ["kronenplatz", "europaplatz"] } as TransitLine;

/** Linie 3 as the observation sees it: ten stops along the line, three of them observation posts. */
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
  return {
    id: `${lineId}-${routeDirectionId ?? "none"}`,
    lineId,
    transportMode: "tram",
    destination: "Ziel",
    minutesUntilDeparture: 4,
    status: "realtime",
    ...(routeDirectionId ? { routeDirectionId } : {}),
  } as Departure;
}

function tripWithCalls(stopIds: readonly string[]): Departure {
  return {
    ...lineDeparture("3", "kvv:21003:E:H:s26"),
    tripCalls: stopIds.map((stopId) => ({ stopName: stopId.toUpperCase(), localStopId: stopId })),
  } as Departure;
}

test("reads every known stop of a line, so no trip can hide between observations", () => {
  const observed = getLineObservationStopIds(lineStopIds, "hauptbahnhof");

  // The rider's own board is never asked for twice.
  assert.equal(observed.includes("hauptbahnhof"), false);
  assert.deepEqual(observed, lineStopIds.slice(0, -1));
});

test("the rider's own board is not requested twice", () => {
  // Their own board is already in hand, so it is removed from the crawl.
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
  // Posts were skipped while the shell's unfiltered boards were the diagram's source of marks.
  // These reads are filtered to one line and answer a different question, so a post sitting on the
  // line is worth reading — and on a line whose stops are mostly posts, skipping them left the
  // diagram with almost nothing.
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
  // A terminus board is departures from it, so it lists the return workings alone — the far end's
  // far board already sees those. On a two-stop line it is nonetheless all there is.
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
  // A board filtered to one direction answers with one direction, so a diagram that named only what
  // the rider's own stop sees would lose every vehicle running the other way.
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
  // Sampling the core stops only ever reached into the Zentrum, which every observation post
  // already sees. The outer thirds are exactly where marks were missing.
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
  // Off-peak every trip through a stop may turn back short of the line's outer stretch. Discovered
  // once, that stretch is still read at the hour when nothing running describes it.
  const remembered = { stopIds: ["knielingen", "europaplatz"], directionIds: [] };

  assert.deepEqual(
    seedLineObservations(createLineSelection("3"), [line3], () => remembered).get("3"),
    remembered,
  );
});

test("names the direction a terminus lists no departure for, because the stop states it", () => {
  // At the end of a line the rider's board shows the outbound trips alone, so the inbound id is on
  // no row anywhere. The stop still knows the direction, and names the line it belongs to.
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
  // Nothing is derived from an id whose direction field is not one the provider states.
  assert.equal(getOppositeDirectionId("kvv:21003:E:X:s26"), undefined);
  assert.equal(getOppositeDirectionId("21003"), undefined);
});

test("a direction nobody has confirmed is never sent as a filter", () => {
  // A filter is a whitelist applied exactly, so half a filter is a reading with a hole in it — and
  // one that holds itself open, because the rows that would name the missing direction are the
  // rows it drops. Unfiltered is shorter and whole, and it corrects itself on the next round.
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
  // It saw only what it was asked for; its silence about the other direction is not evidence.
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

  // Linie 3 is named both ways and Linie 4 is not, so neither is filtered: one request carries the
  // whole corridor, and a filter naming three of its four directions would drop the fourth.
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
  // Its boards are whole stops — every line calling there, with the trip behind every row — so a
  // line's worth of them is a different order of cost from the filtered reading it stands in for.
  const sampled = sampleLineObservationStopIds(lineStopIds, MAX_UNFILTERED_LINE_OBSERVATION_STOPS);

  assert.equal(sampled.length, MAX_UNFILTERED_LINE_OBSERVATION_STOPS);
  // Spread from end to end: the stops arrive in discovery order, and the first six of them are six
  // stops of one corner. Both ends are in, so both directions of the line are in.
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
  // Identity, so a reading that did not change is not requested again.
  assert.equal(sampleLineObservationStopIds(short, MAX_UNFILTERED_LINE_OBSERVATION_STOPS), short);
});

test("a line with no row among a busy stop's few is still named by the stop", () => {
  // The Hauptbahnhof answers with a dozen lines between twenty rows, and a line whose next
  // departure falls outside them is on none of them. Nothing about it could then be learned from
  // the rows — not its directions, not its route — so the reading of it never began, and a shared
  // link to one of its trips resolved at every other stop of the line but not at that one.
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
  // Which is a whole filter, so this stop's board can be read for the line and reach the hour a
  // shared board never does.
  const selection = createLineSelection("S4");
  assert.deepEqual(getLineFilterDirectionIds(new Map([["S4", observation]]), selection), [
    "kvv:22304:E:H:s26",
    "kvv:22304:E:R:s26",
  ]);
});

test("an id a stop states without naming its line is not attributed to one", () => {
  // The pairing is the whole value of this metadata. An id with no line beside it belongs to
  // nothing that can be read from it, and guessing would put another line's rows on this diagram.
  const observation = extendLineObservation(EMPTY_LINE_OBSERVATION, "S4", [
    { departures: [], servingLines: [{ directionId: "kvv:22304:E:H:s26" }] },
  ]);

  assert.deepEqual(observation.directionIds, []);
});
