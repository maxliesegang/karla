import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { Feed } from "../src/data/feed.ts";
import type { FeedStopEvent, FeedTripInfo } from "../src/data/feed.ts";
import { TriasTransitSource, transitSource } from "../src/data/transit-source.ts";
import type { StopEvent, StopEventBoard } from "../src/data/transit-types.ts";
import { useZentrumVehicles } from "../src/hooks/zentrum-vehicles.ts";
import { createCall, datedJourney } from "./support/calls.ts";

const { act } = await import("react");
const flush = () =>
  act(async () => {
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
  });

/** The app's source discovers `journeys` on `board` and reads them through `source`. */
const serveDiscovery = (
  t: TestContext,
  source: TriasTransitSource,
  board: StopEventBoard,
  datedJourneys: readonly StopEvent[],
) => {
  t.mock.method(transitSource, "getDatedJourneyDiscoveryReading", async () => ({
    datedJourneyStopEvents: datedJourneys,
    clockBoard: board,
    failedStopIds: [],
  }));
  t.mock.method(transitSource, "getDatedJourney", source.getDatedJourney.bind(source));
  t.mock.method(transitSource, "findDatedJourney", source.findDatedJourney.bind(source));
  t.mock.method(
    transitSource,
    "subscribeToDatedJourneys",
    source.subscribeToDatedJourneys.bind(source),
  );
  t.mock.method(
    transitSource,
    "getDatedJourneyVersion",
    source.getDatedJourneyVersion.bind(source),
  );
};

test("a discovered Zentrum journey is placed from its own reads, never its board's calls", async (t) => {
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
  const calls = datedJourney([
    call("europaplatz", 0),
    call("marktplatz", 1),
    call("kronenplatz", 2),
    call("durlacher-tor", 3),
  ]);
  const stopEvent: FeedStopEvent = {
    stopPointId: "de:08212:1004",
    stopPointName: "Europaplatz (U)",
    journeyRef: "test-journey",
    lineId: "S2",
    lineRef: "kvv:S2",
    ptMode: "tram",
    destinationText: "Spöck",
    minutesUntilDeparture: 0,
    bay: "2(U)",
    status: "realtime",
    timetabledDepartureTime: new Date(start).toISOString(),
    // The board's own observation, which must never place the mark.
    calls: calls.map((call) => ({ ...call, delayMinutes: 5 })),
    operatingDayRef: "2026-10-07",
  };
  const client = {} as Feed;
  client.fetchStopEventBoard = async () => ({
    stopPointId: "de:08212:1004",
    stopName: "Europaplatz",
    serverTime: new Date(start).toISOString(),
    stopEvents: [stopEvent],
  });
  let journeyFetches = 0;
  client.fetchTripInfo = async (): Promise<FeedTripInfo> => {
    journeyFetches += 1;
    return {
      serverTime: new Date(now).toISOString(),
      calls: calls.map((call) => ({ ...call, delayMinutes: journeyFetches === 1 ? 0 : 2 })),
    };
  };
  const source = new TriasTransitSource(client);
  const board = await source.getStopEventBoard("europaplatz");
  serveDiscovery(t, source, board, board.stopEvents);
  const vehicles = await renderHook(() => useZentrumVehicles([]), {});
  try {
    await flush();
    assert.equal(journeyFetches, 1);
    assert.equal(vehicles.current.datedJourneyStopEvents[0]?.calls?.[0].delayMinutes, 0);
    const end = start + 30_000;
    while (true) {
      const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending || pending[1].at > end) break;
      now = pending[1].at;
      timers.delete(pending[0]);
      pending[1].callback();
      await flush();
    }
    assert.equal(journeyFetches, 2);
    assert.equal(source.findDatedJourney(board.stopEvents[0].id)?.calls?.[0].delayMinutes, 2);
    assert.equal(vehicles.current.datedJourneyStopEvents[0]?.calls?.[0].delayMinutes, 2);
  } finally {
    await vehicles.unmount();
  }
});

test("a journey still far from the plan is left off it but kept for travel times", async (t) => {
  const start = Date.parse("2026-10-07T13:20:00Z");
  t.mock.method(Date, "now", () => start);
  const call = createCall(start);
  const calls = datedJourney([
    call("weinweg", 13),
    call("tullastrasse", 15),
    call("gottesauer-platz", 16),
    call("durlacher-tor", 18),
    call("kronenplatz", 19),
  ]);
  const client = {} as Feed;
  client.fetchStopEventBoard = async () => ({
    stopPointId: "de:08212:7",
    stopName: "Tullastraße",
    serverTime: new Date(start).toISOString(),
    stopEvents: [
      {
        stopPointId: "de:08212:7",
        stopPointName: "Tullastraße/Alter Schlachthof",
        journeyRef: "test-journey",
        lineId: "S5",
        lineRef: "kvv:S5",
        ptMode: "tram",
        destinationText: "Rheinbergstraße",
        minutesUntilDeparture: 15,
        bay: "1b",
        status: "realtime",
        timetabledDepartureTime: new Date(start + 15 * 60_000).toISOString(),
        operatingDayRef: "2026-10-07",
      },
    ],
  });
  client.fetchTripInfo = async () => ({ serverTime: new Date(start).toISOString(), calls });
  const source = new TriasTransitSource(client);
  const board = await source.getStopEventBoard("tullastrasse");
  const discovered = await source.getDatedJourney(board.stopEvents[0].id);
  assert.ok(discovered?.calls?.length);
  serveDiscovery(t, source, board, [discovered]);
  const vehicles = await renderHook(() => useZentrumVehicles([]), {});
  try {
    await flush();
    assert.deepEqual(vehicles.current.datedJourneyStopEvents, []);
    assert.deepEqual(
      vehicles.current.travelDatedJourneys.map(({ lineId }) => lineId),
      ["S5"],
    );
  } finally {
    await vehicles.unmount();
  }
});
