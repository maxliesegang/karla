import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  recallLineObservation,
  rememberLineObservation,
} from "../src/data/line-observation-memory.ts";
import { createLineSign, getLineSign } from "../src/data/line-signs.ts";
import { parseTriasStopEvents } from "../src/data/trias-parsers.ts";
import { isWithinScopePools, type NetworkScope } from "../src/data/network-scope.ts";
import { network } from "../src/networks/network.ts";
import { kvvNetwork } from "../src/networks/kvv/kvv-network.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";
import type { StopEvent } from "../src/data/transit-types.ts";
import {
  createLineSelection,
  createLineSelectionOf,
  isSelectedLine,
} from "../src/lib/line-bundles.ts";
import { compareLines, getLineTrunkId } from "../src/lib/line-families.ts";
import { getObservedTransitLines } from "../src/lib/observed-network.ts";
import { getLineIdentity, isRowOfLine, isSameLine } from "../src/lib/line-identity.ts";
import {
  EMPTY_LINE_OBSERVATION,
  extendLineObservations,
  getLineFilterLineRefs,
  getLineRouteRequests,
  getOppositeLineRef,
  seedLineObservations,
} from "../src/lib/line-observation.ts";
import { createLine, createStopEvent } from "./support/fixtures.ts";

/** Real board excerpts read on 26 October 2026: Stuttgart Hbf (A.-Klett-Platz) and Freiburg Hbf. */
const VVS_BOARD = readFileSync(new URL("./support/trias-board-vvs.xml", import.meta.url), "utf8");
const FRB_BOARD = readFileSync(new URL("./support/trias-board-frb.xml", import.meta.url), "utf8");

/** A wider network, as a later build might read it. */
const WIDER_SCOPE: NetworkScope = {
  pools: new Set(["kvv", "vvs", "frb"]),
  bounds: { south: 47.5, north: 49.8, west: 7.5, east: 10.5 },
};

/** A board as the source would hand it to the views, its calls resolved to local stops. */
function readBoard(xml: string, stopPointId: string, scope: NetworkScope): StopEvent[] {
  const registry = new StopRegistry([]);
  return parseTriasStopEvents(xml, stopPointId, "departure", scope).stopEvents.map(
    (stopEvent, index) =>
      createStopEvent({
        id: `${stopEvent.journeyRef}-${index}`,
        journeyRef: stopEvent.journeyRef,
        lineId: stopEvent.lineId,
        lineRef: stopEvent.lineRef,
        ptMode: stopEvent.ptMode,
        destinationText: stopEvent.destinationText,
        calls: stopEvent.calls && registry.toCalls(stopEvent.calls),
      }),
  );
}

test("the build reads KVV's network", () => {
  assert.equal(network, kvvNetwork);
  assert.equal(isWithinScopePools(kvvNetwork.scope, "kvv:22301:E:H:s26"), true);
  assert.equal(isWithinScopePools(kvvNetwork.scope, "vvs:20015::H:j26"), false);
  assert.equal(isWithinScopePools(kvvNetwork.scope, "ddb:920S6:C:R"), false);
  // A row states its ref; one without is no row of the network.
  assert.equal(isWithinScopePools(kvvNetwork.scope, undefined), false);
});

test("another network's board is empty in KVV's scope and read in a scope that holds its pool", () => {
  assert.deepEqual(parseTriasStopEvents(VVS_BOARD, "de:08111:6112").stopEvents, []);
  assert.deepEqual(parseTriasStopEvents(FRB_BOARD, "de:08311:6508").stopEvents, []);

  const vvs = parseTriasStopEvents(VVS_BOARD, "de:08111:6112", "departure", WIDER_SCOPE);
  assert.deepEqual(
    vvs.stopEvents.map(({ lineId, lineRef, ptMode }) => [lineId, lineRef, ptMode]),
    [
      ["U15", "vvs:20015::H:j26", "lightRail"],
      ["U15", "vvs:20015::R:j26", "lightRail"],
      ["44", "vvs:30044::H:j26", "bus"],
    ],
  );

  // Freiburg states its times to the second.
  const frb = parseTriasStopEvents(FRB_BOARD, "de:08311:6508", "departure", WIDER_SCOPE);
  assert.deepEqual(
    frb.stopEvents.map(({ lineId, lineRef, timetabledDepartureTime }) => [
      lineId,
      lineRef,
      timetabledDepartureTime,
    ]),
    [
      ["4", "frb:11004:I:H:j26", "2026-10-26T16:49:00.000Z"],
      ["4", "frb:11004:I:R:j26", "2026-10-26T16:47:30.000Z"],
      ["3", "frb:11003:I:H:j26", "2026-10-26T16:49:00.000Z"],
    ],
  );
});

test("a line's identity is its ref's pool and line number, in every network's form", () => {
  assert.equal(getLineIdentity("kvv:22301:E:H:s26"), "kvv:22301");
  assert.equal(getLineIdentity("vvs:20015::H:j26"), "vvs:20015");
  assert.equal(getLineIdentity("frb:11004:I:R"), "frb:11004");
  assert.equal(getLineIdentity("ddb:920S6:C:R"), "ddb:920S6");
  assert.equal(getLineIdentity(undefined), undefined);
  assert.equal(getLineIdentity("S1"), undefined);
});

test("one name in two networks is two lines; one number with two names is two lines", () => {
  const kvvS1 = { lineId: "S1", lineRef: "kvv:22301:E:H:s26" };
  const stuttgartS1 = { lineId: "S1", lineRef: "ddb:920S1:C:H" };
  assert.equal(isSameLine(kvvS1, stuttgartS1), false);
  assert.equal(isSameLine(kvvS1, { lineId: "S1", lineRef: "kvv:22301:E:R:s26" }), true);
  // DB states RE40 and RE45 under one line number.
  assert.equal(
    isSameLine(
      { lineId: "RE40", lineRef: "ddb:90RE4:5:H" },
      { lineId: "RE45", lineRef: "ddb:90RE4:D:H" },
    ),
    false,
  );
  // An address names the line alone, so any row of that name answers it; a row without a ref is
  // no row of a line asked for by identity.
  assert.equal(isRowOfLine(kvvS1, "S1"), true);
  assert.equal(isRowOfLine(stuttgartS1, "S1"), true);
  assert.equal(isRowOfLine({ lineId: "S1" }, "S1", "kvv:22301"), false);
});

test("a selection resolved to KVV's line does not take another network's line of that name", () => {
  const selection = createLineSelectionOf(createLineSign("4", "tram", "kvv:21004:E:H:s26"));
  assert.equal(isSelectedLine(selection, { lineId: "4", lineRef: "kvv:21004:E:R:s26" }), true);
  assert.equal(isSelectedLine(selection, { lineId: "4", lineRef: "frb:11004:I:R:j26" }), false);
  // An unresolved selection matches by name, as before.
  assert.equal(
    isSelectedLine(createLineSelection("4"), { lineId: "4", lineRef: "frb:11004:I:R:j26" }),
    true,
  );
});

test("KVV's colours are for KVV's lines; another network's line of the same name is neutral", () => {
  assert.equal(createLineSign("4", "tram", "kvv:21004:E:H:s26").color, "#ffcc00");
  assert.equal(createLineSign("4", "tram").color, "#ffcc00");
  assert.equal(createLineSign("4", "tram", "frb:11004:I:H:j26").color, "#3f4a4a");
  assert.equal(createLineSign("S1", "lightRail", "ddb:920S1:C:H").color, "#2f4f56");
  assert.equal(createLineSign("4", "tram", "frb:11004:I:H:j26").identity, "frb:11004");

  const kvvLine4 = createLineSign("4", "tram", "kvv:21004:E:H:s26");
  assert.equal(getLineSign([kvvLine4], "4", "tram", "frb:11004:I:H:j26").color, "#3f4a4a");
  assert.equal(getLineSign([kvvLine4], "4", "tram", "kvv:21004:E:R:s26"), kvvLine4);
  // An address names the line alone; it is the observed line of that name.
  assert.equal(getLineSign([kvvLine4], "4", "tram"), kvvLine4);
});

test("KVV's numbering orders KVV's lines; other networks' lines follow by name", () => {
  assert.equal(getLineTrunkId("S11"), "S1");
  assert.equal(getLineTrunkId("S11", "kvv:22311"), "S1");
  assert.equal(getLineTrunkId("S11", "ddb:920S1"), undefined);

  const lines = [
    { id: "U15", identity: "vvs:20015" },
    { id: "S11", identity: "kvv:22311" },
    { id: "4", identity: "frb:11004" },
    { id: "2", identity: "kvv:21002" },
    { id: "S1", identity: "kvv:22301" },
    { id: "44", identity: "vvs:30044" },
  ];
  assert.deepEqual(
    lines.sort(compareLines).map(({ id, identity }) => `${id} ${identity}`),
    [
      "2 kvv:21002",
      "S1 kvv:22301",
      "S11 kvv:22311",
      "4 frb:11004",
      "44 vvs:30044",
      "U15 vvs:20015",
    ],
  );
});

test("a line outside the Zentrum is crawled from the rider's board alone", () => {
  const board = readBoard(VVS_BOARD, "de:08111:6112", WIDER_SCOPE);
  const u15 = createLineSign("U15", "lightRail", board[0].lineRef);
  const selection = createLineSelectionOf(u15);

  const seeded = seedLineObservations(selection, [u15], () => undefined);
  assert.deepEqual(seeded.get("U15"), EMPTY_LINE_OBSERVATION);

  const learned = extendLineObservations(seeded, selection, [{ stopEvents: board }]);
  const observation = learned.get("U15");
  assert.deepEqual(observation?.lineRefs, ["vvs:20015::H:j26", "vvs:20015::R:j26"]);
  // Two calls either side of the board's own, the same five stops both ways.
  assert.equal(observation?.stopIds.length, 5);
  assert.equal(getOppositeLineRef("vvs:20015::H:j26"), "vvs:20015::R:j26");
  assert.deepEqual(getLineFilterLineRefs(learned, selection), [
    "vvs:20015::H:j26",
    "vvs:20015::R:j26",
  ]);
  assert.deepEqual(
    getLineRouteRequests(selection, [{ stopEvents: board }]).map(({ lineRef }) => lineRef),
    ["vvs:20015::H:j26", "vvs:20015::R:j26"],
  );
});

test("the crawl of KVV's line learns nothing from another network's line of that name", () => {
  const frb = readBoard(FRB_BOARD, "de:08311:6508", WIDER_SCOPE);
  const kvvRow = createStopEvent({
    id: "kvv-4",
    lineId: "4",
    lineRef: "kvv:21004:E:H:s26",
    calls: [{ stopName: "Marktplatz", stopPlaceId: "marktplatz" }],
  });
  const selection = createLineSelectionOf(createLineSign("4", "tram", "kvv:21004:E:H:s26"));

  const learned = extendLineObservations(new Map(), selection, [{ stopEvents: [kvvRow, ...frb] }]);
  assert.deepEqual(learned.get("4"), {
    stopIds: ["marktplatz"],
    lineRefs: ["kvv:21004:E:H:s26"],
  });
});

test("a remembered line is recalled only for its own network", () => {
  const observation = { stopIds: ["hauptbahnhof"], lineRefs: ["frb:11004:I:H:j26"] };
  rememberLineObservation("4", observation, "frb:11004");
  assert.equal(recallLineObservation("4", "frb:11004"), observation);
  assert.equal(recallLineObservation("4", "kvv:21004"), undefined);
  assert.equal(recallLineObservation("4"), observation);
});

test("a line's Zentrum calls seed only that network's line", () => {
  const kvvLine4 = createLine({ id: "4", identity: "kvv:21004", zentrumCalls: ["marktplatz"] });
  const frbSelection = createLineSelectionOf({ id: "4", identity: "frb:11004" });
  assert.deepEqual(
    seedLineObservations(frbSelection, [kvvLine4], () => undefined).get("4"),
    EMPTY_LINE_OBSERVATION,
  );
  assert.deepEqual(
    seedLineObservations(createLineSelection("4"), [kvvLine4], () => undefined).get("4")?.stopIds,
    ["marktplatz"],
  );
});

test("an observed line carries its identity, so a selection of it is resolved", () => {
  const [line] = getObservedTransitLines({
    stops: [],
    lines: [{ id: "S1", ptMode: "lightRail", lineRef: "kvv:22301:E:H:s26", destinations: [] }],
    journeyCount: 1,
  });
  assert.equal(line.identity, "kvv:22301");
  assert.equal(line.color, "#00b875");
  assert.equal(
    isSelectedLine(createLineSelectionOf(line), { lineId: "S1", lineRef: "ddb:920S1:C:H" }),
    false,
  );
});
