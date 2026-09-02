import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "window", { value: { location: { search: "" } } });
const {
  getDepartureOpenPath,
  getLandingPath,
  getParentSelectionPath,
  getSelectionPath,
  getViewStartKey,
  isHomeView,
  parseRoute,
  routePaths,
} = await import("../src/routing.ts");

const TRIP = "de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26";

test("published notices have a dedicated canonical route", () => {
  assert.equal(routePaths.notices(), "/notices");
  assert.equal(parseRoute("#/notices").view, "notices");
});

test("the Zentrum is the canonical home, and nearby has its own route", () => {
  assert.equal(routePaths.home(), "/center");
  assert.equal(parseRoute("").view, "zentrum");
  assert.equal(routePaths.nearby(), "/nearby");
  assert.equal(parseRoute("#/nearby").view, "nearby");
});

test("the app opens on the stop last read, and on the home for a rider with no history", () => {
  assert.equal(getLandingPath("marktplatz"), "/stop/marktplatz");
  assert.equal(getLandingPath(undefined), "/center");
  assert.equal(getLandingPath(""), "/center");
});

test("only the tabbed roots use the home layout", () => {
  assert.equal(isHomeView("zentrum"), true);
  assert.equal(isHomeView("network"), true);
  assert.equal(isHomeView("stop"), false);
  assert.equal(isHomeView("line"), false);
  assert.equal(isHomeView("nearby"), false);
  assert.equal(isHomeView("notices"), false);
});

test("keeps S1 and S11 as separate line addresses", () => {
  assert.equal(routePaths.line("S1", "europaplatz"), "/stop/europaplatz/line/S1");
  assert.equal(routePaths.line("S11", "europaplatz"), "/stop/europaplatz/line/S11");
  assert.equal(parseRoute("#/stop/europaplatz/line/S1").lineId, "S1");
  assert.equal(parseRoute("#/stop/europaplatz/line/S11").lineId, "S11");
  assert.deepEqual(parseRoute("#/stop/europaplatz/line/S1").bundledLineIds, []);
  // The old combined link is read as the two lines being read together, which is what it meant.
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
  // A trip pinned inside the bundle keeps it, and unpinning comes back to the same reading.
  assert.equal(
    getSelectionPath({
      stopId: "hochstetten",
      lineId: "S1",
      bundledLineIds: ["S11"],
      tripId: TRIP,
    }),
    `/stop/hochstetten/line/S1+S11/trip/${TRIP}`,
  );
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "hochstetten",
      lineId: "S1",
      bundledLineIds: ["S11"],
      tripId: TRIP,
    }),
    "/stop/hochstetten/line/S1+S11",
  );
});

test("a row tapped inside a bundle stays inside it, and any other row leaves it", () => {
  const row = (lineId: string) =>
    ({ id: "row", tripId: TRIP, lineId }) as Parameters<typeof getDepartureOpenPath>[0];
  const selection = { lineId: "S1", bundledLineIds: ["S11"] };

  // The sibling's own row: the same two lines in the same order, and only the trip changes.
  assert.equal(
    getDepartureOpenPath(row("S11"), "hochstetten", false, selection),
    `/stop/hochstetten/line/S1+S11/trip/${TRIP}`,
  );
  // Unpinning it comes back to the corridor the rider chose, not to one of its lines.
  assert.equal(
    getDepartureOpenPath(row("S11"), "hochstetten", true, selection),
    "/stop/hochstetten/line/S1+S11",
  );
  // A line that is not in the bundle is a different choice, and leads to that line alone.
  assert.equal(
    getDepartureOpenPath(row("S2"), "hochstetten", true, selection),
    "/stop/hochstetten/line/S2",
  );
});

test("the stop's own address is the only one its lines need", () => {
  // The former `/lines` narrowing is gone; an old link lands on the plain stop and is rewritten.
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
  const tripRoute = parseRoute(
    "#/stop/augartenstrasse/line/S11/trip/de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26",
  );
  // Selecting the trip must not read as a move: the diagram has already aimed at its vehicle.
  assert.equal(getViewStartKey(tripRoute), null);
  // Nor must moving along the line from one of its stops to the next: the diagram is still the
  // diagram, and it travels to the new stop rather than being opened again at the top.
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
  // Two stops read on their own are two views; read with a line, both place themselves instead.
  assert.notEqual(
    getViewStartKey(parseRoute("#/stop/marktplatz")),
    getViewStartKey(parseRoute("#/stop/europaplatz")),
  );
});

test("a ride carries the stop it was begun at, beside the one it is heading for", () => {
  assert.equal(routePaths.ride(TRIP), `/trip/${TRIP}`);
  assert.equal(routePaths.ride(TRIP, "europaplatz"), `/trip/${TRIP}/from/europaplatz`);
  assert.equal(
    routePaths.ride(TRIP, "europaplatz", "durlach-bahnhof"),
    `/trip/${TRIP}/from/europaplatz/to/durlach-bahnhof`,
  );
  // Either stop may be absent, and an Ausstieg alone must not be read as naming an origin.
  const marked = parseRoute(`#/trip/${TRIP}/to/durlach-bahnhof`);
  assert.equal(marked.originStopId, undefined);
  assert.equal(marked.alightingStopId, "durlach-bahnhof");
  const both = parseRoute(`#/trip/${TRIP}/from/europaplatz/to/durlach-bahnhof`);
  assert.equal(both.originStopId, "europaplatz");
  assert.equal(both.alightingStopId, "durlach-bahnhof");
  assert.equal(both.isRide, true);
  assert.equal(both.lineId, "S11");
  // Every level the address resolved to is written back, the origin included.
  assert.equal(
    getSelectionPath({
      stopId: "europaplatz",
      lineId: "S11",
      tripId: TRIP,
      isRide: true,
      alightingStopId: "durlach-bahnhof",
      originStopId: "europaplatz",
    }),
    `/trip/${TRIP}/from/europaplatz/to/durlach-bahnhof`,
  );
});

test("step up drops exactly one level of the address, and never reads live data for one", () => {
  // The chain, one rung at a time.
  assert.equal(
    getParentSelectionPath({ view: "stop", stopId: "europaplatz", lineId: "S11", tripId: TRIP }),
    "/stop/europaplatz/line/S11",
  );
  assert.equal(
    getParentSelectionPath({ view: "stop", stopId: "europaplatz", lineId: "S11" }),
    "/stop/europaplatz",
  );
  assert.equal(getParentSelectionPath({ view: "stop", stopId: "europaplatz" }), "/center");
  // The two home roots are the top; the views nested under it step back up to it.
  assert.equal(getParentSelectionPath({ view: "zentrum", stopId: "europaplatz" }), undefined);
  assert.equal(getParentSelectionPath({ view: "network", stopId: "europaplatz" }), undefined);
  assert.equal(getParentSelectionPath({ view: "notices", stopId: "europaplatz" }), "/center");
  assert.equal(getParentSelectionPath({ view: "nearby", stopId: "europaplatz" }), "/center");
});

test("a ride steps back to where it was begun, not to a stop the vehicle is running towards", () => {
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "hauptbahnhof",
      lineId: "S11",
      tripId: TRIP,
      isRide: true,
      originStopId: "europaplatz",
    }),
    `/stop/europaplatz/line/S11/trip/${TRIP}`,
  );
  // Pressed twice, it always reaches that trip's own stop — whatever the trip has since done.
  assert.equal(
    getParentSelectionPath({ view: "stop", stopId: "europaplatz", lineId: "S11", tripId: TRIP }),
    "/stop/europaplatz/line/S11",
  );
  // A ride opened from a shared link came from nowhere, and step up says so rather than inventing
  // a stop the rider has never seen.
  assert.equal(
    getParentSelectionPath({
      view: "stop",
      stopId: "hauptbahnhof",
      lineId: "S11",
      tripId: TRIP,
      isRide: true,
    }),
    "/center",
  );
});
