import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, TransitLine } from "../src/data/transit-types.ts";
import {
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

test("reads a line's vehicles from its ends, where every running trip is still listed", () => {
  const observed = getLineObservationStopIds(lineStopIds, "hauptbahnhof");

  // The rider's own board is never asked for twice.
  assert.equal(observed.includes("hauptbahnhof"), false);
  // One call in from each terminus, and then the middle of the stretch between them: a board lists
  // a trip while that stop is still ahead of it, so the ends see every vehicle running towards
  // them and the third sees the short workings that turn back before reaching either.
  assert.deepEqual(observed, ["marktplatz", "poststrasse", "karl-wilhelm-platz"]);
});

test("the rider standing where a sample would be taken is that sample", () => {
  // Their own board is that end's board; asking for it again buys nothing, so it is not asked for.
  assert.deepEqual(getLineObservationStopIds(lineStopIds, "marktplatz"), [
    "poststrasse",
    "karl-wilhelm-platz",
  ]);
});

test("samples an observation post like any other stop on the line", () => {
  // Posts were skipped while the shell's unfiltered boards were the diagram's source of marks.
  // These reads are filtered to one line and answer a different question, so a post sitting on the
  // line is worth sampling — and on a line whose stops are mostly posts, skipping them left the
  // diagram with almost nothing.
  assert.deepEqual(
    getLineObservationStopIds(["europaplatz", "kronenplatz", "hauptbahnhof", "tivoli"], "tivoli"),
    ["kronenplatz", "hauptbahnhof", "europaplatz"],
  );
});

test("samples both ends of the line rather than twice at one of them", () => {
  const observed = getLineObservationStopIds(["a", "b", "c", "d", "e", "f"], "a");
  assert.deepEqual(observed, ["b", "e", "c"]);
  // Spread evenly, the samples cover the middle alone: a vehicle past the outer one is on no board
  // in hand, and on a fresh visit there is no retained observation to place it from either.
  assert.deepEqual(getLineObservationStopIds(["a", "b", "c", "d", "e", "f"], "a", 2), ["b", "e"]);
});

test("falls back to a terminus only where the line has no stop behind it", () => {
  // A terminus board is departures from it, so it lists the return workings alone — the far end's
  // sample already sees those. On a two-stop line it is nonetheless all there is.
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

test("samples the whole run a loaded trip describes, not just its core stretch", () => {
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

test("falls back to the line's core stops until a trip carries its calls", () => {
  assert.deepEqual(
    getLineCallStopIds([], { zentrumStopIds: ["kronenplatz", "europaplatz"] } as TransitLine),
    ["kronenplatz", "europaplatz"],
  );
});
