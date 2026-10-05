import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import {
  KvvEfaError,
  parseDepartureBoardResponse,
  parseTripResponse,
  type KvvDeparture,
  type KvvDepartureBoard,
  type KvvTrip,
  type KvvTripCall,
  type KvvTripLocator,
} from "../src/data/kvv-efa-parsers.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
import {
  RUN_ENDED_GRACE_MS,
  RUN_READING_MAX_AGE_MS,
  RUN_READING_STORE_CAPACITY,
} from "../src/data/run-reading-store.ts";
import { DEFAULT_BOARD_MAX_AGE_MS } from "../src/data/transit-source.ts";
import { RUN_MARK_RETENTION_GRACE_MS } from "../src/lib/line-run-departures.ts";
import { getCallsAfterStop } from "../src/lib/trip-calls.ts";
import { createRunMotions, getRunPlacement } from "../src/lib/vehicle-positioning.ts";
import { createDeparture } from "./support/fixtures.ts";

const locator: KvvTripLocator = {
  tripCode: "888",
  line: "kvv:22304:E:H:s26",
  stopPointId: "7001001",
  date: "20260826",
  time: "0730",
};

const tripPayload = {
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
  const board = parseDepartureBoardResponse(
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

  assert.deepEqual(board.departures[0].tripLocator, locator);
  assert.deepEqual(board.servingLines, [{ lineId: "S4", directionId: locator.line }]);
  assert.equal(board.departures[0].routeDirectionId, locator.line);
  assert.equal(board.departures[0].trainNumber, "85653");
  assert.equal(board.departures[0].tripCalls, undefined);
});

test("the stop a board was read at is a call of the trip, timed by the row itself", () => {
  // `prevStopSeq` ends one call before the board's stop and `onwardStopSeq` starts one after;
  // without completion the trip has a gap at its freshest call.
  const board = parseDepartureBoardResponse(
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

  const [, current] = board.departures[0].tripCalls ?? [];
  assert.equal(current.isCurrentStop, true);
  assert.equal(current.providerId, "7001002");
  // The row's own facts are the only account of this call.
  assert.equal(current.scheduledDepartureTime, board.departures[0].scheduledDepartureTime);
  assert.equal(current.delayMinutes, 3);
});

test("both levels of one place answer as that place, whichever platform the row leaves from", async () => {
  const client = {
    fetchDepartureBoard: async (): Promise<KvvDepartureBoard> => ({
      stopPointId: "7001012",
      stopName: "Ettlinger Tor/Staatstheater (U)",
      serverTime: "2026-08-26T12:00:00.000Z",
      servingLines: [],
      departures: [
        {
          stopPointId: "7000071",
          stopPointName: "Ettlinger Tor/Staatstheater",
          lineId: "5",
          transportMode: "tram",
          destination: "Europaplatz",
          minutesUntilDeparture: 2,
          platformCode: "1",
          status: "realtime",
          scheduledDepartureTime: "2026-08-26T12:02:00.000Z",
        },
      ],
    }),
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const board = await source.getDepartureBoard("ettlinger-tor");

  // The row leaves from the street point (`7000071`) on a board asked for the tunnel id; both are
  // the addressed stop.
  assert.equal(board.stopId, "ettlinger-tor");
  assert.equal(board.departures[0].boardingLocalStopId, "ettlinger-tor");
});

test("the single-trip response validates its locator and preserves call-level cancellation", () => {
  const trip = parseTripResponse(tripPayload, locator);

  // Resolved to an instant, not left as local wall time.
  assert.equal(trip.serverTime, "2026-08-26T05:30:45.000Z");
  assert.equal(trip.status, "cancelled");
  assert.equal(trip.tripCalls.length, 2);
  assert.equal(trip.tripCalls[0].isCurrentStop, true);
  assert.equal(trip.tripCalls[0].delayMinutes, undefined);
  assert.deepEqual(
    { latitude: trip.tripCalls[1].latitude, longitude: trip.tripCalls[1].longitude },
    { latitude: 49.009362, longitude: 8.409794 },
  );
});

test("a terminus uses its valid arrival delay instead of its invalid departure placeholder", () => {
  const payload = {
    ...tripPayload,
    stopSeq: [
      tripPayload.stopSeq[0],
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

  const terminus = parseTripResponse(payload, locator).tripCalls[1];

  assert.equal(terminus.delayMinutes, 6);
  assert.equal(terminus.scheduledArrivalTime, "2026-08-26T05:44:00.000Z");
  assert.equal(terminus.scheduledDepartureTime, undefined);
});

test("a scheduled-only S4 keeps its call times and can be placed without claiming predictions", () => {
  const payload = {
    ...tripPayload,
    stopSeq: tripPayload.stopSeq.map((entry) => ({
      ...entry,
      realtimeStatus: undefined,
      ref: { ...entry.ref, arrValid: "0", depValid: "0", arrDelay: "0", depDelay: "0" },
    })),
  };
  const trip = parseTripResponse(payload, locator);
  assert.equal(trip.tripCalls[0].scheduledDepartureTime, "2026-08-26T05:30:00.000Z");
  assert.equal(trip.tripCalls[1].scheduledArrivalTime, "2026-08-26T05:31:00.000Z");
  assert.equal(trip.tripCalls[1].scheduledDepartureTime, "2026-08-26T05:32:00.000Z");
  assert.ok(trip.tripCalls.every((call) => call.delayMinutes === undefined));
  const departure = createDeparture({
    lineId: "S4",
    status: "scheduled",
    tripCalls: trip.tripCalls.map((call) => ({ ...call, localStopId: call.providerId })),
  });
  const placement = getRunPlacement(
    createRunMotions(),
    departure,
    Date.parse("2026-08-26T05:30:45Z"),
  );
  assert.equal(placement?.fromStopId, "7001001");
  assert.equal(placement?.toStopId, "7001002");
});

test("the row's own call is marked once, where the trip calls at that stop three times", () => {
  // Waidweg's loop as line 3 reports it: into Gleis 1 at 23:42, the public Gleis 3 at 23:44 (the
  // row's own call), parked on Gleis 2 at 23:45 where the run ends; all stop point `7000306`. Only
  // the row's call may be marked.
  const waidwegLocator: KvvTripLocator = {
    tripCode: "1125",
    line: "kvv:21003:E:H:s26",
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

  const trip = parseTripResponse(waidwegPayload, waidwegLocator);
  const marked = trip.tripCalls.filter(({ isCurrentStop }) => isCurrentStop);

  assert.equal(marked.length, 1);
  assert.equal(marked[0].platformCode, "3");
  assert.equal(marked[0].scheduledDepartureTime, "2026-09-05T21:44:48.000Z");
  // The operator never words platform `3`; the label keeps the number.
  assert.equal(marked[0].platformLabel, "3");
  // The run-end call stays unmarked, so the feed's turnaround pair can still fold.
  assert.equal(trip.tripCalls[3].isCurrentStop, undefined);
});

test("a call the minute cannot name still marks the stop's first call", () => {
  const waidwegLocator: KvvTripLocator = {
    tripCode: "1125",
    line: "kvv:21003:E:H:s26",
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

  const trip = parseTripResponse(waidwegPayload, waidwegLocator);

  assert.equal(trip.tripCalls.filter(({ isCurrentStop }) => isCurrentStop).length, 1);
  assert.equal(trip.tripCalls[0].isCurrentStop, true);
});

test("HTTP 200 with an empty or mismatched trip is a provider failure", () => {
  assert.throws(
    () => parseTripResponse({ vehicleCallAtStop: {}, stopSeq: [] }, locator),
    (error) => error instanceof KvvEfaError && error.message.includes("nicht gefunden"),
  );
});

test("the client calls KVV's XML single-trip endpoint with the complete tuple", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    tripEndpoint: "https://example.test/XML_TRIPSTOPTIMES_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify(tripPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchTrip(locator);

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
    departureEndpoint: "https://example.test/XSLT_DM_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ departureList: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchDepartureBoard("7001001", {
    lineIds: ["kvv:line:A", "kvv:line:B"],
    limit: 4,
  });

  assert.deepEqual(requestedUrl?.searchParams.getAll("line"), ["kvv:line:A", "kvv:line:B"]);
  assert.equal(requestedUrl?.searchParams.get("limit"), "4");
  assert.equal(requestedUrl?.searchParams.get("useProxFootSearch"), "0");
});

test("TransitSource merges one trip into the latest stop row and caches its sequence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const rawDeparture: KvvDeparture = {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    tripId: "de:kvv:00S04_:.trip",
    lineId: "S4",
    transportMode: "lightRail",
    destination: "Karlsruhe Albtalbahnhof",
    minutesUntilDeparture: 1,
    platformCode: "1(U)",
    status: "realtime",
    scheduledDepartureTime: "2026-08-26T05:30:00.000Z",
    tripLocator: locator,
  };
  const rawTrip = parseTripResponse(tripPayload, locator);
  const requests: KvvTripLocator[] = [];
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      departures: [rawDeparture],
    }),
    fetchTrip: async (requested: KvvTripLocator): Promise<KvvTrip> => {
      requests.push(requested);
      return rawTrip;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("durlacher-tor");
  const rowId = board.departures[0].id;
  const rowReadAt = Date.now();

  t.mock.timers.tick(2 * 60_000);
  const first = await source.getRun(rowId);
  const second = await source.getRun(rowId);

  assert.deepEqual(requests, [locator]);
  assert.equal(first?.platformCode, "1(U)");
  assert.equal(first?.destination, "Karlsruhe Albtalbahnhof");
  assert.equal(first?.status, "cancelled");
  assert.equal(first?.tripCalls?.length, 2);
  assert.equal(first?.tripCalls?.[1].localStopId, "kronenplatz");
  assert.deepEqual(first?.readAt, { rowReadAt, sequenceReadAt: Date.now() });
  // The kept reading answers the second call, dated when it was taken.
  assert.deepEqual(second, first);
  // A board served from cache resolves through the store too, so it never publishes a stale row.
  const cachedBoard = await source.getDepartureBoard("durlacher-tor", { maxAgeMs: 5 * 60_000 });
  assert.equal(cachedBoard.departures[0], source.findRun(rowId));
  assert.equal(cachedBoard.departures[0], first);
  // A held board catches up without a refetch.
  assert.notEqual(board.departures[0], first);
  assert.equal(source.resolveBoard(board).departures[0], first);
  assert.equal(source.resolveBoard(cachedBoard), cachedBoard);
});

test("a detailed ordinary board publishes the canonical run object", async (t) => {
  // Before the run's last call, or the network would have dropped the trip.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const source = createBoardSource({
    "7001001": [createRememberedDeparture(0, "2026-08-26T05:35:00.000Z")],
  });

  const board = await source.getDepartureBoard("durlacher-tor", { includeTripCalls: true });
  const [row] = board.departures;

  assert.equal(row, source.findRun(row.id));
  assert.deepEqual(
    source.getObservedNetwork().lines.map(({ id }) => id),
    ["S4"],
  );
});

test("a trip nobody selected is re-read on its own terms, not on the board's", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const rawTrip = parseTripResponse(tripPayload, locator);
  let runRequests = 0;
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      departures: [
        {
          stopPointId: "7001001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          tripId: "de:kvv:00S04_:.trip",
          lineId: "S4",
          transportMode: "lightRail",
          destination: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          platformCode: "1(U)",
          status: "realtime",
          scheduledDepartureTime: "2026-08-26T05:30:00.000Z",
          tripLocator: locator,
        },
      ],
    }),
    fetchTrip: async (): Promise<KvvTrip> => {
      runRequests += 1;
      return rawTrip;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const rowId = (await source.getDepartureBoard("durlacher-tor")).departures[0].id;

  // An unchosen run sits out a board refresh; the chosen one does not.
  await source.getRun(rowId, 90_000);
  t.mock.timers.tick(30_000);
  await source.getRun(rowId, 90_000);
  assert.equal(runRequests, 1);

  t.mock.timers.tick(70_000);
  await source.getRun(rowId, 90_000);
  assert.equal(runRequests, 2);
});

/**
 * A row carrying its sequence, so `getRun` answers without a request: a probe for whether the row
 * is remembered.
 */
function createRememberedDeparture(
  index: number,
  finalCallTime: string,
): KvvDeparture & { tripCalls: KvvTripCall[] } {
  return {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    tripId: `de:kvv:trip:${index}`,
    lineId: "S4",
    transportMode: "lightRail",
    destination: "Karlsruhe Albtalbahnhof",
    minutesUntilDeparture: 1,
    platformCode: "",
    status: "realtime",
    scheduledDepartureTime: "2026-08-26T05:30:00.000Z",
    tripCalls: [
      { stopName: "Durlacher Tor/KIT-Campus Süd (U)", isCurrentStop: true },
      { stopName: `Halt ${index}`, scheduledDepartureTime: finalCallTime },
    ],
  };
}

function createBoardSource(boardsByProviderStopId: Record<string, KvvDeparture[]>) {
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      departures: boardsByProviderStopId[providerStopId] ?? [],
    }),
    fetchTrip: async (): Promise<KvvTrip> => {
      throw new Error("no trip should be requested");
    },
  } as unknown as KvvEfaClient;
  return new KvvTransitSource(client);
}

/**
 * Readings answered from memory (within tolerance, or a row with calls and no locator) keep their
 * read time, so a retained ride never claims an old reading is fresh.
 */
test("a reading answered from memory is dated when it was taken, not when it was asked for", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const rawTrip = parseTripResponse(tripPayload, locator);
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      departures: [
        {
          stopPointId: "7001001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          tripId: "de:kvv:00S04_:.trip",
          lineId: "S4",
          transportMode: "lightRail",
          destination: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          platformCode: "",
          status: "realtime",
          scheduledDepartureTime: "2026-08-26T05:30:00.000Z",
          tripLocator: locator,
        },
      ],
    }),
    fetchTrip: async (): Promise<KvvTrip> => rawTrip,
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const rowId = (await source.getDepartureBoard("durlacher-tor")).departures[0].id;

  const read = await source.getRun(rowId, 90_000);
  assert.equal(read?.readAt?.sequenceReadAt, Date.now());

  t.mock.timers.tick(30_000);
  assert.equal(
    (await source.getRun(rowId, 90_000))?.readAt?.sequenceReadAt,
    read?.readAt?.sequenceReadAt,
  );

  t.mock.timers.tick(70_000);
  assert.equal((await source.getRun(rowId, 90_000))?.readAt?.sequenceReadAt, Date.now());
});

test("a row that carries its own calls is dated by the board it arrived on", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const source = createBoardSource({
    "7001001": [createRememberedDeparture(0, "2026-08-26T06:30:00.000Z")],
  });
  const boardReadAt = Date.now();
  const rowId = (await source.getDepartureBoard("durlacher-tor")).departures[0].id;

  // Never re-read: ten minutes on, it is ten minutes old.
  t.mock.timers.tick(600_000);
  const read = await source.getRun(rowId);

  assert.equal(read?.tripCalls?.length, 2);
  assert.equal(read?.readAt?.sequenceReadAt, boardReadAt);
});

test("board churn spends the cap on finished runs before the vehicles still out", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:30:00.000Z") });
  const stillRunning = "2026-08-26T06:30:00.000Z";
  const alreadyOver = "2026-08-26T05:00:00.000Z";

  // Exactly the cap; the finished run sits between unfinished ones, so neither age nor order picks
  // it.
  const filling = [
    createRememberedDeparture(0, stillRunning),
    createRememberedDeparture(1, alreadyOver),
    ...Array.from({ length: RUN_READING_STORE_CAPACITY - 2 }, (_, index) =>
      createRememberedDeparture(index + 2, stillRunning),
    ),
  ];
  const source = createBoardSource({
    "7001001": filling,
    "7001002": [createRememberedDeparture(9_000, stillRunning)],
  });

  const board = await source.getDepartureBoard("durlacher-tor");
  assert.equal(board.departures.length, RUN_READING_STORE_CAPACITY);
  const [oldestRunningId, finishedId] = board.departures.map((departure) => departure.id);
  assert.notEqual(oldestRunningId, finishedId);
  assert.ok(await source.getRun(finishedId));

  // One over the cap: one run must go.
  await source.getDepartureBoard("kronenplatz");

  assert.equal(await source.getRun(finishedId), undefined);
  assert.ok(await source.getRun(oldestRunningId));
});

test("the cap is a bound, not a preference: all-running churn still evicts the oldest", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:30:00.000Z") });
  const stillRunning = "2026-08-26T06:30:00.000Z";
  const source = createBoardSource({
    "7001001": Array.from({ length: RUN_READING_STORE_CAPACITY }, (_, index) =>
      createRememberedDeparture(index, stillRunning),
    ),
    "7001002": [createRememberedDeparture(9_000, stillRunning)],
  });

  const board = await source.getDepartureBoard("durlacher-tor");
  const oldestId = board.departures[0].id;
  assert.ok(await source.getRun(oldestId));

  await source.getDepartureBoard("kronenplatz");

  assert.equal(await source.getRun(oldestId), undefined);
});

/**
 * A two-level place is one stop: the Europaplatz board is asked for the street point, but the S1
 * calls at the tunnel point, which must resolve to `europaplatz` too.
 */
test("a trip calling at a place's other level resolves to that place", async () => {
  const tunnelLocator: KvvTripLocator = {
    tripCode: "412",
    line: "kvv:22001:E:H:s26",
    stopPointId: "7001004",
    date: "20260826",
    time: "0730",
  };
  const rawTrip = parseTripResponse(
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
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Europaplatz",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingLines: [],
      departures: [
        {
          stopPointId: "7001004",
          stopPointName: "Europaplatz (U)",
          tripId: "de:kvv:00S01_:.trip",
          lineId: "S1",
          transportMode: "lightRail",
          destination: "Hochstetten",
          minutesUntilDeparture: 1,
          platformCode: "2(U)",
          status: "realtime",
          scheduledDepartureTime: "2026-08-26T05:30:00.000Z",
          tripLocator: tunnelLocator,
        },
      ],
    }),
    fetchTrip: async (): Promise<KvvTrip> => rawTrip,
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const board = await source.getDepartureBoard("europaplatz");
  const trip = await source.getRun(board.departures[0].id);

  assert.equal(trip?.tripCalls?.[0].localStopId, "europaplatz");
  assert.deepEqual(
    getCallsAfterStop(trip!, "europaplatz").map((call) => call.localStopId),
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
  const parsedBoard = parseDepartureBoardResponse(boardPayload, "7001002");
  const rawTrip = parseTripResponse(tripPayload, locator);
  const client = {
    fetchDepartureBoard: async (): Promise<KvvDepartureBoard> => parsedBoard,
    fetchTrip: async (): Promise<KvvTrip> => rawTrip,
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("kronenplatz");
  const row = board.departures[0];

  const merged = await source.getRun(row.id);

  // One dated id, or the diagram draws two vehicles.
  assert.equal(merged?.tripInstanceId, row.tripInstanceId);
  assert.equal(row.tripInstanceId, "de:kvv:00S04_:.trip@2026-08-26T05:30");
});

test("a line's stops are read as rows, and each trip's calls are fetched once for all of them", async () => {
  // A run listed at every stop it will call at is read once, and every board's row completed from
  // it.
  const runRequests: KvvTripLocator[] = [];
  const boardRequests: { stopId: string; lineIds?: readonly string[] }[] = [];
  const runningTrip = (stopPointId: string, minute: number): KvvDeparture => ({
    stopPointId,
    stopPointName: stopPointId,
    tripId: "de:kvv:00S04_:.trip",
    lineId: "S4",
    routeDirectionId: "kvv:22304:E:H:s26",
    transportMode: "tram",
    destination: "Hochstetten",
    minutesUntilDeparture: minute,
    platformCode: "",
    status: "realtime",
    scheduledDepartureTime: "2026-08-26T07:30:00.000Z",
    // Any row's locator reads the trip.
    tripLocator: locator,
  });
  const client = {
    fetchDepartureBoard: async (
      stopPointId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => {
      boardRequests.push({ stopId: stopPointId, lineIds: options.lineIds });
      return {
        stopPointId,
        stopName: stopPointId,
        serverTime: "2026-08-26T07:29:45",
        servingLines: [],
        // One run, seen from three stops.
        departures: [runningTrip(stopPointId, 2)],
      };
    },
    fetchTrip: async (requested: KvvTripLocator): Promise<KvvTrip> => {
      runRequests.push(requested);
      return parseTripResponse(tripPayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const boards = await source.getLineDepartureBoards(
    ["europaplatz", "muehlburger-tor", "entenfang"],
    { routeDirectionIds: ["kvv:22304:E:H:s26"] },
  );

  // Three boards, one trip read.
  assert.equal(boardRequests.length, 3);
  assert.equal(runRequests.length, 1);
  // Filtered boards skip the mode macros, which would return every row's sequence.
  assert.deepEqual(
    boardRequests.map((request) => request.lineIds?.length),
    [1, 1, 1],
  );
  // Every row carries the one reading's calls.
  assert.deepEqual(
    boards.map((board) => board.departures[0].tripCalls?.length),
    [2, 2, 2],
  );
  assert.deepEqual(
    boards.map((board) => board.departures[0].tripInstanceId),
    Array(3).fill(boards[0].departures[0].tripInstanceId),
  );
  // The same object a view reading the run by id gets; views memoize on identity.
  for (const board of boards) {
    const row = board.departures[0];
    assert.equal(source.findRun(row.id), row);
  }
});

test("a line's runs are re-read at their own tolerance, apart from the boards that name them", async (t) => {
  // Runs revise about every 35 s, so a line asks its runs for a fresher tolerance than its boards.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T07:29:45.000Z") });
  const rawTrip = parseTripResponse(tripPayload, locator);
  let runRequests = 0;
  let boardRequests = 0;
  const client = {
    fetchDepartureBoard: async (stopPointId: string): Promise<KvvDepartureBoard> => {
      boardRequests += 1;
      return {
        stopPointId,
        stopName: stopPointId,
        serverTime: "2026-08-26T07:29:45",
        servingLines: [],
        departures: [
          {
            stopPointId,
            stopPointName: stopPointId,
            tripId: "de:kvv:00S04_:.trip",
            lineId: "S4",
            routeDirectionId: "kvv:22304:E:H:s26",
            transportMode: "tram",
            destination: "Hochstetten",
            minutesUntilDeparture: 2,
            platformCode: "",
            status: "realtime",
            scheduledDepartureTime: "2026-08-26T07:30:00.000Z",
            tripLocator: locator,
          },
        ],
      };
    },
    fetchTrip: async (): Promise<KvvTrip> => {
      runRequests += 1;
      return rawTrip;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const routeDirectionIds = ["kvv:22304:E:H:s26"];

  await source.getLineDepartureBoards(["europaplatz"], {
    routeDirectionIds,
    maxAgeMs: 90_000,
    runMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(runRequests, 1);

  // A minute on, the boards are within tolerance; the runs are not.
  t.mock.timers.tick(60_000);
  await source.getLineDepartureBoards(["europaplatz"], {
    routeDirectionIds,
    maxAgeMs: 90_000,
    runMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(runRequests, 2);

  // Unnamed, the runs' tolerance follows the boards'.
  t.mock.timers.tick(60_000);
  await source.getLineDepartureBoards(["europaplatz"], { routeDirectionIds, maxAgeMs: 90_000 });
  assert.equal(boardRequests, 2);
  assert.equal(runRequests, 2);
});

test("a trip whose sequence cannot be read still keeps the row it was found on", async () => {
  // A failed read keeps the row; the next round asks again.
  const client = {
    fetchDepartureBoard: async (stopPointId: string): Promise<KvvDepartureBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      departures: [
        {
          stopPointId,
          stopPointName: stopPointId,
          tripId: "de:kvv:00S04_:.trip",
          lineId: "S4",
          routeDirectionId: "kvv:22304:E:H:s26",
          transportMode: "tram",
          destination: "Hochstetten",
          minutesUntilDeparture: 2,
          status: "realtime",
          scheduledDepartureTime: "2026-08-26T07:30:00.000Z",
          tripLocator: locator,
        } as KvvDeparture,
      ],
    }),
    fetchTrip: async (): Promise<KvvTrip> => {
      throw new Error("Fahrt nicht lesbar");
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const boards = await source.getLineDepartureBoards(["europaplatz"], {
    routeDirectionIds: ["kvv:22304:E:H:s26"],
  });

  assert.equal(boards[0].departures.length, 1);
  assert.equal(boards[0].departures[0].tripCalls, undefined);
});

test("a line's reading asks for the calls of the runs out on it, not of tomorrow's departures", async () => {
  // A run whose nearest call is hours away has not set out; its sequence is not read.
  const runRequests: KvvTripLocator[] = [];
  const run = (tripId: string, minutesUntilDeparture: number): KvvDeparture =>
    ({
      stopPointId: "7001001",
      stopPointName: "stop",
      tripId,
      lineId: "S4",
      routeDirectionId: "kvv:22304:E:H:s26",
      transportMode: "tram",
      destination: "Hochstetten",
      minutesUntilDeparture,
      status: "realtime",
      scheduledDepartureTime: "2026-08-26T07:30:00.000Z",
      tripLocator: tripId.endsWith(".tomorrow") ? { ...locator, tripCode: "tomorrow" } : locator,
    }) as KvvDeparture;
  const client = {
    fetchDepartureBoard: async (stopPointId: string): Promise<KvvDepartureBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      departures: [run("de:kvv:00S04_:.trip", 4), run("de:kvv:00S04_:.tomorrow", 220)],
    }),
    fetchTrip: async (requested: KvvTripLocator): Promise<KvvTrip> => {
      runRequests.push(requested);
      return parseTripResponse(tripPayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const [board] = await source.getLineDepartureBoards(["europaplatz"], {
    routeDirectionIds: ["kvv:22304:E:H:s26"],
  });

  assert.equal(runRequests.length, 1);
  const [underWay, notYetOut] = board.departures;
  assert.ok(underWay.tripCalls?.length);
  // The row stays a readable departure; an address naming it reads its calls itself.
  assert.equal(notYetOut.tripCalls, undefined);
  assert.equal(notYetOut.destination, "Hochstetten");
});

test("a run is read once for all its stops, however far along it the rows are", async () => {
  // The nearest row decides: one vehicle, minutes from one stop, an hour from another.
  const runRequests: KvvTripLocator[] = [];
  const row = (stopPointId: string, minutesUntilDeparture: number): KvvDeparture =>
    ({
      stopPointId,
      stopPointName: stopPointId,
      tripId: "de:kvv:00S04_:.trip",
      lineId: "S4",
      routeDirectionId: "kvv:22304:E:H:s26",
      transportMode: "tram",
      destination: "Hochstetten",
      minutesUntilDeparture,
      status: "realtime",
      scheduledDepartureTime: "2026-08-26T07:30:00.000Z",
      tripLocator: locator,
    }) as KvvDeparture;
  let read = 0;
  const client = {
    fetchDepartureBoard: async (stopPointId: string): Promise<KvvDepartureBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      // Near at the next stop, an hour off at the far end.
      departures: [row(stopPointId, read++ === 0 ? 3 : 62)],
    }),
    fetchTrip: async (requested: KvvTripLocator): Promise<KvvTrip> => {
      runRequests.push(requested);
      return parseTripResponse(tripPayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const boards = await source.getLineDepartureBoards(["europaplatz", "entenfang"], {
    routeDirectionIds: ["kvv:22304:E:H:s26"],
  });

  assert.equal(runRequests.length, 1);
  assert.deepEqual(
    boards.map((board) => Boolean(board.departures[0].tripCalls?.length)),
    [true, true],
  );
});

test("line boards keep reused timetable ids separated by their run records", async () => {
  const requestedCodes: string[] = [];
  const run = (tripCode: string, scheduledDepartureTime: string): KvvDeparture => ({
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    tripId: "reused-timetable-trip",
    lineId: "S4",
    routeDirectionId: locator.line,
    transportMode: "tram",
    destination: `Ziel ${tripCode}`,
    minutesUntilDeparture: 2,
    platformCode: "1",
    status: "realtime",
    scheduledDepartureTime,
    tripLocator: {
      ...locator,
      tripCode,
      time: scheduledDepartureTime.slice(11, 16).replace(":", ""),
    },
  });
  const client = {
    fetchDepartureBoard: async (): Promise<KvvDepartureBoard> => ({
      stopPointId: "7001001",
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T07:29:45",
      servingLines: [],
      departures: [
        run("first", "2026-08-26T07:30:00.000Z"),
        run("second", "2026-08-26T07:40:00.000Z"),
      ],
    }),
    fetchTrip: async (requested: KvvTripLocator): Promise<KvvTrip> => {
      requestedCodes.push(requested.tripCode);
      const minute = requested.tripCode === "first" ? "30" : "40";
      return {
        serverTime: "2026-08-26T07:29:45",
        tripCalls: [
          {
            stopName: "Durlacher Tor/KIT-Campus Süd (U)",
            providerId: "7001001",
            scheduledDepartureTime: `2026-08-26T07:${minute}:00.000Z`,
            delayMinutes: requested.tripCode === "first" ? 1 : 2,
          },
        ],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const [board] = await source.getLineDepartureBoards(["durlacher-tor"], {
    routeDirectionIds: [locator.line],
  });

  assert.deepEqual(requestedCodes.sort(), ["first", "second"]);
  assert.deepEqual(
    board.departures.map((departure) => departure.tripCalls?.[0]?.delayMinutes),
    [1, 2],
  );
});

/**
 * The four run lifetimes nest. A cache outliving the store serves rows that are no longer runs; a
 * mark outliving the store's grace is drawn from a record `findRun` cannot answer.
 */
test("a run's four lifetimes nest, innermost first", () => {
  assert.ok(DEFAULT_BOARD_MAX_AGE_MS < RUN_MARK_RETENTION_GRACE_MS);
  assert.ok(RUN_MARK_RETENTION_GRACE_MS < RUN_ENDED_GRACE_MS);
  assert.ok(RUN_ENDED_GRACE_MS < RUN_READING_MAX_AGE_MS);
});

/**
 * A cached board is not re-parsed, so its rows are only remembered when fetched; if the cache
 * outlived the store, every stop would ask for the same run again.
 */
test("a board can never be served from cache after its rows have been forgotten", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  let boardFetches = 0;
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => {
      boardFetches += 1;
      return {
        stopPointId: providerStopId,
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        serverTime: "2026-08-26T05:29:45.000Z",
        servingLines: [],
        departures: [createRememberedDeparture(0, "2026-08-26T05:35:00.000Z")],
      };
    },
    fetchTrip: async (): Promise<KvvTrip> => {
      throw new Error("no trip should be requested");
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const [row] = (await source.getDepartureBoard("durlacher-tor")).departures;
  assert.equal(boardFetches, 1);
  assert.ok(await source.getRun(row.id));

  // Past the run's end plus grace: the next write sweeps it.
  t.mock.timers.tick(Date.parse("2026-08-26T05:35:00.000Z") - Date.now() + RUN_ENDED_GRACE_MS + 1);

  // The board is refetched, so its rows are remembered again.
  const [reread] = (await source.getDepartureBoard("durlacher-tor")).departures;
  assert.equal(boardFetches, 2);
  assert.equal(reread.id, row.id);
  assert.ok(await source.getRun(row.id));
});

test("a failed refresh answers with the last live board until it is too old to act on", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  let isFeedDown = false;
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => {
      if (isFeedDown) throw new Error("offline");
      return {
        stopPointId: providerStopId,
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        serverTime: "2026-08-26T05:29:45.000Z",
        servingLines: [],
        departures: [createRememberedDeparture(0, "2026-08-26T05:35:00.000Z")],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const live = await source.getDepartureBoard("durlacher-tor");

  isFeedDown = true;
  t.mock.timers.tick(60_000);
  const kept = await source.getDepartureBoard("durlacher-tor");
  assert.equal(kept.dataStatus, "live");
  assert.equal(kept.receivedAt, live.receivedAt, "the kept board states its real age");
  assert.equal(kept.dataStatus === "live" && kept.refreshFailedAt, Date.now());

  t.mock.timers.tick(10 * 60_000);
  assert.equal((await source.getDepartureBoard("durlacher-tor")).dataStatus, "unavailable");
});
