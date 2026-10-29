import assert from "node:assert/strict";
import test from "node:test";
import type {
  StopEvent,
  StopEventBoard,
  TransitLine,
  TransitNetwork,
} from "../src/data/transit-types.ts";
import { parseRoute } from "../src/routing.ts";
import { findBundledLines, findSelectedLine } from "../src/selected-line.ts";
import { createStopEvent } from "./support/fixtures.ts";

const JOURNEY = "kvv:22302:E:H:s26:946";
const network = { lines: [] } as unknown as TransitNetwork;
const S2 = { id: "S2", identity: "kvv:22302", ptMode: "lightRail" } as TransitLine;
/** The network once it has seen the S2: lines carry the identity their refs state. */
const networkWithS2 = { lines: [S2] } as unknown as TransitNetwork;

const row = (lineId: string, ptMode: StopEvent["ptMode"]) =>
  ({ id: `row-${lineId}`, lineId, ptMode }) as StopEvent;
const liveBoard = (stopEvents: readonly StopEvent[]) =>
  ({ dataStatus: "live", stopEvents }) as unknown as StopEventBoard;

test("a journey opened from a stop board keeps its line once it has left that stop", () => {
  // The rider's board no longer lists the journey: it departed. It is still running along the line,
  // and the line is what keeps the readings that find it there going.
  const route = parseRoute(`#/stop/marktplatz/journey/${JOURNEY}`);
  const stopEvents = [row("S2", "lightRail"), row("2", "tram")];

  const line = findSelectedLine(
    route,
    networkWithS2,
    stopEvents,
    liveBoard(stopEvents),
    undefined,
    undefined,
  );

  assert.equal(line?.id, "S2");
  assert.equal(line?.ptMode, "lightRail");
});

test("the line a departed journey names holds even when no other journey of it calls here", () => {
  const route = parseRoute(`#/stop/marktplatz/journey/${JOURNEY}`);

  const line = findSelectedLine(route, networkWithS2, [], liveBoard([]), undefined, undefined);

  assert.equal(line?.id, "S2");
});

test("a journey of another pool's line of the same name is not that line", () => {
  const route = parseRoute("#/stop/marktplatz/journey/ddb:920S2:C:R:j26:12");

  const line = findSelectedLine(route, networkWithS2, [], liveBoard([]), undefined, undefined);

  assert.equal(line, undefined);
});

test("a line address's journey of another pool's line of that name is that pool's line", () => {
  const route = parseRoute("#/stop/stuttgart/line/S2/journey/ddb:920S2:C:R:j26:12");
  const ownStopEvent = createStopEvent({
    id: "ddb:920S2:C:R:j26:12",
    lineId: "S2",
    lineRef: "ddb:920S2:C:R:j26",
    ptMode: "regionalRail",
  });

  const line = findSelectedLine(
    route,
    networkWithS2,
    [ownStopEvent],
    liveBoard([ownStopEvent]),
    S2,
    ownStopEvent,
  );

  assert.equal(line?.id, "S2");
  assert.equal(line?.identity, "ddb:920S2");
});

test("a line address's journey of another pool keeps that pool's line once it has left the stop", () => {
  const route = parseRoute("#/stop/stuttgart/line/S2/journey/ddb:920S2:C:R:j26:12");

  const line = findSelectedLine(route, networkWithS2, [], liveBoard([]), S2, undefined);

  assert.equal(line?.id, "S2");
  assert.equal(line?.identity, "ddb:920S2");
});

test("without a journey the bare stop names no line", () => {
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
    stopEvents: [],
    servingLines: [{ lineId: "S2" }],
  } as unknown as StopEventBoard;

  assert.deepEqual(
    findBundledLines(["S2"], S5, network, board).map(({ id }) => id),
    ["S2"],
  );
});

test("a sibling the live board does not serve is dropped", () => {
  assert.deepEqual(findBundledLines(["S2"], S5, network, liveBoard([])), []);
});
