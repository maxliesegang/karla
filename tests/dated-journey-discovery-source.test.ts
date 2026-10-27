import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type {
  Feed,
  DatedJourneyRef,
  FeedStopEvent,
  FeedStopEventBoard,
  FeedTripInfo,
} from "../src/data/feed.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";

test("tomorrow's reused S7 code never replaces or refreshes today's active run", async (t) => {
  // Recorded 7 October 2026: today's departure at Gottesauer Platz, tomorrow's arrival at the
  // Pyramide under the same journey code, and tomorrow's trip.
  const fixture: {
    today: FeedStopEventBoard;
    tomorrow: FeedStopEventBoard;
    tomorrowTripInfo: FeedTripInfo;
  } = JSON.parse(readFileSync(new URL("./support/s7-date-reuse.json", import.meta.url), "utf8"));
  let now = Date.parse("2026-10-07T13:42:45Z");
  t.mock.method(Date, "now", () => now);
  const { today, tomorrow } = fixture;
  const requests: DatedJourneyRef[] = [];
  const client = {} as Feed;
  client.fetchStopEventBoard = async (_stop, options) => {
    if (options?.eventKind === "arrival") {
      now += 1_000;
      return tomorrow;
    }
    return today;
  };
  client.fetchTripInfo = async (journey) => {
    requests.push(journey);
    return journey.operatingDayRef === "2026-10-08"
      ? fixture.tomorrowTripInfo
      : { serverTime: new Date(now).toISOString(), calls: today.stopEvents[0].calls ?? [] };
  };
  const source = new TriasTransitSource(client);
  const board = await source.getStopEventBoard("gottesauer-platz");
  const active = board.stopEvents[0];
  const discovery = await source.getDatedJourneyDiscoveryReading(
    [{ stopId: "marktplatz", eventKind: "arrival" }],
    {
      maxAgeMs: 0,
      datedJourneyMaxAgeMs: 60_000,
      topologyMaxAgeMs: 0,
      horizonMs: 110_000,
    },
  );
  assert.equal(
    discovery.datedJourneyStopEvents.length,
    0,
    "tomorrow's row does not acquire today's calls",
  );
  const mixed = await source.getDatedJourneyDiscoveryReading(
    [
      { stopId: "gottesauer-platz", eventKind: "departure" },
      { stopId: "marktplatz", eventKind: "arrival" },
    ],
    { maxAgeMs: 0, datedJourneyMaxAgeMs: 60_000, topologyMaxAgeMs: 0, horizonMs: 110_000 },
  );
  assert.deepEqual(
    mixed.datedJourneyStopEvents.map((datedJourney) => datedJourney.id),
    [active.id],
  );
  now += 40_000;
  const refreshed = await source.getDatedJourney(active.id, 30_000);
  assert.equal(refreshed?.datedJourneyId, active.datedJourneyId);
  assert.equal(requests[0]?.operatingDayRef, "2026-10-07");
  assert.ok(requests.every((request) => request.operatingDayRef === "2026-10-07"));
});

/** Line 6 at Arbeitsagentur, its terminus: in from ZKM at 14:02, out again at 14:03. */

const sixRow = (eventKind: "arrival" | "departure"): FeedStopEvent => {
  const time = eventKind === "arrival" ? "2026-10-05T12:02:00.000Z" : "2026-10-05T12:03:00.000Z";
  return {
    stopPointId: "de:08212:64",
    stopPointName: "Arbeitsagentur",
    journeyRef: "six-inbound",
    operatingDayRef: "2026-10-05",
    datedJourneyId: "six-inbound@2026-10-05",
    lineId: "6",
    lineRef: "kvv:21006:E:H:s26",
    ptMode: "tram",
    destinationText: "Arbeitsagentur",
    minutesUntilDeparture: eventKind === "arrival" ? 2 : 3,
    bay: "2",
    status: "scheduled",
    timetabledDepartureTime: time,
    calls: [
      {
        stopName: "ZKM",
        stopPointId: "de:08212:65",
        timetabledDepartureTime: "2026-10-05T12:00:00.000Z",
      },
      {
        stopName: "Arbeitsagentur",
        bay: "2",
        stopPointId: "de:08212:64",
        isThisCall: true,
        ...(eventKind === "arrival"
          ? { timetabledArrivalTime: time }
          : { timetabledDepartureTime: time }),
      },
    ],
  };
};

const sixTripInfo: FeedTripInfo = {
  serverTime: "2026-10-05T12:00:00.000Z",
  calls: [
    {
      stopName: "ZKM",
      stopPointId: "de:08212:65",
      timetabledDepartureTime: "2026-10-05T12:00:00.000Z",
    },
    {
      stopName: "Arbeitsagentur",
      stopPointId: "de:08212:64",
      isThisCall: true,
      timetabledArrivalTime: "2026-10-05T12:02:00.000Z",
      timetabledDepartureTime: "2026-10-05T12:03:00.000Z",
    },
  ],
};

const board = (stopPointId: string, stopEvents: FeedStopEvent[]): FeedStopEventBoard => ({
  stopPointId,
  stopName: "Arbeitsagentur",
  serverTime: "2026-10-05T12:00:00.000Z",
  stopEvents,
});

test("arrival discovery shares one trip read with departure discovery and never answers a passenger board", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T12:00:00Z") });
  let journeyReads = 0;
  const eventKinds: (string | undefined)[] = [];
  const client = {
    fetchStopEventBoard: async (stopPointId, options) => {
      eventKinds.push(options?.eventKind);
      return board(stopPointId, [sixRow(options?.eventKind ?? "departure")]);
    },
    fetchTripInfo: async () => {
      journeyReads += 1;
      return sixTripInfo;
    },
  } satisfies Partial<Feed> as unknown as Feed;
  const source = new TriasTransitSource(client);
  const reading = await source.getDatedJourneyDiscoveryReading(
    [
      { stopId: "arbeitsagentur", eventKind: "arrival" },
      { stopId: "arbeitsagentur", eventKind: "departure" },
    ],
    { maxAgeMs: 90_000, datedJourneyMaxAgeMs: 0, topologyMaxAgeMs: 300_000, horizonMs: 110_000 },
  );
  assert.equal(reading.datedJourneyStopEvents.length, 1);
  assert.equal(journeyReads, 1);
  assert.equal(reading.failedStopIds.length, 0);
  const stopEvents = await source.getStopEventBoard("arbeitsagentur");
  assert.equal(stopEvents.stopEvents[0].timetabledDepartureTime, "2026-10-05T12:03:00.000Z");
  assert.ok(!stopEvents.stopEvents[0].id.startsWith("arrival:"));
  assert.ok(eventKinds.includes("arrival"));
});

test("a crowded board discovers a rail direction known only from runs read elsewhere", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T12:00:00Z") });
  const sparseDirection = "kvv:22304:E:H:s26";
  const s4Row: FeedStopEvent = {
    ...sixRow("departure"),
    journeyRef: "s4",
    datedJourneyId: undefined,
    lineId: "S4",
    lineRef: sparseDirection,
    ptMode: "lightRail",
  };
  const requests: { stopPointId: string; lineIds?: readonly string[]; limit?: number }[] = [];
  const client = {
    fetchStopEventBoard: async (stopPointId, options = {}) => {
      // ZKM's board carries an S4 calling on at Arbeitsagentur.
      if (stopPointId === "de:08212:65") return board(stopPointId, [s4Row]);
      requests.push({ stopPointId, lineIds: options.lineIds, limit: options.limit });
      const onlySparse = options.lineIds?.length === 1 && options.lineIds[0] === sparseDirection;
      return board(
        stopPointId,
        onlySparse ? [s4Row] : Array.from({ length: 20 }, () => sixRow("departure")),
      );
    },
    fetchTripInfo: async () => ({
      ...sixTripInfo,
      calls: sixTripInfo.calls.map((call) =>
        call.isThisCall ? { ...call, timetabledDepartureTime: undefined } : call,
      ),
    }),
  } satisfies Partial<Feed> as unknown as Feed;
  const source = new TriasTransitSource(client);
  await source.getStopEventBoard("zkm", { includeCalls: true });
  const reading = await source.getDatedJourneyDiscoveryReading(
    [{ stopId: "arbeitsagentur", eventKind: "departure" }],
    { maxAgeMs: 0, datedJourneyMaxAgeMs: 0, topologyMaxAgeMs: 0, horizonMs: 110_000 },
  );
  assert.ok(
    requests.some(({ lineIds }) => lineIds?.length === 1 && lineIds[0] === sparseDirection),
  );
  assert.ok(reading.datedJourneyStopEvents.some((datedJourney) => datedJourney.lineId === "S4"));
  assert.ok(requests.filter(({ lineIds }) => !lineIds).every(({ limit }) => limit === 20));
});
