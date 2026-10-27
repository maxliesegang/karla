import assert from "node:assert/strict";
import test from "node:test";

import {
  getStopEventOpenPath,
  getLandingPath,
  getParentSelectionPath,
  getSelectionPath,
  getViewStartKey,
  parseRoute,
  routePaths,
} from "../src/routing.ts";

const JOURNEY = "kvv:22311:E:H:s26:161@2026-10-27";
const JOURNEY_PATH = "kvv:22311:E:H:s26:161/2026-10-27";

test("the retired notices page opens home", () => {
  assert.equal(parseRoute("#/notices").view, "home");
});

test("the home has its own route, and nearby has one too", () => {
  assert.equal(routePaths.home(), "/");
  assert.equal(parseRoute("").view, "home");
  assert.equal(parseRoute("#/").view, "home");
  assert.equal(routePaths.nearby(), "/nearby");
  assert.equal(parseRoute("#/nearby").view, "nearby");
});

test("the settings page has its own address, and steps back up to the home", () => {
  assert.equal(routePaths.settings(), "/settings");
  assert.equal(parseRoute("#/settings").view, "settings");
  assert.equal(getParentSelectionPath({ view: "settings", stopId: "europaplatz" }), "/");
});

test("the app opens on the stop last read, and on the home for a rider with no history", () => {
  assert.equal(getLandingPath("marktplatz"), "/stop/marktplatz");
  assert.equal(getLandingPath(undefined), "/");
  assert.equal(getLandingPath(""), "/");
});

test("keeps S1 and S11 as separate line addresses", () => {
  assert.equal(routePaths.line("S1", "europaplatz"), "/stop/europaplatz/line/S1");
  assert.equal(routePaths.line("S11", "europaplatz"), "/stop/europaplatz/line/S11");
  assert.equal(parseRoute("#/stop/europaplatz/line/S1").lineId, "S1");
  assert.equal(parseRoute("#/stop/europaplatz/line/S11").lineId, "S11");
  assert.deepEqual(parseRoute("#/stop/europaplatz/line/S1").bundledLineIds, []);
});

test("two lines read over the stretch they share are one address, and stay two lines", () => {
  assert.equal(routePaths.line("S1", "hochstetten", ["S11"]), "/stop/hochstetten/line/S1+S11");
  const bundled = parseRoute("#/stop/hochstetten/line/S1+S11");
  assert.equal(bundled.lineId, "S1");
  assert.deepEqual(bundled.bundledLineIds, ["S11"]);
  assert.equal(
    getSelectionPath({ stopId: "hochstetten", lineId: "S1", bundledLineIds: ["S11"] }),
    "/stop/hochstetten/line/S1+S11",
  );
  // A trip pinned in the bundle keeps it; unpinning returns to it.
  assert.equal(
    getSelectionPath({
      stopId: "hochstetten",
      lineId: "S1",
      bundledLineIds: ["S11"],
      addressId: JOURNEY,
    }),
    `/stop/hochstetten/line/S1+S11/journey/${JOURNEY_PATH}`,
  );
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "hochstetten",
      lineId: "S1",
      bundledLineIds: ["S11"],
      addressId: JOURNEY,
    }),
    "/stop/hochstetten/line/S1+S11",
  );
});

test("a row tapped inside a bundle stays inside it, and any other row leaves it", () => {
  const row = (lineId: string) =>
    ({ id: "row", datedJourneyId: JOURNEY, lineId }) as Parameters<typeof getStopEventOpenPath>[0];
  const selection = { lineId: "S1", bundledLineIds: ["S11"] };

  // The sibling's row keeps the lines; only the trip changes.
  assert.equal(
    getStopEventOpenPath(row("S11"), "hochstetten", false, selection),
    `/stop/hochstetten/line/S1+S11/journey/${JOURNEY_PATH}`,
  );
  // Unpinning returns to the bundle.
  assert.equal(
    getStopEventOpenPath(row("S11"), "hochstetten", true, selection),
    "/stop/hochstetten/line/S1+S11",
  );
  // A line outside the bundle leads to that line alone.
  assert.equal(
    getStopEventOpenPath(row("S2"), "hochstetten", true, selection),
    "/stop/hochstetten/line/S2",
  );
  assert.equal(
    getStopEventOpenPath(row("S2"), "hochstetten", false, selection),
    `/stop/hochstetten/line/S2/journey/${JOURNEY_PATH}`,
  );
});

test("a trip opened from a plain stop board steps back to that board", () => {
  const row = { id: "row", datedJourneyId: JOURNEY, lineId: "S11" } as Parameters<
    typeof getStopEventOpenPath
  >[0];
  const journeyPath = getStopEventOpenPath(row, "hochstetten", false);

  assert.equal(journeyPath, `/stop/hochstetten/journey/${JOURNEY_PATH}`);
  const journeyRoute = parseRoute(`#${journeyPath}`);
  assert.equal(journeyRoute.lineId, "");
  assert.equal(journeyRoute.journeyParent, "stop");
  assert.equal(getViewStartKey(journeyRoute), null);
  assert.equal(
    getParentSelectionPath({
      ...journeyRoute,
      lineId: "S11",
    }),
    "/stop/hochstetten",
  );
  assert.equal(
    getSelectionPath({
      stopId: "hochstetten",
      lineId: "S11",
      addressId: JOURNEY,
      journeyParent: "stop",
    }),
    journeyPath,
  );

  const lineJourneyRoute = parseRoute(`/stop/hochstetten/line/S11/journey/${JOURNEY_PATH}`);
  assert.equal(lineJourneyRoute.journeyParent, "line");
  assert.equal(getParentSelectionPath(lineJourneyRoute), "/stop/hochstetten/line/S11");
});

test("the stop's own address is the only one its lines need", () => {
  assert.equal(getSelectionPath({ stopId: "europaplatz" }), "/stop/europaplatz");
});

test("a journey's address is its JourneyRef and operating day, and a bare row id still works", () => {
  assert.equal(parseRoute(`#/journey/${JOURNEY_PATH}`).addressId, JOURNEY);
  assert.equal(routePaths.ride("row-7"), "/journey/row-7");
  assert.equal(parseRoute("#/journey/row-7/to/durlach-bahnhof").addressId, "row-7");
  assert.equal(parseRoute("#/journey/row-7/to/durlach-bahnhof").alightingStopId, "durlach-bahnhof");
});

test("the lines ride along with the stop they belong to, not an address of their own", () => {
  assert.equal(
    getViewStartKey(parseRoute("#/stop/augartenstrasse/lines")),
    getViewStartKey(parseRoute("#/stop/augartenstrasse")),
  );
  assert.equal(
    getViewStartKey(parseRoute("#/stop/augartenstrasse")),
    getViewStartKey(parseRoute("#/stop/augartenstrasse")),
  );
});

test("a line diagram places itself, so no address it is read at starts at the top", () => {
  const journeyRoute = parseRoute("#/stop/augartenstrasse/line/S11/journey/kvv:22311:E:H:s26:161");
  // Selecting a trip is not a move; the diagram aims at its vehicle.
  assert.equal(getViewStartKey(journeyRoute), null);
  // Nor is stepping along the line.
  assert.equal(getViewStartKey(parseRoute("#/stop/augartenstrasse/line/S11")), null);
  assert.equal(getViewStartKey(parseRoute("#/stop/marktplatz/line/S11")), null);
});

test("a ride is a view again, and a plain stop always was", () => {
  const rideKey = getViewStartKey(parseRoute("#/journey/kvv:22311:E:H:s26:161"));
  assert.ok(rideKey);
  assert.notEqual(rideKey, getViewStartKey(parseRoute("#/stop/augartenstrasse")));
  assert.equal(
    getViewStartKey(parseRoute("#/stop/augartenstrasse")),
    getViewStartKey(parseRoute("#/stop/augartenstrasse")),
  );
});

test("a board refresh rewriting the address is not a move", () => {
  assert.equal(
    getViewStartKey(parseRoute("#/stop/marktplatz")),
    getViewStartKey(parseRoute("#/stop/marktplatz")),
  );
  // Stops alone are two views; with a line, they place themselves.
  assert.notEqual(
    getViewStartKey(parseRoute("#/stop/marktplatz")),
    getViewStartKey(parseRoute("#/stop/europaplatz")),
  );
});

test("a ride carries the stop it was begun at, beside the one it is heading for", () => {
  assert.equal(routePaths.ride(JOURNEY), `/journey/${JOURNEY_PATH}`);
  assert.equal(
    routePaths.ride(JOURNEY, "europaplatz"),
    `/journey/${JOURNEY_PATH}/from/europaplatz`,
  );
  assert.equal(
    routePaths.ride(JOURNEY, "europaplatz", "durlach-bahnhof"),
    `/journey/${JOURNEY_PATH}/from/europaplatz/to/durlach-bahnhof`,
  );
  // Either stop may be absent; an Ausstieg alone is not an origin.
  const marked = parseRoute(`#/journey/${JOURNEY_PATH}/to/durlach-bahnhof`);
  assert.equal(marked.originStopId, undefined);
  assert.equal(marked.alightingStopId, "durlach-bahnhof");
  const both = parseRoute(`#/journey/${JOURNEY_PATH}/from/europaplatz/to/durlach-bahnhof`);
  assert.equal(both.originStopId, "europaplatz");
  assert.equal(both.alightingStopId, "durlach-bahnhof");
  assert.equal(both.isRide, true);
  // The address names no line; the network resolves it from the ref's identity.
  assert.equal(both.lineId, "");
  // Every resolved level is written back, origin included.
  assert.equal(
    getSelectionPath({
      stopId: "europaplatz",
      lineId: "S11",
      addressId: JOURNEY,
      isRide: true,
      alightingStopId: "durlach-bahnhof",
      originStopId: "europaplatz",
    }),
    `/journey/${JOURNEY_PATH}/from/europaplatz/to/durlach-bahnhof`,
  );
});

test("step up drops exactly one level of the address, and never reads live data for one", () => {
  // One level at a time.
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "europaplatz",
      lineId: "S11",
      addressId: JOURNEY,
    }),
    "/stop/europaplatz/line/S11",
  );
  assert.equal(
    getParentSelectionPath({ view: "stop", stopId: "europaplatz", lineId: "S11" }),
    "/stop/europaplatz",
  );
  assert.equal(getParentSelectionPath({ view: "stop", stopId: "europaplatz" }), "/");
  // Home is the top.
  assert.equal(getParentSelectionPath({ view: "experiment", stopId: "europaplatz" }), "/");
  assert.equal(getParentSelectionPath({ view: "network", stopId: "europaplatz" }), "/");
  assert.equal(getParentSelectionPath({ view: "nearby", stopId: "europaplatz" }), "/");
  assert.equal(getParentSelectionPath({ view: "home", stopId: "europaplatz" }), undefined);
});

test("a ride steps back to where it was begun, not to a stop the vehicle is running towards", () => {
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "hauptbahnhof",
      lineId: "S11",
      addressId: JOURNEY,
      isRide: true,
      originStopId: "europaplatz",
    }),
    `/stop/europaplatz/line/S11/journey/${JOURNEY_PATH}`,
  );
  // Pressed twice, it reaches the trip's stop.
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "europaplatz",
      lineId: "S11",
      addressId: JOURNEY,
    }),
    "/stop/europaplatz/line/S11",
  );
  // A ride from a shared link steps up to home.
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "hauptbahnhof",
      lineId: "S11",
      addressId: JOURNEY,
      isRide: true,
    }),
    "/",
  );
});

test("the network page is one page", () => {
  assert.equal(routePaths.network(), "/network");
  assert.equal(parseRoute("#/network").view, "network");
  assert.equal(parseRoute("#/network/").view, "network");
});
