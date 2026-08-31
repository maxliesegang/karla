import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TransitLine } from "../src/data/transit-types.ts";
import {
  extendLineCallStopIds,
  getLineCallStopIds,
  getLineDirectionIds,
  getLineObservationStopIds,
} from "../src/lib/observed-network.ts";
import { withStopVisit } from "../src/lib/recent-stops.ts";

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

  assert.deepEqual(
    getLineCallStopIds([trip], { zentrumStopIds: ["kronenplatz", "europaplatz"] } as TransitLine),
    ["durlach", "gottesauer-platz", "kronenplatz", "europaplatz", "knielingen"],
  );
});

test("combines branches and short workings instead of trusting one longest trip", () => {
  const trunk = tripWithCalls(["a", "b", "c", "d", "e"]);
  const branch = tripWithCalls(["a", "b", "x", "y"]);
  const shortWorking = tripWithCalls(["b", "c", "d"]);

  assert.deepEqual(getLineCallStopIds([trunk, branch, shortWorking], undefined), [
    "a",
    "b",
    "c",
    "d",
    "e",
    "x",
    "y",
  ]);
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
    getLineCallStopIds([], { zentrumStopIds: ["kronenplatz", "europaplatz"] } as TransitLine),
    ["kronenplatz", "europaplatz"],
  );
});
