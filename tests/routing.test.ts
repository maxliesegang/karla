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

const JOURNEY = "de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26";

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
  // The legacy combined link reads as the bundle.
  const legacy = parseRoute("#/stop/europaplatz/line/S1-S11");
  assert.equal(legacy.lineId, "S1");
  assert.deepEqual(legacy.bundledLineIds, ["S11"]);
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
    `/stop/hochstetten/line/S1+S11/trip/${JOURNEY}`,
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
    ({ id: "row", journeyRef: JOURNEY, lineId }) as Parameters<typeof getStopEventOpenPath>[0];
  const selection = { lineId: "S1", bundledLineIds: ["S11"] };

  // The sibling's row keeps the lines; only the trip changes.
  assert.equal(
    getStopEventOpenPath(row("S11"), "hochstetten", false, selection),
    `/stop/hochstetten/line/S1+S11/trip/${JOURNEY}`,
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
    `/stop/hochstetten/line/S2/trip/${JOURNEY}`,
  );
});

test("a trip opened from a plain stop board steps back to that board", () => {
  const row = { id: "row", journeyRef: JOURNEY, lineId: "S11" } as Parameters<
    typeof getStopEventOpenPath
  >[0];
  const journeyPath = getStopEventOpenPath(row, "hochstetten", false);

  assert.equal(journeyPath, `/stop/hochstetten/trip/${JOURNEY}`);
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

  const lineJourneyRoute = parseRoute(`/stop/hochstetten/line/S11/trip/${JOURNEY}`);
  assert.equal(lineJourneyRoute.journeyParent, "line");
  assert.equal(getParentSelectionPath(lineJourneyRoute), "/stop/hochstetten/line/S11");
});

test("the stop's own address is the only one its lines need", () => {
  // The legacy `/lines` qualifier lands on the stop.
  const linesRoute = parseRoute("#/stop/europaplatz/lines");
  assert.equal(linesRoute.view, "stop");
  assert.equal(linesRoute.stopId, "europaplatz");
  assert.equal("section" in linesRoute, false);
  assert.equal(getSelectionPath({ stopId: "europaplatz" }), "/stop/europaplatz");
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
  const journeyRoute = parseRoute(
    "#/stop/augartenstrasse/line/S11/trip/de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26",
  );
  // Selecting a trip is not a move; the diagram aims at its vehicle.
  assert.equal(getViewStartKey(journeyRoute), null);
  // Nor is stepping along the line.
  assert.equal(getViewStartKey(parseRoute("#/stop/augartenstrasse/line/S11")), null);
  assert.equal(getViewStartKey(parseRoute("#/stop/marktplatz/line/S11")), null);
});

test("a ride is a view again, and a plain stop always was", () => {
  const rideKey = getViewStartKey(parseRoute("#/trip/de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26"));
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
  assert.equal(routePaths.ride(JOURNEY), `/trip/${JOURNEY}`);
  assert.equal(routePaths.ride(JOURNEY, "europaplatz"), `/trip/${JOURNEY}/from/europaplatz`);
  assert.equal(
    routePaths.ride(JOURNEY, "europaplatz", "durlach-bahnhof"),
    `/trip/${JOURNEY}/from/europaplatz/to/durlach-bahnhof`,
  );
  // Either stop may be absent; an Ausstieg alone is not an origin.
  const marked = parseRoute(`#/trip/${JOURNEY}/to/durlach-bahnhof`);
  assert.equal(marked.originStopId, undefined);
  assert.equal(marked.alightingStopId, "durlach-bahnhof");
  const both = parseRoute(`#/trip/${JOURNEY}/from/europaplatz/to/durlach-bahnhof`);
  assert.equal(both.originStopId, "europaplatz");
  assert.equal(both.alightingStopId, "durlach-bahnhof");
  assert.equal(both.isRide, true);
  assert.equal(both.lineId, "S11");
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
    `/trip/${JOURNEY}/from/europaplatz/to/durlach-bahnhof`,
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
    `/stop/europaplatz/line/S11/trip/${JOURNEY}`,
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

test("the network page is one page, and a former scope address still opens it", () => {
  assert.equal(routePaths.network(), "/network");
  assert.equal(parseRoute("#/network").view, "network");
  assert.equal(parseRoute("#/network/").view, "network");
  // Legacy scoped links land on the network page.
  assert.equal(parseRoute("#/network/city").view, "network");
  assert.equal(parseRoute("#/network/region").view, "network");
});
