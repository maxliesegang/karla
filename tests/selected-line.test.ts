import assert from "node:assert/strict";
import test from "node:test";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitNetwork,
} from "../src/data/transit-types.ts";
import { parseRoute } from "../src/routing.ts";
import { findBundledLines, findSelectedLine } from "../src/selected-line.ts";

const TRIP = "de:kvv:00S02_:.kvv-21-12-E.5.T0.946.s26";
const network = { lines: [] } as unknown as TransitNetwork;

const row = (lineId: string, transportMode: Departure["transportMode"]) =>
  ({ id: `row-${lineId}`, lineId, transportMode }) as Departure;
const liveBoard = (departures: readonly Departure[]) =>
  ({ dataStatus: "live", departures }) as unknown as DepartureBoard;

test("a trip opened from a stop board keeps its line once it has left that stop", () => {
  // The rider's board no longer lists the trip: it departed. It is still running along the line,
  // and the line is what keeps the readings that find it there going.
  const route = parseRoute(`#/stop/marktplatz/trip/${TRIP}`);
  const departures = [row("S2", "lightRail"), row("2", "tram")];

  const line = findSelectedLine(
    route,
    network,
    departures,
    liveBoard(departures),
    undefined,
    undefined,
  );

  assert.equal(line?.id, "S2");
  assert.equal(line?.transportMode, "lightRail");
});

test("the line a departed trip names holds even when no other run of it calls here", () => {
  const route = parseRoute(`#/stop/marktplatz/trip/${TRIP}`);

  const line = findSelectedLine(route, network, [], liveBoard([]), undefined, undefined);

  assert.equal(line?.id, "S2");
});

test("without a trip the bare stop names no line", () => {
  const route = parseRoute("#/stop/marktplatz");

  assert.equal(
    findSelectedLine(route, network, [], liveBoard([]), undefined, undefined),
    undefined,
  );
});

const S5 = { id: "S5" } as TransitLine;

test("an addressed sibling no reading has named yet holds while the stop's board loads", () => {
  // A shared `line/S5+S2` link opened cold: neither the network nor the board has seen S2 yet.
  const lines = findBundledLines(["S2"], S5, network, null);

  assert.deepEqual(
    lines.map(({ id }) => id),
    ["S2"],
  );
});

test("a sibling the live board says serves the stop holds without a row or an observation", () => {
  const board = {
    dataStatus: "live",
    departures: [],
    servingLines: [{ lineId: "S2" }],
  } as unknown as DepartureBoard;

  assert.deepEqual(
    findBundledLines(["S2"], S5, network, board).map(({ id }) => id),
    ["S2"],
  );
});

test("a sibling the live board does not serve is dropped", () => {
  assert.deepEqual(findBundledLines(["S2"], S5, network, liveBoard([])), []);
});
