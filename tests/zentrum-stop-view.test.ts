import assert from "node:assert/strict";
import test from "node:test";
import type { DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { getZentrumStopView } from "../src/lib/zentrum-stop-view.ts";
import { createDeparture } from "./support/fixtures.ts";

const at = (minute: number) => `2026-09-04T12:${String(minute).padStart(2, "0")}:00+02:00`;
const instant = (minute: number) => Date.parse(at(minute));
const call = (localStopId: string, minute: number, delayMinutes?: number): TripCall => ({
  localStopId,
  stopName: localStopId,
  scheduledArrivalTime: at(minute),
  scheduledDepartureTime: at(minute),
  delayMinutes,
});

test("split destinations rank by arrival even when a farther ride is shorter", () => {
  const departures = [
    createDeparture({ id: "soon", tripCalls: [call("europaplatz", 1), call("marktplatz", 5)] }),
    createDeparture({ id: "later", tripCalls: [call("europaplatz", 10), call("karlstor", 11)] }),
  ];
  const view = getZentrumStopView(
    "destinations",
    "europaplatz",
    null,
    [],
    departures,
    instant(0),
    "split",
  );
  assert.deepEqual(
    view.reachableStops.map(({ nodeId }) => nodeId),
    ["marktplatz", "karlstor"],
  );
  assert.deepEqual(
    view.reachableStops.map(({ minutes }) => minutes),
    [4, 1],
  );
});

test("an unanswered board remains loading, while an answered empty board has no rows", () => {
  const loading = getZentrumStopView(
    "departures",
    "marktplatz",
    null,
    [],
    [],
    instant(0),
    "arrival",
  );
  assert.equal(loading.rows, undefined);
  assert.deepEqual(loading.reachableStops, []);
  const board: DepartureBoard = {
    stopId: "marktplatz",
    receivedAt: instant(0),
    feedUpdatedAt: at(0),
    dataStatus: "live",
    departures: [],
  };
  const answered = getZentrumStopView(
    "departures",
    "marktplatz",
    board,
    [],
    [],
    instant(0),
    "arrival",
  );
  assert.deepEqual(answered.rows, []);
  assert.equal(answered.stopMinutesByNodeId, undefined);
});

test("the destination list and map share the selected ride's minutes and prediction source", () => {
  const departures = [
    createDeparture({
      id: "slow",
      lineId: "2",
      tripCalls: [call("europaplatz", 1, 0), call("marktplatz", 5, 0)],
    }),
    createDeparture({
      id: "fast",
      lineId: "S1",
      tripCalls: [call("europaplatz", 4), call("marktplatz", 6)],
    }),
  ];
  for (const measure of ["arrival", "ride"] as const) {
    const view = getZentrumStopView(
      "destinations",
      "europaplatz",
      null,
      [],
      departures,
      instant(0),
      measure,
    );
    assert.equal(view.rows, undefined);
    assert.equal(view.reachableStops.length, 1);
    const stop = view.reachableStops[0];
    assert.equal(stop.nodeId, "marktplatz");
    assert.equal(stop.departure.id, measure === "arrival" ? "slow" : "fast");
    assert.equal(stop.minutes, measure === "arrival" ? 5 : 2);
    assert.deepEqual(view.stopMinutesByNodeId?.get(stop.nodeId), {
      minutes: stop.minutes,
      lineId: stop.lineId,
      measure,
      sourceLabel: measure === "arrival" ? "nach Echtzeitprognose" : "nach Fahrplan",
    });
    assert.equal(view.overlay.corridorIdsByLineId.size, 1);
    assert.ok(view.overlay.corridorIdsByLineId.has(stop.lineId));
  }
});

test("destinations are ordered by the chosen measure, using arrival time to break ties", () => {
  const departures = [
    createDeparture({
      id: "near",
      tripCalls: [call("europaplatz", 1), call("karlstor", 3)],
    }),
    createDeparture({
      id: "later",
      tripCalls: [call("europaplatz", 4), call("marktplatz", 5)],
    }),
    createDeparture({
      id: "tie",
      tripCalls: [call("europaplatz", 4), call("kronenplatz", 6)],
    }),
  ];
  for (const measure of ["arrival", "ride"] as const) {
    const view = getZentrumStopView(
      "destinations",
      "europaplatz",
      null,
      [],
      departures,
      instant(0),
      measure,
    );
    assert.deepEqual(
      view.reachableStops.map(({ nodeId }) => nodeId),
      measure === "arrival"
        ? ["karlstor", "marktplatz", "kronenplatz"]
        : ["marktplatz", "karlstor", "kronenplatz"],
    );
  }
});

test("the split measure takes the soonest arrival and reads its ride and wait apart", () => {
  const departures = [
    createDeparture({
      id: "slow",
      lineId: "2",
      tripCalls: [call("europaplatz", 1), call("marktplatz", 5)],
    }),
    createDeparture({
      id: "fast",
      lineId: "S1",
      tripCalls: [call("europaplatz", 4), call("marktplatz", 6)],
    }),
    createDeparture({
      id: "far",
      lineId: "3",
      tripCalls: [call("europaplatz", 2), call("karlstor", 3)],
    }),
  ];
  const view = getZentrumStopView(
    "destinations",
    "europaplatz",
    null,
    [],
    departures,
    instant(0),
    "split",
  );
  const marktplatz = view.reachableStops.find(({ nodeId }) => nodeId === "marktplatz");
  assert.equal(marktplatz?.departure.id, "slow");
  assert.equal(marktplatz?.minutes, 4);
  assert.equal(marktplatz?.waitMinutes, 1);
  assert.deepEqual(
    view.reachableStops.map(({ nodeId }) => nodeId),
    ["karlstor", "marktplatz"],
  );
  assert.equal(view.stopMinutesByNodeId?.get("marktplatz")?.waitMinutes, 1);
});
