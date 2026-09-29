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
  // `prevStopSeq` stops one call short of the board's own stop and `onwardStopSeq` starts one call
  // past it. Left as the feed sends it the trip has a hole exactly where the reading is freshest —
  // a call no vehicle can be placed at, in a different place in every board's copy of the trip.
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
  // The row's own two facts, which are the only account of this call there is.
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

  // The row leaves from the street platform (`7000071`) on a board requested for the tunnel id.
  // The provider answers both from either, so both are the one stop the rider addressed — which is
  // what lets `lib/trip-calls.ts` find the current call for a street departure on this board.
  assert.equal(board.stopId, "ettlinger-tor");
  assert.equal(board.departures[0].boardingLocalStopId, "ettlinger-tor");
});

test("the single-trip response validates its locator and preserves call-level cancellation", () => {
  const trip = parseTripResponse(tripPayload, locator);

  // Resolved to a real instant at the boundary, never handed on as the bare local components the
  // feed states: read as the viewer's own local time it would be right in Karlsruhe and hours out
  // everywhere else, and it is the clock every countdown in the app is counted from.
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

test("the row's own call is marked once, where the trip calls at that stop three times", () => {
  // Waidweg's terminus loop, as line 3 really reports it: the vehicle is timed into the loop's
  // entry point (Gleis 1) at 23:42, stands at the public Gleis 3 — the row's own 23:44 — and
  // parks on Gleis 2 at 23:45, where the feed says the run ends (timed into, out of nothing).
  // All three are stop point `7000306`. Marking every call at the echoed stop left the row's
  // identity ambiguous: the `über …` beside the row named the stop itself, the mark was re-timed
  // from the loop's entry point, and the diagram drew the terminus as three stops.
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
  // The operator signs the platform `3` and never words it; the label keeps the number, the way
  // the board's own row is completed — the one thing that parts the stop's repeated rows.
  assert.equal(marked[0].platformLabel, "3");
  // The run-end call stays unmarked, so the pair the feed itself marks can still be folded.
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
  // The kept reading answers the second call as itself, dated when it was actually taken.
  assert.deepEqual(second, first);
  // An ordinary board served from cache resolves through the same store too. Otherwise another
  // view can refresh this run while the board keeps publishing its old, incomplete row object.
  const cachedBoard = await source.getDepartureBoard("durlacher-tor", { maxAgeMs: 5 * 60_000 });
  assert.equal(cachedBoard.departures[0], source.findRun(rowId));
  assert.equal(cachedBoard.departures[0], first);
  // A board a view already holds catches up the same way, without being fetched again.
  assert.notEqual(board.departures[0], first);
  assert.equal(source.resolveBoard(board).departures[0], first);
  assert.equal(source.resolveBoard(cachedBoard), cachedBoard);
});

test("a detailed ordinary board publishes the canonical run object", async (t) => {
  // Before the run's last call, or the network has already let the finished trip go.
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

  // A sequence does not move and the times a rider reads come from the stop row, so a vehicle the
  // rider did not choose sits out a board refresh; the trip they did choose does not.
  await source.getRun(rowId, 90_000);
  t.mock.timers.tick(30_000);
  await source.getRun(rowId, 90_000);
  assert.equal(runRequests, 1);

  t.mock.timers.tick(70_000);
  await source.getRun(rowId, 90_000);
  assert.equal(runRequests, 2);
});

/**
 * A board row that already carries its sequence, so `getRun` answers it without any request at
 * all — which makes the same call a probe for whether the source still remembers the row.
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
 * Freshness is a fact about the reading, not about the question.
 *
 * A retained ride asks for its trip on the board's cadence and dates its observation by what comes
 * back. Both of the paths that answer without reading anything — a sequence still inside the
 * caller's tolerance, and a row that arrived carrying its own calls and has no locator to re-read
 * with — would otherwise hand back an old reading stamped with the current instant, and the ride
 * would go on claiming it had just been read while the number on it stood still.
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

  // Nothing re-reads this row: its board is not refreshed and it has no locator to ask with. Ten
  // minutes on, it is a ten-minute-old reading and says so.
  t.mock.timers.tick(600_000);
  const read = await source.getRun(rowId);

  assert.equal(read?.tripCalls?.length, 2);
  assert.equal(read?.readAt?.sequenceReadAt, boardReadAt);
});

test("board churn spends the cap on finished runs before the vehicles still out", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:30:00.000Z") });
  const stillRunning = "2026-08-26T06:30:00.000Z";
  const alreadyOver = "2026-08-26T05:00:00.000Z";

  // Exactly the cap, oldest first: the run that has finished sits between two that have not, so
  // neither age nor insertion order can be what picks it.
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

  // One row over the cap, so exactly one remembered run has to go.
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
 * A place with two levels is one local stop, and a trip must reach it from the level it runs on.
 *
 * The Europaplatz board is requested for the street stop point, while the S1 through the
 * Kaiserstraße tunnel calls at the tunnel one. Unless that call resolves to `europaplatz` too, the
 * trip leaves a stop the page has never heard of: nothing reads a corridor from it, and the row
 * falls back to its headsign.
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
  // The same run read twice: a board times the trip's first call to the half minute and publishes
  // its own row to the minute, while the single-trip endpoint times that first call to the second.
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

  // One dated identity, or the line diagram follows the row and the trip as two vehicles.
  assert.equal(merged?.tripInstanceId, row.tripInstanceId);
  assert.equal(row.tripInstanceId, "de:kvv:00S04_:.trip@2026-08-26T05:30");
});

test("a line's stops are read as rows, and each trip's calls are fetched once for all of them", async () => {
  // The same run is listed at every stop it has yet to leave. Asked for per board, its calling
  // sequence arrived once per stop; asked for per trip, once — and every board's copy of the row
  // is completed from it.
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
    status: "realtime",
    scheduledDepartureTime: "2026-08-26T07:30:00.000Z",
    // Every row of a run carries a locator naming its own stop; any one of them reads the trip.
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
        // The one run, seen from each of the three stops it has yet to call at.
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

  // Three stops read, one trip read.
  assert.equal(boardRequests.length, 3);
  assert.equal(runRequests.length, 1);
  // Every board asked for the line alone: a filtered board cannot hold another, and needs none of
  // the mode macros that would make it answer with every row's sequence again.
  assert.deepEqual(
    boardRequests.map((request) => request.lineIds?.length),
    [1, 1, 1],
  );
  // And every board's row carries the calls that one reading returned.
  assert.deepEqual(
    boards.map((board) => board.departures[0].tripCalls?.length),
    [2, 2, 2],
  );
  assert.deepEqual(
    boards.map((board) => board.departures[0].tripInstanceId),
    Array(3).fill(boards[0].departures[0].tripInstanceId),
  );
  // And it is the *same object* a view reading the run by id gets, not a second merge beside it.
  // Two equal copies of one reading are two identities, and identity is what every view downstream
  // memoises on: the board that "changed" and the mark that redrew would both be saying nothing.
  for (const board of boards) {
    const row = board.departures[0];
    assert.equal(source.findRun(row.id), row);
  }
});

test("a line's runs are re-read at their own tolerance, apart from the boards that name them", async (t) => {
  // The boards state which runs exist; the calls a diagram places vehicles from are the runs' own
  // readings, and the feed revises those about every thirty-five seconds. So a line names its runs
  // a fresher tolerance than the boards, and the boards' slower cadence answers the cheaper half
  // of the reading from memory while the marks move.
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

  // A minute on, the boards' reading is still inside its tolerance; the runs' is not.
  t.mock.timers.tick(60_000);
  await source.getLineDepartureBoards(["europaplatz"], {
    routeDirectionIds,
    maxAgeMs: 90_000,
    runMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(runRequests, 2);

  // Unnamed, the runs' reading keeps the boards': the coupling is what stands unless a caller
  // names it apart.
  t.mock.timers.tick(60_000);
  await source.getLineDepartureBoards(["europaplatz"], { routeDirectionIds, maxAgeMs: 90_000 });
  assert.equal(boardRequests, 2);
  assert.equal(runRequests, 2);
});

test("a trip whose sequence cannot be read still keeps the row it was found on", async () => {
  // A reading that failed is not evidence that the run is not there: the row stands, and the next
  // round asks again. Losing it would take a vehicle off the diagram for a lost packet.
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
  // Forty rows at each of seventy stops name a couple of hundred runs, of which a dozen are on the
  // line. Every stop of the line is read, so a vehicle out there is minutes from somewhere: a run
  // whose nearest call anywhere is hours away has not set out, and a sequence read for it buys a
  // mark that would never be placed.
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
  // The row itself stands either way: it is a departure a rider can read, and the address naming
  // it reads its calls on its own (`selection.ts`).
  assert.equal(notYetOut.tripCalls, undefined);
  assert.equal(notYetOut.destination, "Hochstetten");
});

test("a run is read once for all its stops, however far along it the rows are", async () => {
  // The nearest row decides: the same run is minutes away at the stop it is approaching and an
  // hour away at the end of its route, and it is one vehicle either way.
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
      // Near at the stop ahead of it, an hour off at the far end of the same run.
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
 * The four lifetimes of one run, nested — the ordering `RUN_ENDED_GRACE_MS` states.
 *
 * They live in three files and nothing but this asserts that they still nest. Each pair matters on
 * its own: a board cache outliving the store hands out rows that are no longer addressable as runs,
 * and a mark outliving the store's grace is drawn from a record `findRun` can no longer answer.
 */
test("a run's four lifetimes nest, innermost first", () => {
  assert.ok(DEFAULT_BOARD_MAX_AGE_MS < RUN_MARK_RETENTION_GRACE_MS);
  assert.ok(RUN_MARK_RETENTION_GRACE_MS < RUN_ENDED_GRACE_MS);
  assert.ok(RUN_ENDED_GRACE_MS < RUN_READING_MAX_AGE_MS);
});

/**
 * The consequence of the innermost pair, at the boundary rather than in the constants.
 *
 * A cached board is not re-parsed, so its rows are only ever remembered when it was *fetched*. Were
 * the cache the longer-lived of the two, a board could be served whose rows the store had already
 * swept, `findRunRecordKey` would fall back to the bare row id for every one of them, and a line's
 * stops would go back to asking for the same run once each — with `getRun` answering none of them.
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

  // Past the run's own end and the grace its evidence is held for: the next write sweeps the record.
  t.mock.timers.tick(Date.parse("2026-08-26T05:35:00.000Z") - Date.now() + RUN_ENDED_GRACE_MS + 1);

  // The board is re-fetched rather than served, so the rows the sweep took are put back by the same
  // read that took them, and the run stays addressable across the boundary.
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
