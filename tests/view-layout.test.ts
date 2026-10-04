import assert from "node:assert/strict";
import test from "node:test";

import { parseRoute, routePaths } from "../src/routing.ts";
import {
  describePanelChange,
  getViewLayout,
  readsObservedNetwork,
  isStationBoardStopView,
} from "../src/view-layout.ts";

const TRIP = "de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s26";
const OTHER_TRIP = "de:kvv:00S11_:.kvv-22-311-E.5.T0.161.s27";

const layoutFor = (
  hash: string,
  selection: Partial<Parameters<typeof getViewLayout>[0]["selection"]> = {},
  options: { isStationBoardMode?: boolean; nearbyReturnStopId?: string } = {},
) => {
  const route = parseRoute(hash);
  return getViewLayout({
    route,
    selection: {
      stopId: route.stopId || "europaplatz",
      lineId: route.lineId || undefined,
      addressId: route.addressId,
      hasSelectedDeparture: Boolean(route.addressId),
      isRide: route.isRide,
      originStopId: route.originStopId,
      ...selection,
    },
    isStationBoardMode: options.isStationBoardMode ?? false,
    nearbyReturnStopId: options.nearbyReturnStopId,
  });
};

test("a stop is its board alone, and a line beside it opens the second panel", () => {
  const stop = layoutFor("#/stop/marktplatz");
  assert.equal(stop.activeView, "stop");
  assert.equal(stop.isStopBoardOnly, true);
  assert.equal(stop.hasPrimaryPanel, false);
  assert.equal(stop.hasDepartureBoard, true);
  assert.equal(stop.isSinglePanel, true);

  const line = layoutFor("#/stop/marktplatz/line/2");
  assert.equal(line.activeView, "line");
  assert.equal(line.hasPrimaryPanel, true);
  assert.equal(line.hasDepartureBoard, true);
  assert.equal(line.isSinglePanel, false);
});

test("the ride sets the board aside as soon as the address names it", () => {
  const ride = layoutFor(`#/trip/${TRIP}/from/europaplatz`, { stopId: "europaplatz" });
  assert.equal(ride.isRideInView, true);
  assert.equal(ride.hasDepartureBoard, false);
  assert.equal(ride.isSinglePanel, true);

  // Still waiting for the boards to answer: the board must not flash open in the meantime.
  const pending = layoutFor(`#/trip/${TRIP}`, {
    stopId: "europaplatz",
    hasSelectedDeparture: false,
  });
  assert.equal(pending.isRideInView, false);
  assert.equal(pending.hasDepartureBoard, false);
});

test("another trip of the same line is the same diagram, which glides rather than re-enters", () => {
  const before = layoutFor(`#/stop/marktplatz/line/2/trip/${TRIP}`);
  const after = layoutFor(`#/stop/marktplatz/line/2/trip/${OTHER_TRIP}`);
  assert.equal(before.primaryKey, after.primaryKey);
  assert.equal(describePanelChange(before, after), "none");
});

test("picking another line changes only the panel beside the board", () => {
  const before = layoutFor(`#/stop/marktplatz/line/2/trip/${TRIP}`);
  const after = layoutFor("#/stop/marktplatz/line/4");
  assert.equal(before.boardKey, after.boardKey);
  assert.notEqual(before.primaryKey, after.primaryKey);
  assert.equal(describePanelChange(before, after), "primary");
});

test("boarding a trip is a thing of its own, and leaving it comes back to the line", () => {
  const line = layoutFor(`#/stop/marktplatz/line/2/trip/${TRIP}`);
  const ride = layoutFor(`#/trip/${TRIP}/from/marktplatz`, { stopId: "marktplatz" });
  assert.notEqual(line.primaryKey, ride.primaryKey);
  assert.equal(describePanelChange(line, ride), "primary");
  assert.equal(describePanelChange(ride, line), "primary");
});

test("walking to another stop changes only the board beside the diagram", () => {
  const before = layoutFor("#/stop/marktplatz/line/2");
  const after = layoutFor("#/stop/europaplatz/line/2");
  assert.equal(before.primaryKey, after.primaryKey);
  assert.notEqual(before.boardKey, after.boardKey);
  assert.equal(describePanelChange(before, after), "board");
});

test("arriving from elsewhere changes both halves, and a refresh changes neither", () => {
  const home = layoutFor("#/experiment/center");
  const line = layoutFor("#/stop/marktplatz/line/2");
  assert.equal(describePanelChange(home, line), "both");
  assert.equal(describePanelChange(line, layoutFor("#/stop/marktplatz/line/2")), "none");
});

test("the home is its own page, and the three pages it names stand on their own", () => {
  const home = layoutFor("#/");
  assert.equal(home.activeView, "home");
  assert.equal(home.isHomeView, true);
  assert.equal(home.isStandaloneView, true);
  assert.equal(home.hasPrimaryPanel, true);
  assert.equal(home.hasDepartureBoard, false);
  assert.equal(home.isSinglePanel, true);

  for (const hash of ["#/experiment/center", "#/network/city"]) {
    const page = layoutFor(hash);
    assert.equal(page.isHomeView, false, hash);
    assert.equal(page.isStandaloneView, true, hash);
    assert.equal(page.hasDepartureBoard, false, hash);
    assert.equal(page.hasPrimaryPanel, true, hash);
  }
  // Separate pages are separate things in the panel: each re-enters on its own.
  assert.notEqual(
    layoutFor("#/experiment/center").primaryKey,
    layoutFor("#/network/city").primaryKey,
  );
});

test("the settings stand on their own, read no network, and step back up to the home", () => {
  const settings = layoutFor("#/settings");
  assert.equal(settings.activeView, "settings");
  assert.equal(settings.isStandaloneView, true);
  assert.equal(settings.hasPrimaryPanel, true);
  assert.equal(settings.hasDepartureBoard, false);
  assert.equal(settings.backPath, "/");
  assert.equal(readsObservedNetwork("settings"), false);
});

test("step up drops one level, and the nearby list returns to the page it corrected", () => {
  assert.equal(layoutFor("#/stop/marktplatz/line/2").backPath, "/stop/marktplatz");
  assert.equal(layoutFor("#/stop/marktplatz").backPath, "/");
  assert.equal(layoutFor("#/experiment/center").backPath, "/");
  assert.equal(layoutFor("#/experiment/center/stop/marktplatz").backPath, "/experiment/center");
  assert.equal(layoutFor("#/experiment/center/full/line/2").backPath, "/experiment/center/full");
  assert.equal(
    layoutFor("#/nearby", {}, { nearbyReturnStopId: "marktplatz" }).backPath,
    "/stop/marktplatz",
  );
  assert.equal(layoutFor("#/nearby").backPath, "/");
});

test("an unattended station board is the stop view alone, and reads nothing else", () => {
  const board = layoutFor("#/stop/marktplatz", {}, { isStationBoardMode: true });
  assert.equal(board.isStationBoardView, true);
  assert.equal(board.hasPrimaryPanel, false);
  assert.equal(board.hasDepartureBoard, false);
  assert.equal(isStationBoardStopView("experiment", true), false);
  assert.equal(isStationBoardStopView("stop", false), false);
});

test("the observation cycle is only read from where a view actually shows it", () => {
  assert.equal(readsObservedNetwork("home"), false);
  assert.equal(readsObservedNetwork("experiment"), true);
  assert.equal(readsObservedNetwork("network"), true);
  assert.equal(readsObservedNetwork("nearby"), true);
  assert.equal(readsObservedNetwork("line"), false);
  assert.equal(readsObservedNetwork("stop"), false);
});

test("the plan is lit by a followed line or by an opened stop, and the address says which", () => {
  const opened = parseRoute("#/experiment/center/full/stop/marktplatz");
  assert.equal(opened.view, "experiment");
  assert.equal(opened.zentrumStopId, "marktplatz");
  assert.equal(opened.zentrumLineId, "");
  assert.equal(opened.isMapFullscreen, true);
  assert.equal(
    routePaths.zentrum({ stopId: "marktplatz" }, true),
    "/experiment/center/full/stop/marktplatz",
  );
  assert.equal(routePaths.zentrum({ lineId: "S1" }), "/experiment/center/line/S1");
  assert.equal(routePaths.zentrum(), "/experiment/center");
});

test("the geographic map opens a stop of its own, and closing it returns to the map", () => {
  const opened = parseRoute("#/experiment/geo/full/stop/durlach-bahnhof");
  assert.equal(opened.experimentMap, "geo");
  assert.equal(opened.mapStopId, "durlach-bahnhof");
  assert.equal(opened.zentrumStopId, "");
  assert.equal(opened.isMapFullscreen, true);
  assert.equal(
    routePaths.map("geo", "durlach-bahnhof", true),
    "/experiment/geo/full/stop/durlach-bahnhof",
  );
  assert.equal(parseRoute("#/experiment/center").experimentMap, "center");
  assert.equal(layoutFor("#/experiment/geo/stop/7001521").backPath, "/experiment/geo");
  assert.equal(parseRoute("#/experiment/region/stop/entenfang").experimentMap, "region");
  assert.equal(layoutFor("#/experiment/region/stop/entenfang").backPath, "/experiment/region");
});

test("the experiment page opens the Zentrum plan, and the plan's earlier addresses still resolve", () => {
  assert.equal(routePaths.experiment(), "/experiment");
  assert.deepEqual(parseRoute(routePaths.experiment()), parseRoute(routePaths.zentrum()));
  assert.deepEqual(parseRoute("#/experiment"), parseRoute("#/experiment/center"));
  assert.deepEqual(parseRoute("#/center"), parseRoute("#/experiment/center"));
  assert.deepEqual(parseRoute("#/center/stops"), parseRoute("#/experiment/center"));
  assert.deepEqual(
    parseRoute("#/center/full/line/2"),
    parseRoute("#/experiment/center/full/line/2"),
  );
});
