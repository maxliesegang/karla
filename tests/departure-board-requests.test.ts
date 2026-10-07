import assert from "node:assert/strict";
import test from "node:test";
import { DEPARTURE_BOARD_CACHE_CAPACITY, KvvTransitSource } from "../src/data/transit-source.ts";
import type { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import type { KvvDeparture, KvvDepartureBoard } from "../src/data/kvv-efa-parsers.ts";
import { kvvStopMappingByLocalStopId } from "../src/data/kvv-stop-mappings.ts";

const STOP_ID = "europaplatz";
/** These tests check what is asked for, not row counts. */
const STOP_ROW_LIMIT = kvvStopMappingByLocalStopId[STOP_ID].departureLimit ?? 20;

/** Records what the provider was asked for. */
function createRecordingSource() {
  const requests: {
    providerStopId: string;
    includeTripCalls: boolean;
    limit?: number;
    lineIds?: readonly string[];
  }[] = [];
  const client = {
    fetchDepartureBoard: async (
      providerStopId: string,
      options: { includeTripCalls?: boolean; limit?: number; lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => {
      requests.push({
        providerStopId,
        includeTripCalls: Boolean(options.includeTripCalls),
        limit: options.limit,
        ...(options.lineIds ? { lineIds: options.lineIds } : {}),
      });
      return {
        stopPointId: providerStopId,
        stopName: "Europaplatz",
        serverTime: "",
        servingLines: [],
        departures: [],
      };
    },
  } as unknown as KvvEfaClient;
  return { source: new KvvTransitSource(client), requests };
}

test("a board already in hand answers a second reader without a request of its own", async () => {
  const { source, requests } = createRecordingSource();

  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true });
  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true, maxAgeMs: 90_000 });

  assert.equal(requests.length, 1);
});

test("topology boards are reusable for thirty minutes and then require a new reading", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { source, requests } = createRecordingSource();
  const request = { includeTripCalls: true, maxAgeMs: 30 * 60_000 };
  await source.getDepartureBoard(STOP_ID, request);
  t.mock.timers.tick(29 * 60_000);
  await source.getDepartureBoard(STOP_ID, request);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(60_000);
  await source.getDepartureBoard(STOP_ID, { ...request, maxAgeMs: 60 * 60_000 });
  assert.equal(requests.length, 2);
});

test("board variants evict the least recently read board at capacity", async () => {
  const { source, requests } = createRecordingSource();
  const request = (id: number) => ({ routeDirectionIds: [`direction-${id}`] });
  for (let index = 0; index < DEPARTURE_BOARD_CACHE_CAPACITY; index += 1) {
    await source.getDepartureBoard(STOP_ID, request(index));
  }
  await source.getDepartureBoard(STOP_ID, request(0));
  await source.getDepartureBoard(STOP_ID, request(DEPARTURE_BOARD_CACHE_CAPACITY));
  await source.getDepartureBoard(STOP_ID, request(0));
  assert.equal(requests.length, DEPARTURE_BOARD_CACHE_CAPACITY + 1);
  await source.getDepartureBoard(STOP_ID, request(1));
  assert.equal(requests.length, DEPARTURE_BOARD_CACHE_CAPACITY + 2);
});

const directionA = "kvv:test:A:H:s26";
const directionB = "kvv:test:B:H:s26";
const directionC = "kvv:test:C:H:s26";
const directionD = "kvv:test:D:H:s26";
const serverTime = "2026-08-26T10:00:00.000Z";

function departure(
  tripId: string,
  routeDirectionId: string,
  scheduledDepartureTime: string,
): KvvDeparture {
  return {
    stopPointId: "provider-stop",
    stopPointName: "Europaplatz",
    tripId,
    lineId:
      routeDirectionId === directionA
        ? "A"
        : routeDirectionId === directionB
          ? "B"
          : routeDirectionId === directionC
            ? "C"
            : "D",
    routeDirectionId,
    transportMode: "lightRail",
    destination: `${routeDirectionId} Ziel`,
    minutesUntilDeparture: 10,
    platformCode: "1",
    status: "realtime",
    scheduledDepartureTime,
  };
}

test("a covered stop board batches sparse directions and keeps only live rows inside its horizon", async () => {
  const requests: { lineIds?: readonly string[]; limit?: number }[] = [];
  const baseDepartures = [
    departure("a1", directionA, "2026-08-26T10:10:00.000Z"),
    departure("a2", directionA, "2026-08-26T10:40:00.000Z"),
    departure("a-late", directionA, "2026-08-26T13:00:01.000Z"),
    departure("b1", directionB, "2026-08-26T10:20:00.000Z"),
  ];
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: {
        limit?: number;
        lineIds?: readonly string[];
      } = {},
    ): Promise<KvvDepartureBoard> => {
      requests.push(options);
      return options.lineIds
        ? {
            stopPointId: "provider-stop",
            stopName: "Europaplatz",
            serverTime,
            servingLines: [],
            departures: [
              baseDepartures[3],
              departure("b2", directionB, "2026-08-26T11:20:00.000Z"),
              departure("c1", directionC, "2026-08-26T11:00:00.000Z"),
              // Much later scheduled service must not show now.
              departure("c-late", directionC, "2026-08-26T13:00:01.000Z"),
            ],
          }
        : {
            stopPointId: "provider-stop",
            stopName: "Europaplatz",
            serverTime,
            servingLines: [
              { lineId: "test", directionId: directionA },
              { lineId: "test", directionId: directionB },
              { lineId: "test", directionId: directionC },
            ],
            departures: baseDepartures,
          };
    },
  } as unknown as KvvEfaClient;

  const board = await new KvvTransitSource(client).getDepartureBoard(STOP_ID, {
    minimumDeparturesPerDirection: 2,
    coverageHorizonMs: 2 * 60 * 60_000,
  });

  assert.deepEqual(
    requests.map(({ lineIds, limit }) => ({ lineIds, limit })),
    [
      { lineIds: undefined, limit: STOP_ROW_LIMIT },
      { lineIds: [directionB, directionC], limit: 4 },
      { lineIds: [directionC], limit: 2 },
    ],
  );
  assert.deepEqual(
    board.departures.map(({ tripId }) => tripId),
    ["a1", "b1", "a2", "c1", "b2"],
  );
});

test("a full second answer that still starves a direction earns a third pass", async () => {
  // Each filtered pass spends its limit on the direction needing it least; only a pass for the last
  // direction alone reaches it. Each pass asks for fewer lines.
  const requests: { lineIds?: readonly string[]; limit?: number }[] = [];
  const baseDepartures = [
    departure("a1", directionA, "2026-08-26T10:10:00.000Z"),
    departure("a2", directionA, "2026-08-26T10:40:00.000Z"),
    departure("b1", directionB, "2026-08-26T10:20:00.000Z"),
  ];
  // As many rows as the limit, all for the first direction asked.
  const supplementRowsByFirstDirection: Record<string, KvvDeparture[]> = {
    [directionB]: [
      departure("b2", directionB, "2026-08-26T10:50:00.000Z"),
      departure("b3", directionB, "2026-08-26T11:00:00.000Z"),
      departure("b4", directionB, "2026-08-26T11:10:00.000Z"),
      departure("b5", directionB, "2026-08-26T11:20:00.000Z"),
      departure("b6", directionB, "2026-08-26T11:30:00.000Z"),
      departure("b7", directionB, "2026-08-26T11:40:00.000Z"),
    ],
    [directionC]: [
      departure("c1", directionC, "2026-08-26T10:30:00.000Z"),
      departure("c2", directionC, "2026-08-26T11:05:00.000Z"),
      departure("c3", directionC, "2026-08-26T11:15:00.000Z"),
      departure("c4", directionC, "2026-08-26T11:45:00.000Z"),
    ],
    [directionD]: [
      departure("d1", directionD, "2026-08-26T10:25:00.000Z"),
      departure("d2", directionD, "2026-08-26T10:55:00.000Z"),
    ],
  };
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: {
        limit?: number;
        lineIds?: readonly string[];
      } = {},
    ): Promise<KvvDepartureBoard> => {
      requests.push(options);
      return {
        stopPointId: "provider-stop",
        stopName: "Europaplatz",
        serverTime,
        servingLines: options.lineIds
          ? []
          : [directionA, directionB, directionC, directionD].map((directionId) => ({
              lineId: "test",
              directionId,
            })),
        departures: options.lineIds
          ? (supplementRowsByFirstDirection[options.lineIds[0]] ?? [])
          : baseDepartures,
      };
    },
  } as unknown as KvvEfaClient;

  const board = await new KvvTransitSource(client).getDepartureBoard(STOP_ID, {
    minimumDeparturesPerDirection: 2,
    coverageHorizonMs: 2 * 60 * 60_000,
  });

  assert.deepEqual(
    requests.map(({ lineIds, limit }) => ({ lineIds, limit })),
    [
      { lineIds: undefined, limit: STOP_ROW_LIMIT },
      { lineIds: [directionB, directionC, directionD], limit: 6 },
      { lineIds: [directionC, directionD], limit: 4 },
      { lineIds: [directionD], limit: 2 },
    ],
  );
  const rowsByDirection = new Map<string, number>();
  for (const { routeDirectionId = "" } of board.departures)
    rowsByDirection.set(routeDirectionId, (rowsByDirection.get(routeDirectionId) ?? 0) + 1);
  assert.deepEqual(
    [...rowsByDirection].sort(([left], [right]) => left.localeCompare(right)),
    [
      [directionA, 2],
      [directionB, 7],
      [directionC, 4],
      [directionD, 2],
    ],
  );
});

test("a coverage supplement is a reading of its own, not part of the board's cycle", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(serverTime) });
  const requests: { lineIds?: readonly string[] }[] = [];
  const base = departure("a1", directionA, "2026-08-26T10:10:00.000Z");
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => {
      requests.push(options);
      return {
        stopPointId: "provider-stop",
        stopName: "Europaplatz",
        serverTime,
        servingLines: options.lineIds
          ? []
          : [
              { lineId: "test", directionId: directionA },
              { lineId: "test", directionId: directionC },
            ],
        // On no unfiltered board, which is why it is asked for.
        departures: options.lineIds
          ? [departure("c1", directionC, "2026-08-26T11:00:00.000Z")]
          : [base],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const read = () =>
    source.getDepartureBoard(STOP_ID, { minimumDeparturesPerDirection: 2, maxAgeMs: 0 });

  const first = await read();
  assert.ok(first.departures.some(({ tripId }) => tripId === "c1"));

  // Still under-covered (hourly), but not re-asked every cycle; the row stands until old.
  t.mock.timers.tick(60_000);
  const second = await read();
  assert.equal(requests.filter(({ lineIds }) => lineIds).length, 1);
  assert.ok(second.departures.some(({ tripId }) => tripId === "c1"));
});

test("a held supplement is dropped rather than aged into the rider's next few minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(serverTime) });
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Europaplatz",
      serverTime,
      servingLines: options.lineIds
        ? []
        : [
            { lineId: "test", directionId: directionA },
            { lineId: "test", directionId: directionC },
          ],
      departures: options.lineIds
        ? // Two minutes out: nearer than the reading's age, so the live board's to state.
          [departure("c1", directionC, "2026-08-26T10:02:00.000Z")]
        : [departure("a1", directionA, "2026-08-26T10:10:00.000Z")],
    }),
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const read = () =>
    source.getDepartureBoard(STOP_ID, { minimumDeparturesPerDirection: 2, maxAgeMs: 0 });

  assert.ok((await read()).departures.some(({ tripId }) => tripId === "c1"));
  // Four minutes on, the held reading is older than the departure is far; it stops showing.
  t.mock.timers.tick(4 * 60_000);
  assert.deepEqual(
    (await read()).departures.map(({ tripId }) => tripId),
    ["a1"],
  );
});

test("a failed coverage pass returns the current basic board, never a half-completed one", async () => {
  let failSupplement = false;
  const base = departure("a1", directionA, "2026-08-26T10:10:00.000Z");
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => {
      if (options.lineIds && failSupplement) throw new Error("offline");
      return {
        stopPointId: "provider-stop",
        stopName: "Europaplatz",
        serverTime,
        servingLines: options.lineIds
          ? []
          : [
              { lineId: "test", directionId: directionA },
              { lineId: "test", directionId: directionC },
            ],
        departures: options.lineIds
          ? [departure("c1", directionC, "2026-08-26T11:00:00.000Z")]
          : [base],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  failSupplement = true;
  const board = await source.getDepartureBoard(STOP_ID, { minimumDeparturesPerDirection: 2 });

  assert.deepEqual(
    board.departures.map(({ tripId }) => tripId),
    ["a1"],
  );
});

test("a reader that will accept nothing stale is answered from the feed", async () => {
  const { source, requests } = createRecordingSource();

  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true });
  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true, maxAgeMs: 0 });

  assert.equal(requests.length, 2);
});

test("only a view that draws the trips pays for the calling sequences", async () => {
  const { source, requests } = createRecordingSource();

  // A plain board is read without calls.
  await source.getDepartureBoard(STOP_ID);
  assert.deepEqual(requests, [
    { providerStopId: requests[0].providerStopId, includeTripCalls: false, limit: STOP_ROW_LIMIT },
  ]);

  // Opening a line wants the whole trip.
  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].includeTripCalls, true);
  assert.equal(requests[1].limit, STOP_ROW_LIMIT);

  // The detailed board answers for the light one.
  await source.getDepartureBoard(STOP_ID);
  assert.equal(requests.length, 2);
});

test("a board that carries the calls answers a reader that only wanted the rows", async () => {
  const { source, requests } = createRecordingSource();

  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true });
  await source.getDepartureBoard(STOP_ID);

  assert.deepEqual(
    requests.map(({ includeTripCalls, limit }) => ({ includeTripCalls, limit })),
    [{ includeTripCalls: true, limit: STOP_ROW_LIMIT }],
  );
});

test("two readers asking at once share the one request in flight", async () => {
  const { source, requests } = createRecordingSource();

  await Promise.all([
    source.getDepartureBoard(STOP_ID, { includeTripCalls: true, maxAgeMs: 0 }),
    source.getDepartureBoard(STOP_ID, { includeTripCalls: true, maxAgeMs: 0 }),
  ]);

  assert.equal(requests.length, 1);
});

test("a line-filtered board is never allowed to answer a reader asking for the whole stop", async () => {
  // Filtered and unfiltered answer different questions, so they are cached apart.
  const { source, requests } = createRecordingSource();

  await source.getDepartureBoard(STOP_ID, {
    includeTripCalls: true,
    routeDirectionIds: [directionA],
  });
  await source.getDepartureBoard(STOP_ID, { includeTripCalls: true, maxAgeMs: 90_000 });

  assert.deepEqual(
    requests.map(({ lineIds }) => lineIds),
    [[directionA], undefined],
  );
});

test("two readers naming the same lines in any order share one filtered request", async () => {
  const { source, requests } = createRecordingSource();

  await source.getDepartureBoard(STOP_ID, {
    includeTripCalls: true,
    routeDirectionIds: [directionA, directionB],
  });
  await source.getDepartureBoard(STOP_ID, {
    includeTripCalls: true,
    maxAgeMs: 90_000,
    routeDirectionIds: [directionB, directionA],
  });

  assert.equal(requests.length, 1);
});

test("a filtered board does not shrink what the stop is known to serve", async () => {
  // A filtered answer must never be recorded as the stop's serving directions.
  const requests: { lineIds?: readonly string[] }[] = [];
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: {
        lineIds?: readonly string[];
      } = {},
    ): Promise<KvvDepartureBoard> => {
      requests.push(options);
      return {
        stopPointId: "provider-stop",
        stopName: "Europaplatz",
        serverTime,
        // Only the unfiltered board states the whole set.
        servingLines: options.lineIds
          ? []
          : [
              { lineId: "test", directionId: directionA },
              { lineId: "test", directionId: directionB },
              { lineId: "test", directionId: directionC },
            ],
        departures: [
          departure("a1", directionA, "2026-08-26T10:10:00.000Z"),
          departure("a2", directionA, "2026-08-26T10:40:00.000Z"),
          departure("b1", directionB, "2026-08-26T10:20:00.000Z"),
        ],
      };
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  await source.getDepartureBoard(STOP_ID);
  await source.getDepartureBoard(STOP_ID, { routeDirectionIds: [directionA] });
  await source.getDepartureBoard(STOP_ID, {
    minimumDeparturesPerDirection: 2,
    coverageHorizonMs: 2 * 60 * 60_000,
  });

  const supplemented = requests.flatMap(({ lineIds }) => lineIds ?? []);
  assert.ok(supplemented.includes(directionC), "directionC must still be supplemented");
});

/** One run under two trip ids, as the monitor and its filtered completion answer it. */
const runReading = (
  tripId: string,
  scheduledDepartureTime: string,
  delayMinutes?: number,
): KvvDeparture => ({
  ...departure(tripId, directionA, scheduledDepartureTime),
  trainNumber: "84991",
  status: delayMinutes === undefined ? "scheduled" : "realtime",
  ...(delayMinutes === undefined ? {} : { delayMinutes }),
});

test("one run read twice is one row, and it is the row carrying the prediction", async () => {
  // The monitor returns the same S5 twice (trip ids differing by a segment, one train number).
  const client = {
    fetchDepartureBoard: async (): Promise<KvvDepartureBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Europaplatz",
      serverTime,
      servingLines: [{ lineId: "test", directionId: directionA }],
      departures: [
        runReading("de:kvv:00S05_:.kvv-22-305-E.7.T0.1604.s26", "2026-08-26T10:05:00.000Z"),
        runReading("de:kvv:00S05_:.kvv-22-305-E.7.T0.1586.s26", "2026-08-26T10:05:00.000Z", 6),
        // A different train number is a different vehicle.
        {
          ...runReading("other", "2026-08-26T10:05:00.000Z", 3),
          trainNumber: "84992",
        },
      ],
    }),
  } as unknown as KvvEfaClient;

  const board = await new KvvTransitSource(client).getDepartureBoard(STOP_ID);

  assert.equal(board.departures.length, 2);
  assert.deepEqual(
    board.departures.map(({ trainNumber, delayMinutes }) => ({ trainNumber, delayMinutes })),
    [
      { trainNumber: "84992", delayMinutes: 3 },
      { trainNumber: "84991", delayMinutes: 6 },
    ],
  );
});

test("a completion may not state a run the live board already carries", async () => {
  // The filtered pass's own trip id for an already stated run must not double the row.
  const baseRow = runReading(
    "de:kvv:00S05_:.kvv-22-305-E.7.T0.1604.s26",
    "2026-08-26T10:05:00.000Z",
    6,
  );
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Europaplatz",
      serverTime,
      servingLines: [{ lineId: "test", directionId: directionA }],
      departures: options.lineIds
        ? [runReading("de:kvv:00S05_:.kvv-22-305-E.7.T0.1586.s26", "2026-08-26T10:05:00.000Z")]
        : [baseRow],
    }),
  } as unknown as KvvEfaClient;

  const board = await new KvvTransitSource(client).getDepartureBoard(STOP_ID, {
    minimumDeparturesPerDirection: 2,
  });

  assert.equal(board.departures.length, 1);
  assert.equal(board.departures[0].delayMinutes, 6);
});

test("a board that describes the whole stop names the directions it knows there", async () => {
  // At a terminus the returning direction has no row anywhere; only this metadata names it.
  const client = {
    fetchDepartureBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<KvvDepartureBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Europaplatz",
      serverTime,
      // A filtered answer covers only what it asked about.
      servingLines: options.lineIds
        ? [{ lineId: "test", directionId: directionA }]
        : [
            { lineId: "test", directionId: directionA },
            { lineId: "test", directionId: directionB },
          ],
      departures: [],
    }),
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);

  const wholeStop = await source.getDepartureBoard(STOP_ID);
  assert.deepEqual(
    wholeStop.servingLines?.map(({ directionId }) => directionId),
    [directionA, directionB],
  );

  // A filtered board carries none: its silence is not evidence.
  const filtered = await source.getDepartureBoard(STOP_ID, { routeDirectionIds: [directionA] });
  assert.equal(filtered.servingLines, undefined);
});

test("a stop whose board is shared between boarding places asks for more of it", async () => {
  const { source, requests } = createRecordingSource();

  // Europaplatz shares one board between four places, street trips listed twice; twenty rows are
  // too few.
  await source.getDepartureBoard(STOP_ID);
  assert.equal(requests[0].limit, 40);
  assert.ok(STOP_ROW_LIMIT > 20);
});
