import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "window", { value: { location: { search: "" } } });
const { parseRoute } = await import("../src/routing.ts");
const { describePanelChange, getViewLayout, isObservedNetworkInView, isStationBoardStopView } =
  await import("../src/view-layout.ts");

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
      tripId: route.tripId,
      hasSelectedDeparture: Boolean(route.tripId),
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
  const home = layoutFor("#/center");
  const line = layoutFor("#/stop/marktplatz/line/2");
  assert.equal(describePanelChange(home, line), "both");
  assert.equal(describePanelChange(line, layoutFor("#/stop/marktplatz/line/2")), "none");
});

test("the home keeps one key across its tabs, so its search field survives the switch", () => {
  assert.equal(layoutFor("#/center").primaryKey, layoutFor("#/network/city").primaryKey);
  assert.equal(layoutFor("#/center").homeView, "core");
  assert.equal(layoutFor("#/stop/marktplatz").homeView, undefined);
});

test("step up drops one level, and the nearby list returns to the page it corrected", () => {
  assert.equal(layoutFor("#/stop/marktplatz/line/2").backPath, "/stop/marktplatz");
  assert.equal(layoutFor("#/stop/marktplatz").backPath, "/center");
  assert.equal(layoutFor("#/center").backPath, undefined);
  assert.equal(
    layoutFor("#/nearby", {}, { nearbyReturnStopId: "marktplatz" }).backPath,
    "/stop/marktplatz",
  );
  assert.equal(layoutFor("#/nearby").backPath, "/center");
});

test("an unattended station board is the stop view alone, and reads nothing else", () => {
  const board = layoutFor("#/stop/marktplatz", {}, { isStationBoardMode: true });
  assert.equal(board.isStationBoardView, true);
  assert.equal(board.hasPrimaryPanel, false);
  assert.equal(board.hasDepartureBoard, false);
  assert.equal(isStationBoardStopView("core", true), false);
  assert.equal(isStationBoardStopView("stop", false), false);
});

test("the observation cycle is only read from where a view actually shows it", () => {
  assert.equal(isObservedNetworkInView("core"), true);
  assert.equal(isObservedNetworkInView("network"), true);
  assert.equal(isObservedNetworkInView("nearby"), true);
  assert.equal(isObservedNetworkInView("line"), false);
  assert.equal(isObservedNetworkInView("stop"), false);
});
