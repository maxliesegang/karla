import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import {
  KvvEfaError,
  parseStopEventBoardResponse,
  parseTripInfoResponse,
} from "../src/data/kvv-efa-parsers.ts";
import {
  type KvvStopEvent,
  type KvvStopEventBoard,
  type KvvTripInfo,
  type KvvCall,
  type KvvJourneyLocator,
} from "../src/data/kvv-feed.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
import {
  DATED_JOURNEY_ENDED_GRACE_MS,
  DATED_JOURNEY_READING_MAX_AGE_MS,
  DATED_JOURNEY_READING_STORE_CAPACITY,
} from "../src/data/dated-journey-reading-store.ts";
import { DEFAULT_BOARD_MAX_AGE_MS } from "../src/data/transit-source.ts";
import { DATED_JOURNEY_MARK_RETENTION_GRACE_MS } from "../src/lib/line-dated-journey-stop-events.ts";
import { getCallsAfterStop } from "../src/lib/calls.ts";
import {
  createDatedJourneyMotions,
  getDatedJourneyPlacement,
} from "../src/lib/vehicle-positioning.ts";
import { createStopEvent } from "./support/fixtures.ts";

const locator: KvvJourneyLocator = {
  journeyCode: "888",
  lineRef: "kvv:22304:E:H:s26",
  stopPointId: "7001001",
  date: "20260826",
  time: "0730",
};

const journeyPayload = {
  parameters: [{ name: "serverTime", value: "2026-08-26T07:30:45" }],
  vehicleCallAtStop: { stopID: "7001001", tC: "888", time: "07:30", line: "kvv:22304:E:H:s26" },
  stopSeq: [
    {
      nameWO: "Durlacher Tor/KIT-Campus Süd (U)",
      place: "Karlsruhe",
      platformName: "Gleis 1(U)",
      realtimeStatus: "TRIP_CANCELLED",
      ref: {
        id: "7001001",
        coords: "8.416531,49.009020",
        depDateTimeSec: "20260826 07:30:00",
        depDelay: "-9999",
        depValid: "1",
      },
    },
    {
      nameWO: "Kronenplatz (U)",
      place: "Karlsruhe",
      platformName: "Gleis 1(U)",
      realtimeStatus: "TRIP_CANCELLED",
      ref: {
        id: "7001002",
        coords: "8.409794,49.009362",
        arrDateTimeSec: "20260826 07:31:00",
        depDateTimeSec: "20260826 07:32:00",
        arrDelay: "-9999",
        depDelay: "-9999",
        arrValid: "1",
        depValid: "1",
      },
    },
  ],
};

test("a basic DM row carries the private locator for its one-trip request", () => {
  const board = parseStopEventBoardResponse(
    {
      parameters: [{ name: "serverTime", value: "2026-08-26T07:29:45" }],
      servingLines: {
        lines: [{ mode: { number: "S4", diva: { stateless: "kvv:22304:E:H:s26" } } }],
      },
      departureList: [
        {
          stopID: "7001001",
          nameWO: "Durlacher Tor/KIT-Campus Süd (U)",
          countdown: "1",
          platform: "1(U)",
          dateTime: { year: "2026", month: "8", day: "26", hour: "7", minute: "30" },
          servingLine: {
            key: "888",
            stateless: "kvv:22304:E:H:s26",
            symbol: "S4",
            trainNum: "85653",
            motType: "1",
            direction: "Karlsruhe Albtalbahnhof",
          },
          attrs: [{ name: "RealtimeTripId", value: "de:kvv:00S04_:.trip" }],
        },
      ],
    },
    "7001001",
  );

  assert.deepEqual(board.stopEvents[0].journeyLocator, locator);
  assert.deepEqual(board.servingLines, [{ lineId: "S4", lineRef: locator.lineRef }]);
  assert.equal(board.stopEvents[0].lineRef, locator.lineRef);
  assert.equal(board.stopEvents[0].publishedJourneyNumber, "85653");
  assert.equal(board.stopEvents[0].calls, undefined);
});

test("the stop a board was read at is a call of the trip, timed by the row itself", () => {
  // `prevStopSeq` ends one call before the board's stop and `onwardStopSeq` starts one after;
  // without completion the trip has a gap at its freshest call.
  const board = parseStopEventBoardResponse(
    {
      parameters: [{ name: "serverTime", value: "2026-08-26T07:29:45" }],
      departureList: [
        {
          stopID: "7001002",
          nameWO: "Kronenplatz (U)",
          countdown: "1",
          platform: "1(U)",
          dateTime: { year: "2026", month: "8", day: "26", hour: "7", minute: "32" },
          servingLine: {
            key: "888",
            stateless: "kvv:22304:E:H:s26",
            symbol: "S4",
            motType: "1",
            direction: "Karlsruhe Albtalbahnhof",
            delay: "3",
          },
          prevStopSeq: [
            {
              nameWO: "Durlacher Tor/KIT-Campus Süd (U)",
              ref: { id: "7001001", depDateTimeSec: "20260826 07:30:30", depDelay: "3" },
            },
          ],
          onwardStopSeq: [
            {
              nameWO: "Marktplatz (Kaiserstraße U)",
              ref: {
                id: "7001003",
                arrDateTimeSec: "20260826 07:34:00",
                depDateTimeSec: "20260826 07:34:30",
                arrDelay: "3",
                depDelay: "3",
              },
            },
          ],
        },
      ],
    },
    "7001002",
  );

  const [, current] = board.stopEvents[0].calls ?? [];
  assert.equal(current.isThisCall, true);
  assert.equal(current.providerId, "7001002");
  // The row's own facts are the only account of this call.
  assert.equal(current.timetabledDepartureTime, board.stopEvents[0].timetabledDepartureTime);
  assert.equal(current.delayMinutes, 3);
});

test("both levels of one place answer as that place, whichever platform the row leaves from", async () => {
  const client = {
    fetchStopEventBoard: async (): Promise<KvvStopEventBoard> => ({
      stopPointId: "7001012",
      stopName: "Ettlinger Tor/Staatstheater (U)",
      serverTime: "2026-08-26T12:00:00.000Z",
      servingLines: [],
      stopEvents: [
        {
          stopPointId: "7000071",
          stopPointName: "Ettlinger Tor/Staatstheater",
          lineId: "5",
          ptMode: "tram",
          destinationText: "Europaplatz",
          minutesUntilDeparture: 2,
          bay: "1",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T12:02:00.000Z",
        },
      ],
    }),
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const board = await source.getStopEventBoard("ettlinger-tor");

  // The row leaves from the street point (`7000071`) on a board asked for the tunnel id; both are
  // the addressed stop.
  assert.equal(board.stopId, "ettlinger-tor");
  assert.equal(board.stopEvents[0].boardingLocalStopId, "ettlinger-tor");
});

test("the single-trip response validates its locator and preserves call-level cancellation", () => {
  const journey = parseTripInfoResponse(journeyPayload, locator);

  // Resolved to an instant, not left as local wall time.
  assert.equal(journey.serverTime, "2026-08-26T05:30:45.000Z");
  assert.equal(journey.status, "cancelled");
  assert.equal(journey.calls.length, 2);
  assert.equal(journey.calls[0].isThisCall, true);
  assert.equal(journey.calls[0].delayMinutes, undefined);
  assert.deepEqual(
    { latitude: journey.calls[1].latitude, longitude: journey.calls[1].longitude },
    { latitude: 49.009362, longitude: 8.409794 },
  );
});

test("a terminus uses its valid arrival delay instead of its invalid departure placeholder", () => {
  const payload = {
    ...journeyPayload,
    stopSeq: [
      journeyPayload.stopSeq[0],
      {
        nameWO: "Karlsruhe Albtalbahnhof",
        place: "Karlsruhe",
        ref: {
          id: "7001201",
          arrDateTimeSec: "20260826 07:44:00",
          arrDelay: "6",
          arrValid: "1",
          depDateTimeSec: "20260826 07:44:00",
          depDelay: "0",
          depValid: "0",
        },
      },
    ],
  };

  const terminus = parseTripInfoResponse(payload, locator).calls[1];

  assert.equal(terminus.delayMinutes, 6);
  assert.equal(terminus.timetabledArrivalTime, "2026-08-26T05:44:00.000Z");
  assert.equal(terminus.timetabledDepartureTime, undefined);
});

test("a scheduled-only S4 keeps its call times and can be placed without claiming predictions", () => {
  const payload = {
    ...journeyPayload,
    stopSeq: journeyPayload.stopSeq.map((entry) => ({
      ...entry,
      realtimeStatus: undefined,
      ref: { ...entry.ref, arrValid: "0", depValid: "0", arrDelay: "0", depDelay: "0" },
    })),
  };
  const journey = parseTripInfoResponse(payload, locator);
  assert.equal(journey.calls[0].timetabledDepartureTime, "2026-08-26T05:30:00.000Z");
  assert.equal(journey.calls[1].timetabledArrivalTime, "2026-08-26T05:31:00.000Z");
  assert.equal(journey.calls[1].timetabledDepartureTime, "2026-08-26T05:32:00.000Z");
  assert.ok(journey.calls.every((call) => call.delayMinutes === undefined));
  const stopEvent = createStopEvent({
    lineId: "S4",
    status: "scheduled",
    calls: journey.calls.map((call) => ({ ...call, localStopId: call.providerId })),
  });
  const placement = getDatedJourneyPlacement(
    createDatedJourneyMotions(),
    stopEvent,
    Date.parse("2026-08-26T05:30:45Z"),
  );
  assert.equal(placement?.fromStopId, "7001001");
  assert.equal(placement?.toStopId, "7001002");
});

test("the row's own call is marked once, where the trip calls at that stop three times", () => {
  // Waidweg's loop as line 3 reports it: into Gleis 1 at 23:42, the public Gleis 3 at 23:44 (the
  // row's own call), parked on Gleis 2 at 23:45 where the run ends; all stop point `7000306`. Only
  // the row's call may be marked.
  const waidwegLocator: KvvJourneyLocator = {
    journeyCode: "1125",
    lineRef: "kvv:21003:E:H:s26",
    stopPointId: "7000306",
    date: "20260905",
    time: "2344",
  };
  const waidwegPayload = {
    parameters: [{ name: "serverTime", value: "2026-09-05T23:44:45" }],
    vehicleCallAtStop: {
      stopID: "7000306",
      tC: "1125",
      time: "23:44",
      line: "kvv:21003:E:H:s26",
    },
    stopSeq: [
      {
        nameWO: "Hammweg",
        place: "Daxlanden",
        platformName: "Gleis 1",
        ref: {
          id: "7000305",
          platform: "1",
          arrDateTimeSec: "20260905 23:41:18",
          depDateTimeSec: "20260905 23:41:30",
          arrValid: "1",
          depValid: "1",
        },
      },
      {
        nameWO: "Waidweg",
        place: "Daxlanden",
        platformName: "Gleis 1",
        ref: {
          id: "7000306",
          platform: "1",
          arrDateTimeSec: "20260905 23:42:06",
          depDateTimeSec: "20260905 23:42:30",
          arrValid: "1",
          depValid: "1",
        },
      },
      {
        nameWO: "Waidweg",
        place: "Daxlanden",
        platformName: "",
        ref: {
          id: "7000306",
          platform: "3",
          arrDateTimeSec: "20260905 23:42:48",
          depDateTimeSec: "20260905 23:44:48",
          arrValid: "1",
          depValid: "1",
        },
      },
      {
        nameWO: "Waidweg",
        place: "Daxlanden",
        platformName: "Gleis 2",
        ref: {
          id: "7000306",
          platform: "2",
          arrDateTimeSec: "20260905 23:45:42",
          arrValid: "1",
          depValid: "0",
        },
      },
    ],
  };

  const journey = parseTripInfoResponse(waidwegPayload, waidwegLocator);
  const marked = journey.calls.filter(({ isThisCall }) => isThisCall);

  assert.equal(marked.length, 1);
  assert.equal(marked[0].bay, "3");
  assert.equal(marked[0].timetabledDepartureTime, "2026-09-05T21:44:48.000Z");
  // The operator never words platform `3`; the label keeps the number.
  assert.equal(marked[0].bayText, "3");
  // The run-end call stays unmarked, so the feed's turnaround pair can still fold.
  assert.equal(journey.calls[3].isThisCall, undefined);
});

test("a call the minute cannot name still marks the stop's first call", () => {
  const waidwegLocator: KvvJourneyLocator = {
    journeyCode: "1125",
    lineRef: "kvv:21003:E:H:s26",
    stopPointId: "7000306",
    date: "20260905",
    time: "2359",
  };
  const waidwegPayload = {
    parameters: [{ name: "serverTime", value: "2026-09-05T23:44:45" }],
    vehicleCallAtStop: {
      stopID: "7000306",
      tC: "1125",
      time: "23:44",
      line: "kvv:21003:E:H:s26",
    },
    stopSeq: [
      {
        nameWO: "Waidweg",
        ref: { id: "7000306", depDateTimeSec: "20260905 23:42:30", depValid: "1" },
      },
      {
        nameWO: "Waidweg",
        ref: { id: "7000306", depDateTimeSec: "20260905 23:44:48", depValid: "1" },
      },
    ],
  };

  const journey = parseTripInfoResponse(waidwegPayload, waidwegLocator);

  assert.equal(journey.calls.filter(({ isThisCall }) => isThisCall).length, 1);
  assert.equal(journey.calls[0].isThisCall, true);
});

test("HTTP 200 with an empty or mismatched trip is a provider failure", () => {
  assert.throws(
    () => parseTripInfoResponse({ vehicleCallAtStop: {}, stopSeq: [] }, locator),
    (error) => error instanceof KvvEfaError && error.message.includes("nicht gefunden"),
  );
});

test("the client calls KVV's XML single-trip endpoint with the complete tuple", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    tripInfoEndpoint: "https://example.test/XML_TRIPSTOPTIMES_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify(journeyPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchTripInfo(locator);

  assert.equal(requestedUrl?.pathname, "/XML_TRIPSTOPTIMES_REQUEST");
  assert.deepEqual(Object.fromEntries(requestedUrl?.searchParams ?? []), {
    outputFormat: "json",
    tripCode: "888",
    line: "kvv:22304:E:H:s26",
    stopID: "7001001",
    date: "20260826",
    time: "0730",
    useRealtime: "1",
    tStOTType: "ALL",
    coordOutputFormat: "WGS84[DD.ddddd]",
  });
});

test("the departure monitor repeats exact line filters and disables proximity expansion", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    stopEventEndpoint: "https://example.test/XSLT_DM_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(
        JSON.stringify({ parameters: journeyPayload.parameters, departureList: [] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });

  await client.fetchStopEventBoard("7001001", {
    lineIds: ["kvv:line:A", "kvv:line:B"],
    limit: 4,
  });

  assert.deepEqual(requestedUrl?.searchParams.getAll("line"), ["kvv:line:A", "kvv:line:B"]);
  assert.equal(requestedUrl?.searchParams.get("limit"), "4");
  assert.equal(requestedUrl?.searchParams.get("useProxFootSearch"), "0");
});

test("TransitSource merges one trip into the latest stop row and caches its sequence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const rawStopEvent: KvvStopEvent = {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: "de:kvv:00S04_:.trip",
    lineId: "S4",
    ptMode: "lightRail",
    destinationText: "Karlsruhe Albtalbahnhof",
    minutesUntilDeparture: 1,
    bay: "1(U)",
    status: "realtime",
    timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
    journeyLocator: locator,
  };
  const rawJourney = parseTripInfoResponse(journeyPayload, locator);
  const requests: KvvJourneyLocator[] = [];
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      stopEvents: [rawStopEvent],
    }),
    fetchTripInfo: async (requested: KvvJourneyLocator): Promise<KvvTripInfo> => {
      requests.push(requested);
      return rawJourney;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getStopEventBoard("durlacher-tor");
  const rowId = board.stopEvents[0].id;
  const rowReadAt = Date.now();

  t.mock.timers.tick(2 * 60_000);
  const first = await source.getDatedJourney(rowId);
  const second = await source.getDatedJourney(rowId);

  assert.deepEqual(requests, [locator]);
  assert.equal(first?.bay, "1(U)");
  assert.equal(first?.destinationText, "Karlsruhe Albtalbahnhof");
  assert.equal(first?.status, "cancelled");
  assert.equal(first?.calls?.length, 2);
  assert.equal(first?.calls?.[1].localStopId, "kronenplatz");
  assert.deepEqual(first?.readAt, { rowReadAt, sequenceReadAt: Date.now() });
  // The kept reading answers the second call, dated when it was taken.
  assert.deepEqual(second, first);
  // A board served from cache resolves through the store too, so it never publishes a stale row.
  const cachedBoard = await source.getStopEventBoard("durlacher-tor", { maxAgeMs: 5 * 60_000 });
  assert.equal(cachedBoard.stopEvents[0], source.findDatedJourney(rowId));
  assert.equal(cachedBoard.stopEvents[0], first);
  // A held board catches up without a refetch.
  assert.notEqual(board.stopEvents[0], first);
  assert.equal(source.resolveBoard(board).stopEvents[0], first);
  assert.equal(source.resolveBoard(cachedBoard), cachedBoard);
});

test("a detailed board keeps its own calls as observation, never as the run's reading", async (t) => {
  // Before the run's last call, or the network would have dropped the trip.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const source = createBoardSource({
    "7001001": [createRememberedStopEvent(0, "2026-08-26T05:35:00.000Z")],
  });

  const board = await source.getStopEventBoard("durlacher-tor", { includeCalls: true });
  const [row] = board.stopEvents;

  assert.equal(row.calls?.length, 2);
  assert.equal(source.findDatedJourney(row.id)?.calls, undefined);
  assert.equal(await source.getDatedJourney(row.id), undefined);
  assert.deepEqual(
    source.getObservedNetwork().lines.map(({ id }) => id),
    ["S4"],
  );
});

test("a trip nobody selected is re-read on its own terms, not on the board's", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const rawJourney = parseTripInfoResponse(journeyPayload, locator);
  let datedJourneyRequests = 0;
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      stopEvents: [
        {
          stopPointId: "7001001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          ptMode: "lightRail",
          destinationText: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          bay: "1(U)",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          journeyLocator: locator,
        },
      ],
    }),
    fetchTripInfo: async (): Promise<KvvTripInfo> => {
      datedJourneyRequests += 1;
      return rawJourney;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const rowId = (await source.getStopEventBoard("durlacher-tor")).stopEvents[0].id;

  // An unchosen run sits out a board refresh; the chosen one does not.
  await source.getDatedJourney(rowId, 90_000);
  t.mock.timers.tick(30_000);
  await source.getDatedJourney(rowId, 90_000);
  assert.equal(datedJourneyRequests, 1);

  t.mock.timers.tick(70_000);
  await source.getDatedJourney(rowId, 90_000);
  assert.equal(datedJourneyRequests, 2);
});

test("a requested run teaches the network its route as soon as it lands", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      stopEvents: [
        {
          stopPointId: "7001001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          ptMode: "lightRail",
          destinationText: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          bay: "1(U)",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          journeyLocator: locator,
        },
      ],
    }),
    // The fixture trip is cancelled, and a cancelled run teaches nothing.
    fetchTripInfo: async (): Promise<KvvTripInfo> => ({
      ...parseTripInfoResponse(journeyPayload, locator),
      status: undefined,
    }),
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const rowId = (await source.getStopEventBoard("durlacher-tor")).stopEvents[0].id;
  // A plain row names the run but says nothing of its route.
  assert.equal(source.getObservedNetwork().journeyCount, 0);

  await source.getDatedJourney(rowId);

  assert.equal(source.getObservedNetwork().journeyCount, 1);
  assert.deepEqual(
    source.getObservedNetwork().lines.map(({ id }) => id),
    ["S4"],
  );
});

/** A row with its board's calls and no locator: a probe (`findDatedJourney`) for whether it is remembered. */
function createRememberedStopEvent(
  index: number,
  finalCallTime: string,
): KvvStopEvent & { calls: KvvCall[] } {
  return {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: `de:kvv:trip:${index}`,
    lineId: "S4",
    ptMode: "lightRail",
    destinationText: "Karlsruhe Albtalbahnhof",
    minutesUntilDeparture: 1,
    bay: "",
    status: "realtime",
    timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
    calls: [
      { stopName: "Durlacher Tor/KIT-Campus Süd (U)", isThisCall: true },
      { stopName: `Halt ${index}`, timetabledDepartureTime: finalCallTime },
    ],
  };
}

function createBoardSource(boardsByProviderStopId: Record<string, KvvStopEvent[]>) {
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      stopEvents: boardsByProviderStopId[providerStopId] ?? [],
    }),
    fetchTripInfo: async (): Promise<KvvTripInfo> => {
      throw new Error("no trip should be requested");
    },
  } as unknown as KvvEfaClient;
  return new KvvTransitSource(client);
}

/**
 * Readings answered from memory keep their read time, so a retained ride never claims an old
 * reading is fresh.
 */
test("a reading answered from memory is dated when it was taken, not when it was asked for", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const rawJourney = parseTripInfoResponse(journeyPayload, locator);
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      stopEvents: [
        {
          stopPointId: "7001001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          ptMode: "lightRail",
          destinationText: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          bay: "",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          journeyLocator: locator,
        },
      ],
    }),
    fetchTripInfo: async (): Promise<KvvTripInfo> => rawJourney,
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const rowId = (await source.getStopEventBoard("durlacher-tor")).stopEvents[0].id;

  const read = await source.getDatedJourney(rowId, 90_000);
  assert.equal(read?.readAt?.sequenceReadAt, Date.now());

  t.mock.timers.tick(30_000);
  assert.equal(
    (await source.getDatedJourney(rowId, 90_000))?.readAt?.sequenceReadAt,
    read?.readAt?.sequenceReadAt,
  );

  t.mock.timers.tick(70_000);
  assert.equal((await source.getDatedJourney(rowId, 90_000))?.readAt?.sequenceReadAt, Date.now());
});

test("board churn spends the cap on finished runs before the vehicles still out", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:30:00.000Z") });
  const stillRunning = "2026-08-26T06:30:00.000Z";
  const alreadyOver = "2026-08-26T05:00:00.000Z";

  // Exactly the cap; the finished run sits between unfinished ones, so neither age nor order picks
  // it.
  const filling = [
    createRememberedStopEvent(0, stillRunning),
    createRememberedStopEvent(1, alreadyOver),
    ...Array.from({ length: DATED_JOURNEY_READING_STORE_CAPACITY - 2 }, (_, index) =>
      createRememberedStopEvent(index + 2, stillRunning),
    ),
  ];
  const source = createBoardSource({
    "7001001": filling,
    "7001002": [createRememberedStopEvent(9_000, stillRunning)],
  });

  const board = await source.getStopEventBoard("durlacher-tor");
  assert.equal(board.stopEvents.length, DATED_JOURNEY_READING_STORE_CAPACITY);
  const [oldestRunningId, finishedId] = board.stopEvents.map((stopEvent) => stopEvent.id);
  assert.notEqual(oldestRunningId, finishedId);
  assert.ok(source.findDatedJourney(finishedId));

  // One over the cap: one run must go.
  await source.getStopEventBoard("kronenplatz");

  assert.equal(source.findDatedJourney(finishedId), undefined);
  assert.ok(source.findDatedJourney(oldestRunningId));
});

test("the cap is a bound, not a preference: all-running churn still evicts the oldest", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:30:00.000Z") });
  const stillRunning = "2026-08-26T06:30:00.000Z";
  const source = createBoardSource({
    "7001001": Array.from({ length: DATED_JOURNEY_READING_STORE_CAPACITY }, (_, index) =>
      createRememberedStopEvent(index, stillRunning),
    ),
    "7001002": [createRememberedStopEvent(9_000, stillRunning)],
  });

  const board = await source.getStopEventBoard("durlacher-tor");
  const oldestId = board.stopEvents[0].id;
  assert.ok(source.findDatedJourney(oldestId));

  await source.getStopEventBoard("kronenplatz");

  assert.equal(source.findDatedJourney(oldestId), undefined);
});

/**
 * A two-level place is one stop: the Europaplatz board is asked for the street point, but the S1
 * calls at the tunnel point, which must resolve to `europaplatz` too.
 */
test("a trip calling at a place's other level resolves to that place", async () => {
  const tunnelLocator: KvvJourneyLocator = {
    journeyCode: "412",
    lineRef: "kvv:22001:E:H:s26",
    stopPointId: "7001004",
    date: "20260826",
    time: "0730",
  };
  const rawJourney = parseTripInfoResponse(
    {
      parameters: [{ name: "serverTime", value: "2026-08-26T07:30:45" }],
      vehicleCallAtStop: {
        stopID: "7001004",
        tC: "412",
        time: "07:30",
        line: "kvv:22001:E:H:s26",
      },
      stopSeq: [
        {
          nameWO: "Europaplatz (U)",
          place: "Karlsruhe",
          platformName: "Gleis 2(U)",
          ref: {
            id: "7001004",
            coords: "8.394235,49.010045",
            depDateTimeSec: "20260826 07:30:00",
            depValid: "1",
          },
        },
        {
          nameWO: "Mühlburger Tor",
          place: "Karlsruhe",
          ref: {
            id: "7000039",
            coords: "8.386800,49.011600",
            arrDateTimeSec: "20260826 07:32:00",
            depDateTimeSec: "20260826 07:32:00",
            arrValid: "1",
            depValid: "1",
          },
        },
      ],
    },
    tunnelLocator,
  );
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Europaplatz",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      stopEvents: [
        {
          stopPointId: "7001004",
          stopPointName: "Europaplatz (U)",
          journeyRef: "de:kvv:00S01_:.trip",
          lineId: "S1",
          ptMode: "lightRail",
          destinationText: "Hochstetten",
          minutesUntilDeparture: 1,
          bay: "2(U)",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          journeyLocator: tunnelLocator,
        },
      ],
    }),
    fetchTripInfo: async (): Promise<KvvTripInfo> => rawJourney,
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const board = await source.getStopEventBoard("europaplatz");
  const journey = await source.getDatedJourney(board.stopEvents[0].id);

  assert.equal(journey?.calls?.[0].localStopId, "europaplatz");
  assert.deepEqual(
    getCallsAfterStop(journey!, "europaplatz").map((call) => call.localStopId),
    ["muehlburger-tor"],
  );
});

test("a single-trip reading dates the run exactly as the boards do, so it is one vehicle", async () => {
  // One run read twice: a board times the first call to the half minute and its row to the minute;
  // the trip endpoint times it to the second.
  const boardPayload = {
    parameters: [{ name: "serverTime", value: "2026-08-26T07:29:45" }],
    departureList: [
      {
        stopID: "7001002",
        nameWO: "Kronenplatz (U)",
        countdown: "2",
        platform: "1(U)",
        dateTime: { year: "2026", month: "8", day: "26", hour: "7", minute: "32" },
        servingLine: {
          key: "888",
          stateless: "kvv:22304:E:H:s26",
          symbol: "S4",
          motType: "1",
          direction: "Karlsruhe Albtalbahnhof",
        },
        attrs: [{ name: "RealtimeTripId", value: "de:kvv:00S04_:.trip" }],
        prevStopSeq: [
          {
            nameWO: "Durlacher Tor/KIT-Campus Süd (U)",
            ref: { id: "7001001", depDateTimeSec: "20260826 07:30:30" },
          },
        ],
        onwardStopSeq: [
          {
            nameWO: "Marktplatz (Kaiserstraße U)",
            ref: { id: "7001003", arrDateTimeSec: "20260826 07:34:00" },
          },
        ],
      },
    ],
  };
  const parsedBoard = parseStopEventBoardResponse(boardPayload, "7001002");
  const rawJourney = parseTripInfoResponse(journeyPayload, locator);
  const client = {
    fetchStopEventBoard: async (): Promise<KvvStopEventBoard> => parsedBoard,
    fetchTripInfo: async (): Promise<KvvTripInfo> => rawJourney,
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getStopEventBoard("kronenplatz");
  const row = board.stopEvents[0];

  const merged = await source.getDatedJourney(row.id);

  // One dated id, or the diagram draws two vehicles.
  assert.equal(merged?.datedJourneyId, row.datedJourneyId);
  assert.equal(row.datedJourneyId, "de:kvv:00S04_:.trip@2026-08-26T05:30");
});

test("a line's stops are read as rows, and each trip's calls are fetched once for all of them", async () => {
  // A run listed at every stop it will call at is read once, and every board's row completed from
  // it.
  const datedJourneyRequests: KvvJourneyLocator[] = [];
  const boardRequests: { stopId: string; lineIds?: readonly string[] }[] = [];
  const runningJourney = (stopPointId: string, minute: number): KvvStopEvent => ({
    stopPointId,
    stopPointName: stopPointId,
    journeyRef: "de:kvv:00S04_:.trip",
    lineId: "S4",
    lineRef: "kvv:22304:E:H:s26",
    ptMode: "tram",
    destinationText: "Hochstetten",
    minutesUntilDeparture: minute,
    bay: "",
    status: "realtime",
    timetabledDepartureTime: "2026-08-26T07:30:00.000Z",
    // Any row's locator reads the trip.
    journeyLocator: locator,
  });
  const client = {
    fetchStopEventBoard: async (
      stopPointId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvStopEventBoard> => {
      boardRequests.push({ stopId: stopPointId, lineIds: options.lineIds });
      return {
        stopPointId,
        stopName: stopPointId,
        serverTime: "2026-08-26T07:29:45",
        servingLines: [],
        // One run, seen from three stops.
        stopEvents: [runningJourney(stopPointId, 2)],
      };
    },
    fetchTripInfo: async (requested: KvvJourneyLocator): Promise<KvvTripInfo> => {
      datedJourneyRequests.push(requested);
      return parseTripInfoResponse(journeyPayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const boards = await source.getLineStopEventBoards(
    ["europaplatz", "muehlburger-tor", "entenfang"],
    { lineRefs: ["kvv:22304:E:H:s26"] },
  );

  // Three boards, one trip read.
  assert.equal(boardRequests.length, 3);
  assert.equal(datedJourneyRequests.length, 1);
  // Filtered boards skip the mode macros, which would return every row's sequence.
  assert.deepEqual(
    boardRequests.map((request) => request.lineIds?.length),
    [1, 1, 1],
  );
  // Every row carries the one reading's calls.
  assert.deepEqual(
    boards.map((board) => board.stopEvents[0].calls?.length),
    [2, 2, 2],
  );
  assert.deepEqual(
    boards.map((board) => board.stopEvents[0].datedJourneyId),
    Array(3).fill(boards[0].stopEvents[0].datedJourneyId),
  );
  // The same object a view reading the run by id gets; views memoize on identity.
  for (const board of boards) {
    const row = board.stopEvents[0];
    assert.equal(source.findDatedJourney(row.id), row);
  }
});

test("a line's runs are re-read at their own tolerance, apart from the boards that name them", async (t) => {
  // Runs revise about every 35 s, so a line asks its runs for a fresher tolerance than its boards.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T07:29:45.000Z") });
  const rawJourney = parseTripInfoResponse(journeyPayload, locator);
  let datedJourneyRequests = 0;
  let boardRequests = 0;
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<KvvStopEventBoard> => {
      boardRequests += 1;
      return {
        stopPointId,
        stopName: stopPointId,
        serverTime: "2026-08-26T07:29:45",
        servingLines: [],
        stopEvents: [
          {
            stopPointId,
            stopPointName: stopPointId,
            journeyRef: "de:kvv:00S04_:.trip",
            lineId: "S4",
            lineRef: "kvv:22304:E:H:s26",
            ptMode: "tram",
            destinationText: "Hochstetten",
            minutesUntilDeparture: 2,
            bay: "",
            status: "realtime",
            timetabledDepartureTime: "2026-08-26T07:30:00.000Z",
            journeyLocator: locator,
          },
        ],
      };
    },
    fetchTripInfo: async (): Promise<KvvTripInfo> => {
      datedJourneyRequests += 1;
      return rawJourney;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const lineRefs = ["kvv:22304:E:H:s26"];

  await source.getLineStopEventBoards(["europaplatz"], {
    lineRefs,
    maxAgeMs: 90_000,
    datedJourneyMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(datedJourneyRequests, 1);

  // A minute on, the boards are within tolerance; the runs are not.
  t.mock.timers.tick(60_000);
  await source.getLineStopEventBoards(["europaplatz"], {
    lineRefs,
    maxAgeMs: 90_000,
    datedJourneyMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(datedJourneyRequests, 2);

  // Unnamed, the runs' tolerance follows the boards'.
  t.mock.timers.tick(60_000);
  await source.getLineStopEventBoards(["europaplatz"], { lineRefs, maxAgeMs: 90_000 });
  assert.equal(boardRequests, 2);
  assert.equal(datedJourneyRequests, 2);
});

test("a trip whose sequence cannot be read still keeps the row it was found on", async () => {
  // A failed read keeps the row; the next round asks again.
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<KvvStopEventBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      stopEvents: [
        {
          stopPointId,
          stopPointName: stopPointId,
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          lineRef: "kvv:22304:E:H:s26",
          ptMode: "tram",
          destinationText: "Hochstetten",
          minutesUntilDeparture: 2,
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T07:30:00.000Z",
          journeyLocator: locator,
        } as KvvStopEvent,
      ],
    }),
    fetchTripInfo: async (): Promise<KvvTripInfo> => {
      throw new Error("Fahrt nicht lesbar");
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const boards = await source.getLineStopEventBoards(["europaplatz"], {
    lineRefs: ["kvv:22304:E:H:s26"],
  });

  assert.equal(boards[0].stopEvents.length, 1);
  assert.equal(boards[0].stopEvents[0].calls, undefined);
});

test("a failed run refresh retains its prediction and a scheduled recovery clears the failure", async (t) => {
  const start = Date.parse("2026-08-26T05:29:45Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const client = new KvvEfaClient();
  client.fetchStopEventBoard = async (stopPointId) => ({
    stopPointId,
    stopName: "Durlacher Tor",
    serverTime: "2026-08-26T07:29:45",
    servingLines: [],
    stopEvents: [
      {
        stopPointId,
        stopPointName: "Durlacher Tor",
        journeyRef: "refresh-recovery",
        lineId: "S4",
        ptMode: "lightRail",
        destinationText: "Kronenplatz",
        minutesUntilDeparture: 1,
        bay: "1",
        timetabledDepartureTime: "2026-08-26T05:30:00Z",
        status: "realtime",
        journeyLocator: locator,
      },
    ],
  });
  const payload = (valid: string) => ({
    ...journeyPayload,
    stopSeq: journeyPayload.stopSeq.map((entry) => ({
      ...entry,
      realtimeStatus: "",
      ref: { ...entry.ref, arrValid: valid, depValid: valid, arrDelay: "2", depDelay: "2" },
    })),
  });
  client.fetchTripInfo = async () => parseTripInfoResponse(payload("1"), locator);
  const source = new KvvTransitSource(client);
  const board = await source.getStopEventBoard("durlacher-tor");
  const id = board.stopEvents[0].id;
  const estimated = await source.getDatedJourney(id, 0);
  assert.equal(estimated?.calls?.[0].delayMinutes, 2);
  const readAt = estimated?.readAt?.sequenceReadAt;
  t.mock.timers.tick(30_000);
  client.fetchTripInfo = async () => {
    throw new Error("offline");
  };
  assert.equal(await source.getDatedJourney(id, 0), undefined);
  const held = source.findDatedJourney(id);
  assert.equal(held?.calls, estimated?.calls);
  assert.equal(held?.readAt?.sequenceReadAt, readAt);
  assert.equal(held?.readAt?.sequenceRefreshFailedAt, start + 30_000);
  t.mock.timers.tick(30_000);
  client.fetchTripInfo = async () => parseTripInfoResponse(payload("0"), locator);
  const recovered = await source.getDatedJourney(id, 0);
  assert.equal(recovered?.readAt?.sequenceRefreshFailedAt, undefined);
  assert.equal(recovered?.readAt?.sequenceReadAt, start + 60_000);
  assert.ok(recovered?.calls?.every((call) => call.delayMinutes === undefined));
});

test("a line's reading asks for the calls of the runs out on it, not of tomorrow's departures", async () => {
  // A run whose nearest call is hours away has not set out; its sequence is not read.
  const datedJourneyRequests: KvvJourneyLocator[] = [];
  const datedJourney = (journeyRef: string, minutesUntilDeparture: number): KvvStopEvent =>
    ({
      stopPointId: "7001001",
      stopPointName: "stop",
      journeyRef,
      lineId: "S4",
      lineRef: "kvv:22304:E:H:s26",
      ptMode: "tram",
      destinationText: "Hochstetten",
      minutesUntilDeparture,
      status: "realtime",
      timetabledDepartureTime: "2026-08-26T07:30:00.000Z",
      journeyLocator: journeyRef.endsWith(".tomorrow")
        ? { ...locator, journeyCode: "tomorrow" }
        : locator,
    }) as KvvStopEvent;
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<KvvStopEventBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      stopEvents: [
        datedJourney("de:kvv:00S04_:.trip", 4),
        datedJourney("de:kvv:00S04_:.tomorrow", 220),
      ],
    }),
    fetchTripInfo: async (requested: KvvJourneyLocator): Promise<KvvTripInfo> => {
      datedJourneyRequests.push(requested);
      return parseTripInfoResponse(journeyPayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const [board] = await source.getLineStopEventBoards(["europaplatz"], {
    lineRefs: ["kvv:22304:E:H:s26"],
  });

  assert.equal(datedJourneyRequests.length, 1);
  const [underWay, notYetOut] = board.stopEvents;
  assert.ok(underWay.calls?.length);
  // The row stays a readable departure; an address naming it reads its calls itself.
  assert.equal(notYetOut.calls, undefined);
  assert.equal(notYetOut.destinationText, "Hochstetten");
});

test("a run is read once for all its stops, however far along it the rows are", async () => {
  // The nearest row decides: one vehicle, minutes from one stop, an hour from another.
  const datedJourneyRequests: KvvJourneyLocator[] = [];
  const row = (stopPointId: string, minutesUntilDeparture: number): KvvStopEvent =>
    ({
      stopPointId,
      stopPointName: stopPointId,
      journeyRef: "de:kvv:00S04_:.trip",
      lineId: "S4",
      lineRef: "kvv:22304:E:H:s26",
      ptMode: "tram",
      destinationText: "Hochstetten",
      minutesUntilDeparture,
      status: "realtime",
      timetabledDepartureTime: "2026-08-26T07:30:00.000Z",
      journeyLocator: locator,
    }) as KvvStopEvent;
  let read = 0;
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<KvvStopEventBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      // Near at the next stop, an hour off at the far end.
      stopEvents: [row(stopPointId, read++ === 0 ? 3 : 62)],
    }),
    fetchTripInfo: async (requested: KvvJourneyLocator): Promise<KvvTripInfo> => {
      datedJourneyRequests.push(requested);
      return parseTripInfoResponse(journeyPayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const boards = await source.getLineStopEventBoards(["europaplatz", "entenfang"], {
    lineRefs: ["kvv:22304:E:H:s26"],
  });

  assert.equal(datedJourneyRequests.length, 1);
  assert.deepEqual(
    boards.map((board) => Boolean(board.stopEvents[0].calls?.length)),
    [true, true],
  );
});

test("line boards keep reused timetable ids separated by their run records", async () => {
  const requestedCodes: string[] = [];
  const datedJourney = (journeyCode: string, timetabledDepartureTime: string): KvvStopEvent => ({
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: "reused-timetable-trip",
    lineId: "S4",
    lineRef: locator.lineRef,
    ptMode: "tram",
    destinationText: `Ziel ${journeyCode}`,
    minutesUntilDeparture: 2,
    bay: "1",
    status: "realtime",
    timetabledDepartureTime,
    journeyLocator: {
      ...locator,
      journeyCode,
      time: timetabledDepartureTime.slice(11, 16).replace(":", ""),
    },
  });
  const client = {
    fetchStopEventBoard: async (): Promise<KvvStopEventBoard> => ({
      stopPointId: "7001001",
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      stopEvents: [
        datedJourney("first", "2026-08-26T07:30:00.000Z"),
        datedJourney("second", "2026-08-26T07:40:00.000Z"),
      ],
    }),
    fetchTripInfo: async (requested: KvvJourneyLocator): Promise<KvvTripInfo> => {
      requestedCodes.push(requested.journeyCode);
      const minute = requested.journeyCode === "first" ? "30" : "40";
      return {
        serverTime: "2026-08-26T07:29:45",
        calls: [
          {
            stopName: "Durlacher Tor/KIT-Campus Süd (U)",
            providerId: "7001001",
            timetabledDepartureTime: `2026-08-26T07:${minute}:00.000Z`,
            delayMinutes: requested.journeyCode === "first" ? 1 : 2,
          },
        ],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const [board] = await source.getLineStopEventBoards(["durlacher-tor"], {
    lineRefs: [locator.lineRef],
  });

  assert.deepEqual(requestedCodes.sort(), ["first", "second"]);
  assert.deepEqual(
    board.stopEvents.map((stopEvent) => stopEvent.calls?.[0]?.delayMinutes),
    [1, 2],
  );
});

/**
 * The four run lifetimes nest. A cache outliving the store serves rows that are no longer runs; a
 * mark outliving the store's grace is drawn from a record `findDatedJourney` cannot answer.
 */
test("a run's four lifetimes nest, innermost first", () => {
  assert.ok(DEFAULT_BOARD_MAX_AGE_MS < DATED_JOURNEY_MARK_RETENTION_GRACE_MS);
  assert.ok(DATED_JOURNEY_MARK_RETENTION_GRACE_MS < DATED_JOURNEY_ENDED_GRACE_MS);
  assert.ok(DATED_JOURNEY_ENDED_GRACE_MS < DATED_JOURNEY_READING_MAX_AGE_MS);
});

/**
 * A cached board is not re-parsed, so its rows are only remembered when fetched; if the cache
 * outlived the store, every stop would ask for the same run again.
 */
test("a board can never be served from cache after its rows have been forgotten", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  let boardFetches = 0;
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => {
      boardFetches += 1;
      return {
        stopPointId: providerStopId,
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        serverTime: "2026-08-26T05:29:45.000Z",
        servingLines: [],
        stopEvents: [createRememberedStopEvent(0, "2026-08-26T05:35:00.000Z")],
      };
    },
    fetchTripInfo: async (): Promise<KvvTripInfo> => {
      throw new Error("no trip should be requested");
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const [row] = (await source.getStopEventBoard("durlacher-tor")).stopEvents;
  assert.equal(boardFetches, 1);
  assert.ok(source.findDatedJourney(row.id));

  // Past the run's end plus grace: the next write sweeps it.
  t.mock.timers.tick(
    Date.parse("2026-08-26T05:35:00.000Z") - Date.now() + DATED_JOURNEY_ENDED_GRACE_MS + 1,
  );

  // The board is refetched, so its rows are remembered again.
  const [reread] = (await source.getStopEventBoard("durlacher-tor")).stopEvents;
  assert.equal(boardFetches, 2);
  assert.equal(reread.id, row.id);
  assert.ok(source.findDatedJourney(row.id));
});

test("a failed refresh answers with the last live board until it is too old to act on", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  let isFeedDown = false;
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => {
      if (isFeedDown) throw new Error("offline");
      return {
        stopPointId: providerStopId,
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        serverTime: "2026-08-26T05:29:45.000Z",
        servingLines: [],
        stopEvents: [createRememberedStopEvent(0, "2026-08-26T05:35:00.000Z")],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const live = await source.getStopEventBoard("durlacher-tor");

  isFeedDown = true;
  t.mock.timers.tick(60_000);
  const kept = await source.getStopEventBoard("durlacher-tor");
  assert.equal(kept.dataStatus, "live");
  assert.equal(kept.receivedAt, live.receivedAt, "the kept board states its real age");
  assert.equal(kept.dataStatus === "live" && kept.refreshFailedAt, Date.now());

  t.mock.timers.tick(10 * 60_000);
  assert.equal((await source.getStopEventBoard("durlacher-tor")).dataStatus, "unavailable");
});

test("EFA boards and trips reject missing or malformed feed timestamps", () => {
  for (const parameters of [
    undefined,
    [],
    [{ name: "serverTime", value: "broken" }],
    [{ name: "serverTime", value: "2026-02-30T07:30:45" }],
  ]) {
    assert.throws(
      () => parseStopEventBoardResponse({ parameters, departureList: [] }, "7001001"),
      KvvEfaError,
    );
    assert.throws(
      () => parseTripInfoResponse({ ...journeyPayload, parameters }, locator),
      KvvEfaError,
    );
  }
});
