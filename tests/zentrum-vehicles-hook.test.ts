import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import type { KvvDeparture, KvvTrip } from "../src/data/kvv-efa-parsers.ts";
import { KvvTransitSource, transitSource } from "../src/data/transit-source.ts";
import { useZentrumVehicles } from "../src/hooks/zentrum-vehicles.ts";
import { createCall, run } from "./support/calls.ts";

const { act } = await import("react");
const flush = () =>
  act(async () => {
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
  });

test("a discovered Zentrum run shows new predictions on the next 30-second refresh", async (t) => {
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
    tripCalls: calls,
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
      tripCalls: calls.map((call) => ({ ...call, delayMinutes: 2 })),
    };
  };
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("europaplatz");
  t.mock.method(transitSource, "getRunDiscoveryReading", async () => ({
    runDepartures: board.departures,
    clockBoard: board,
    failedStopIds: [],
  }));
  t.mock.method(transitSource, "getRun", source.getRun.bind(source));
  t.mock.method(transitSource, "findRun", source.findRun.bind(source));
  t.mock.method(transitSource, "subscribeToRuns", source.subscribeToRuns.bind(source));
  t.mock.method(transitSource, "getRunVersion", source.getRunVersion.bind(source));
  const vehicles = await renderHook(() => useZentrumVehicles([]), {});
  try {
    await flush();
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
    assert.equal(tripFetches, 1);
    assert.equal(source.findRun(board.departures[0].id)?.tripCalls?.[0].delayMinutes, 2);
    assert.equal(vehicles.current.runDepartures[0]?.tripCalls?.[0].delayMinutes, 2);
  } finally {
    await vehicles.unmount();
  }
});
