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
      servingLines: { lines: [{ mode: { diva: { stateless: "kvv:22304:E:H:s26" } } }] },
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
  assert.deepEqual(board.servingDirectionIds, [locator.line]);
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
      servingDirectionIds: [],
      departures: [
        {
          stopPointId: "7000071",
          stopPointName: "Ettlinger Tor/Staatstheater",
          lineId: "5",
          transportMode: "tram",
          destination: "Europaplatz",
          minutesUntilDeparture: 2,
          platformName: "1",
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
  assert.equal(board.departures[0].boardingStopId, "ettlinger-tor");
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

test("TransitSource merges one trip into the latest stop row and caches its sequence", async () => {
  const rawDeparture: KvvDeparture = {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    tripId: "de:kvv:00S04_:.trip",
    lineId: "S4",
    transportMode: "lightRail",
    destination: "Karlsruhe Albtalbahnhof",
    minutesUntilDeparture: 1,
    platformName: "1(U)",
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
      servingDirectionIds: [],
      departures: [rawDeparture],
    }),
    fetchTrip: async (requested: KvvTripLocator): Promise<KvvTrip> => {
      requests.push(requested);
      return rawTrip;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("durlacher-tor");
  const departureId = board.departures[0].id;

  const first = await source.getTrip(departureId);
  const second = await source.getTrip(departureId);

  assert.deepEqual(requests, [locator]);
  assert.equal(first?.trip.platformName, "1(U)");
  assert.equal(first?.trip.destination, "Karlsruhe Albtalbahnhof");
  assert.equal(first?.trip.status, "cancelled");
  assert.equal(first?.trip.tripCalls?.length, 2);
  assert.equal(first?.trip.tripCalls?.[1].localStopId, "kronenplatz");
  // The kept reading answers the second call as itself, dated when it was actually taken.
  assert.deepEqual(second, first);
});

test("a trip nobody selected is re-read on its own terms, not on the board's", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const rawTrip = parseTripResponse(tripPayload, locator);
  let tripRequests = 0;
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      servingDirectionIds: [],
      departures: [
        {
          stopPointId: "7001001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          tripId: "de:kvv:00S04_:.trip",
          lineId: "S4",
          transportMode: "lightRail",
          destination: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          platformName: "1(U)",
          status: "realtime",
          scheduledDepartureTime: "2026-08-26T05:30:00.000Z",
          tripLocator: locator,
        },
      ],
    }),
    fetchTrip: async (): Promise<KvvTrip> => {
      tripRequests += 1;
      return rawTrip;
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const departureId = (await source.getDepartureBoard("durlacher-tor")).departures[0].id;

  // A sequence does not move and the times a rider reads come from the stop row, so a vehicle the
  // rider did not choose sits out a board refresh; the trip they did choose does not.
  await source.getTrip(departureId, 90_000);
  t.mock.timers.tick(30_000);
  await source.getTrip(departureId, 90_000);
  assert.equal(tripRequests, 1);

  t.mock.timers.tick(70_000);
  await source.getTrip(departureId, 90_000);
  assert.equal(tripRequests, 2);
});

/**
 * A board row that already carries its sequence, so `getTrip` answers it without any request at
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
      servingDirectionIds: [],
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
      servingDirectionIds: [],
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
  const departureId = (await source.getDepartureBoard("durlacher-tor")).departures[0].id;

  const read = await source.getTrip(departureId, 90_000);
  assert.equal(read?.receivedAt, Date.now());

  t.mock.timers.tick(30_000);
  assert.equal((await source.getTrip(departureId, 90_000))?.receivedAt, read?.receivedAt);

  t.mock.timers.tick(70_000);
  assert.equal((await source.getTrip(departureId, 90_000))?.receivedAt, Date.now());
});

test("a row that carries its own calls is dated by the board it arrived on", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const source = createBoardSource({
    "7001001": [createRememberedDeparture(0, "2026-08-26T06:30:00.000Z")],
  });
  const boardReadAt = Date.now();
  const departureId = (await source.getDepartureBoard("durlacher-tor")).departures[0].id;

  // Nothing re-reads this row: its board is not refreshed and it has no locator to ask with. Ten
  // minutes on, it is a ten-minute-old reading and says so.
  t.mock.timers.tick(600_000);
  const read = await source.getTrip(departureId);

  assert.equal(read?.trip.tripCalls?.length, 2);
  assert.equal(read?.receivedAt, boardReadAt);
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
    ...Array.from({ length: 1_022 }, (_, index) =>
      createRememberedDeparture(index + 2, stillRunning),
    ),
  ];
  const source = createBoardSource({
    "7001001": filling,
    "7001002": [createRememberedDeparture(9_000, stillRunning)],
  });

  const board = await source.getDepartureBoard("durlacher-tor");
  assert.equal(board.departures.length, 1_024);
  const [oldestRunningId, finishedId] = board.departures.map((departure) => departure.id);
  assert.notEqual(oldestRunningId, finishedId);
  assert.ok(await source.getTrip(finishedId));

  // One row over the cap, so exactly one remembered run has to go.
  await source.getDepartureBoard("kronenplatz");

  assert.equal(await source.getTrip(finishedId), undefined);
  assert.ok(await source.getTrip(oldestRunningId));
});

test("the cap is a bound, not a preference: all-running churn still evicts the oldest", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:30:00.000Z") });
  const stillRunning = "2026-08-26T06:30:00.000Z";
  const source = createBoardSource({
    "7001001": Array.from({ length: 1_024 }, (_, index) =>
      createRememberedDeparture(index, stillRunning),
    ),
    "7001002": [createRememberedDeparture(9_000, stillRunning)],
  });

  const board = await source.getDepartureBoard("durlacher-tor");
  const oldestId = board.departures[0].id;
  assert.ok(await source.getTrip(oldestId));

  await source.getDepartureBoard("kronenplatz");

  assert.equal(await source.getTrip(oldestId), undefined);
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
      servingDirectionIds: [],
      departures: [
        {
          stopPointId: "7001004",
          stopPointName: "Europaplatz (U)",
          tripId: "de:kvv:00S01_:.trip",
          lineId: "S1",
          transportMode: "lightRail",
          destination: "Hochstetten",
          minutesUntilDeparture: 1,
          platformName: "2(U)",
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
  const trip = await source.getTrip(board.departures[0].id);

  assert.equal(trip?.trip.tripCalls?.[0].localStopId, "europaplatz");
  assert.deepEqual(
    getCallsAfterStop(trip!.trip, "europaplatz").map((call) => call.localStopId),
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

  const merged = await source.getTrip(row.id);

  // One dated identity, or the line diagram follows the row and the trip as two vehicles.
  assert.equal(merged?.trip.tripInstanceId, row.tripInstanceId);
  assert.equal(row.tripInstanceId, "de:kvv:00S04_:.trip@2026-08-26T05:30");
});
