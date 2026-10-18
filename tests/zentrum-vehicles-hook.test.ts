import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import type { KvvDeparture, KvvTrip } from "../src/data/kvv-feed.ts";
import { KvvTransitSource, transitSource } from "../src/data/transit-source.ts";
import type { Departure, DepartureBoard } from "../src/data/transit-types.ts";
import { useZentrumVehicles } from "../src/hooks/zentrum-vehicles.ts";
import { createCall, run } from "./support/calls.ts";

const { act } = await import("react");
const flush = () =>
  act(async () => {
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
  });

/** The app's source discovers `runs` on `board` and reads them through `source`. */
const serveDiscovery = (
  t: TestContext,
  source: KvvTransitSource,
  board: DepartureBoard,
  runs: readonly Departure[],
) => {
  t.mock.method(transitSource, "getRunDiscoveryReading", async () => ({
    runDepartures: runs,
    clockBoard: board,
    failedStopIds: [],
  }));
  t.mock.method(transitSource, "getRun", source.getRun.bind(source));
  t.mock.method(transitSource, "findRun", source.findRun.bind(source));
  t.mock.method(transitSource, "subscribeToRuns", source.subscribeToRuns.bind(source));
  t.mock.method(transitSource, "getRunVersion", source.getRunVersion.bind(source));
};

test("a discovered Zentrum run is placed from its own reads, never its board's calls", async (t) => {
  const start = Date.parse("2026-10-07T13:20:00Z");
  let now = start;
  t.mock.method(Date, "now", () => now);
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  t.mock.method(window, "setTimeout", (callback: TimerHandler, delay = 0) => {
    assert.equal(typeof callback, "function");
    const id = ++nextTimer;
    timers.set(id, {
      at: now + delay,
      callback: () => {
        if (typeof callback === "function") callback();
      },
    });
    return id;
  });
  t.mock.method(window, "clearTimeout", (id: number) => {
    timers.delete(id);
  });
  const call = createCall(start);
  const calls = run([
    call("europaplatz", 0),
    call("marktplatz", 1),
    call("kronenplatz", 2),
    call("durlacher-tor", 3),
  ]);
  const departure: KvvDeparture = {
    stopPointId: "7001004",
    stopPointName: "Europaplatz (U)",
    tripId: "test-trip",
    lineId: "S2",
    transportMode: "tram",
    destination: "Spöck",
    minutesUntilDeparture: 0,
    platformCode: "2(U)",
    status: "realtime",
    scheduledDepartureTime: new Date(start).toISOString(),
    // The board's own observation, which must never place the mark.
    tripCalls: calls.map((call) => ({ ...call, delayMinutes: 5 })),
    tripLocator: {
      tripCode: "531",
      line: "kvv:21012:E:R:s26",
      stopPointId: "7001004",
      date: "20261007",
      time: "1520",
    },
  };
  const client = new KvvEfaClient();
  client.fetchDepartureBoard = async () => ({
    stopPointId: "7001004",
    stopName: "Europaplatz",
    serverTime: new Date(start).toISOString(),
    servingLines: [],
    departures: [departure],
  });
  let tripFetches = 0;
  client.fetchTrip = async (): Promise<KvvTrip> => {
    tripFetches += 1;
    return {
      serverTime: new Date(now).toISOString(),
      tripCalls: calls.map((call) => ({ ...call, delayMinutes: tripFetches === 1 ? 0 : 2 })),
    };
  };
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("europaplatz");
  serveDiscovery(t, source, board, board.departures);
  const vehicles = await renderHook(() => useZentrumVehicles([]), {});
  try {
    await flush();
    assert.equal(tripFetches, 1);
    assert.equal(vehicles.current.runDepartures[0]?.tripCalls?.[0].delayMinutes, 0);
    const end = start + 30_000;
    while (true) {
      const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending || pending[1].at > end) break;
      now = pending[1].at;
      timers.delete(pending[0]);
      pending[1].callback();
      await flush();
    }
    assert.equal(tripFetches, 2);
    assert.equal(source.findRun(board.departures[0].id)?.tripCalls?.[0].delayMinutes, 2);
    assert.equal(vehicles.current.runDepartures[0]?.tripCalls?.[0].delayMinutes, 2);
  } finally {
    await vehicles.unmount();
  }
});

test("a run still far from the plan is left off it but kept for travel times", async (t) => {
  const start = Date.parse("2026-10-07T13:20:00Z");
  t.mock.method(Date, "now", () => start);
  const call = createCall(start);
  const calls = run([
    call("weinweg", 13),
    call("tullastrasse", 15),
    call("gottesauer-platz", 16),
    call("durlacher-tor", 18),
    call("kronenplatz", 19),
  ]);
  const client = new KvvEfaClient();
  client.fetchDepartureBoard = async () => ({
    stopPointId: "7000007",
    stopName: "Tullastraße",
    serverTime: new Date(start).toISOString(),
    servingLines: [],
    departures: [
      {
        stopPointId: "7000007",
        stopPointName: "Tullastraße/Alter Schlachthof",
        tripId: "test-trip",
        lineId: "S5",
        transportMode: "tram",
        destination: "Rheinbergstraße",
        minutesUntilDeparture: 15,
        platformCode: "1b",
        status: "realtime",
        scheduledDepartureTime: new Date(start + 15 * 60_000).toISOString(),
        tripLocator: {
          tripCode: "305",
          line: "kvv:22305:E:R:s26",
          stopPointId: "7000007",
          date: "20261007",
          time: "1535",
        },
      },
    ],
  });
  client.fetchTrip = async () => ({ serverTime: new Date(start).toISOString(), tripCalls: calls });
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("tullastrasse");
  const discovered = await source.getRun(board.departures[0].id);
  assert.ok(discovered?.tripCalls?.length);
  serveDiscovery(t, source, board, [discovered]);
  const vehicles = await renderHook(() => useZentrumVehicles([]), {});
  try {
    await flush();
    assert.deepEqual(vehicles.current.runDepartures, []);
    assert.deepEqual(
      vehicles.current.travelRuns.map(({ lineId }) => lineId),
      ["S5"],
    );
  } finally {
    await vehicles.unmount();
  }
});
