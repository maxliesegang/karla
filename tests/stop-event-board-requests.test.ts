import assert from "node:assert/strict";
import test from "node:test";
import { STOP_EVENT_BOARD_CACHE_CAPACITY, TriasTransitSource } from "../src/data/transit-source.ts";
import type { Feed } from "../src/data/feed.ts";
import type { FeedStopEvent, FeedStopEventBoard } from "../src/data/feed.ts";
import { kvvStopPlaces } from "../src/networks/kvv/stop-places.ts";

/** One stop point, so each board is one request. */
const STOP_ID = "muehlburger-tor";
const STOP_ROW_LIMIT = 20;

/** Records what the provider was asked for. */
function createRecordingSource() {
  const requests: {
    providerStopId: string;
    includeCalls: boolean;
    limit?: number;
    lineIds?: readonly string[];
  }[] = [];
  const client = {
    fetchStopEventBoard: async (
      providerStopId: string,
      options: { includeCalls?: boolean; limit?: number; lineIds?: readonly string[] } = {},
    ): Promise<FeedStopEventBoard> => {
      requests.push({
        providerStopId,
        includeCalls: Boolean(options.includeCalls),
        limit: options.limit,
        ...(options.lineIds ? { lineIds: options.lineIds } : {}),
      });
      return {
        stopPointId: providerStopId,
        stopName: "Mühlburger Tor",
        serverTime: "",
        stopEvents: [],
      };
    },
  } as unknown as Feed;
  return { source: new TriasTransitSource(client), requests };
}

test("a board already in hand answers a second reader without a request of its own", async () => {
  const { source, requests } = createRecordingSource();

  await source.getStopEventBoard(STOP_ID, { includeCalls: true });
  await source.getStopEventBoard(STOP_ID, { includeCalls: true, maxAgeMs: 90_000 });

  assert.equal(requests.length, 1);
});

test("topology boards are reusable for thirty minutes and then require a new reading", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const { source, requests } = createRecordingSource();
  const request = { includeCalls: true, maxAgeMs: 30 * 60_000 };
  await source.getStopEventBoard(STOP_ID, request);
  t.mock.timers.tick(29 * 60_000);
  await source.getStopEventBoard(STOP_ID, request);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(60_000);
  await source.getStopEventBoard(STOP_ID, { ...request, maxAgeMs: 60 * 60_000 });
  assert.equal(requests.length, 2);
});

test("board variants evict the least recently read board at capacity", async () => {
  const { source, requests } = createRecordingSource();
  const request = (id: number) => ({ lineRefs: [`direction-${id}`] });
  for (let index = 0; index < STOP_EVENT_BOARD_CACHE_CAPACITY; index += 1) {
    await source.getStopEventBoard(STOP_ID, request(index));
  }
  await source.getStopEventBoard(STOP_ID, request(0));
  await source.getStopEventBoard(STOP_ID, request(STOP_EVENT_BOARD_CACHE_CAPACITY));
  await source.getStopEventBoard(STOP_ID, request(0));
  assert.equal(requests.length, STOP_EVENT_BOARD_CACHE_CAPACITY + 1);
  await source.getStopEventBoard(STOP_ID, request(1));
  assert.equal(requests.length, STOP_EVENT_BOARD_CACHE_CAPACITY + 2);
});

const directionA = "kvv:test:A:H:s26";
const directionB = "kvv:test:B:H:s26";
const directionC = "kvv:test:C:H:s26";
const directionD = "kvv:test:D:H:s26";
const serverTime = "2026-08-26T10:00:00.000Z";

function stopEvent(
  journeyRef: string,
  lineRef: string,
  timetabledDepartureTime: string,
): FeedStopEvent {
  return {
    stopPointId: "provider-stop",
    stopPointName: "Mühlburger Tor",
    journeyRef,
    lineId:
      lineRef === directionA
        ? "A"
        : lineRef === directionB
          ? "B"
          : lineRef === directionC
            ? "C"
            : "D",
    lineRef,
    ptMode: "lightRail",
    destinationText: `${lineRef} Ziel`,
    minutesUntilDeparture: 10,
    bay: "1",
    status: "realtime",
    timetabledDepartureTime,
  };
}

/**
 * `feed`, whose runs read at Karlstor also call at Mühlburger Tor under `lineRefs`: TRIAS boards state
 * no serving lines, so reading Karlstor is how the source learns what serves Mühlburger Tor.
 */
function servedBy(feed: Feed, lineRefs: readonly string[]): Feed {
  const [karlstor] = kvvStopPlaces.karlstor.stopPoints;
  const [stopPoint] = kvvStopPlaces[STOP_ID].stopPoints;
  return {
    ...feed,
    fetchStopEventBoard: async (stopPointId, options) =>
      stopPointId === karlstor
        ? {
            stopPointId,
            stopName: "Karlstor",
            serverTime,
            stopEvents: lineRefs.map((lineRef) => ({
              ...stopEvent(`serving-${lineRef}`, lineRef, serverTime),
              stopPointId,
              calls: [{ stopName: "Mühlburger Tor", providerId: stopPoint }],
            })),
          }
        : feed.fetchStopEventBoard(stopPointId, options),
  };
}

/** A source that has learned `lineRefs` serve Mühlburger Tor. */
async function createServedSource(feed: Feed, lineRefs: readonly string[]) {
  const source = new TriasTransitSource(servedBy(feed, lineRefs));
  await source.getStopEventBoard("karlstor", { includeCalls: true });
  return source;
}

test("a covered stop board batches sparse directions and keeps only live rows inside its horizon", async () => {
  const requests: { lineIds?: readonly string[]; limit?: number }[] = [];
  const baseStopEvents = [
    stopEvent("a1", directionA, "2026-08-26T10:10:00.000Z"),
    stopEvent("a2", directionA, "2026-08-26T10:40:00.000Z"),
    stopEvent("a-late", directionA, "2026-08-26T13:00:01.000Z"),
    stopEvent("b1", directionB, "2026-08-26T10:20:00.000Z"),
  ];
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: {
        limit?: number;
        lineIds?: readonly string[];
      } = {},
    ): Promise<FeedStopEventBoard> => {
      requests.push(options);
      return options.lineIds
        ? {
            stopPointId: "provider-stop",
            stopName: "Mühlburger Tor",
            serverTime,
            stopEvents: [
              baseStopEvents[3],
              stopEvent("b2", directionB, "2026-08-26T11:20:00.000Z"),
              stopEvent("c1", directionC, "2026-08-26T11:00:00.000Z"),
              // Much later scheduled service must not show now.
              stopEvent("c-late", directionC, "2026-08-26T13:00:01.000Z"),
            ],
          }
        : {
            stopPointId: "provider-stop",
            stopName: "Mühlburger Tor",
            serverTime,
            stopEvents: baseStopEvents,
          };
    },
  } as unknown as Feed;

  const source = await createServedSource(client, [directionA, directionB, directionC]);
  const board = await source.getStopEventBoard(STOP_ID, {
    minimumStopEventsPerDirection: 2,
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
    board.stopEvents.map(({ journeyRef }) => journeyRef),
    ["a1", "b1", "a2", "c1", "b2"],
  );
});

test("a full second answer that still starves a direction earns a third pass", async () => {
  // Each filtered pass spends its limit on the direction needing it least; only a pass for the last
  // direction alone reaches it. Each pass asks for fewer lines.
  const requests: { lineIds?: readonly string[]; limit?: number }[] = [];
  const baseStopEvents = [
    stopEvent("a1", directionA, "2026-08-26T10:10:00.000Z"),
    stopEvent("a2", directionA, "2026-08-26T10:40:00.000Z"),
    stopEvent("b1", directionB, "2026-08-26T10:20:00.000Z"),
  ];
  // As many rows as the limit, all for the first direction asked.
  const supplementRowsByFirstDirection: Record<string, FeedStopEvent[]> = {
    [directionB]: [
      stopEvent("b2", directionB, "2026-08-26T10:50:00.000Z"),
      stopEvent("b3", directionB, "2026-08-26T11:00:00.000Z"),
      stopEvent("b4", directionB, "2026-08-26T11:10:00.000Z"),
      stopEvent("b5", directionB, "2026-08-26T11:20:00.000Z"),
      stopEvent("b6", directionB, "2026-08-26T11:30:00.000Z"),
      stopEvent("b7", directionB, "2026-08-26T11:40:00.000Z"),
    ],
    [directionC]: [
      stopEvent("c1", directionC, "2026-08-26T10:30:00.000Z"),
      stopEvent("c2", directionC, "2026-08-26T11:05:00.000Z"),
      stopEvent("c3", directionC, "2026-08-26T11:15:00.000Z"),
      stopEvent("c4", directionC, "2026-08-26T11:45:00.000Z"),
    ],
    [directionD]: [
      stopEvent("d1", directionD, "2026-08-26T10:25:00.000Z"),
      stopEvent("d2", directionD, "2026-08-26T10:55:00.000Z"),
    ],
  };
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: {
        limit?: number;
        lineIds?: readonly string[];
      } = {},
    ): Promise<FeedStopEventBoard> => {
      requests.push(options);
      return {
        stopPointId: "provider-stop",
        stopName: "Mühlburger Tor",
        serverTime,
        stopEvents: options.lineIds
          ? (supplementRowsByFirstDirection[options.lineIds[0]] ?? [])
          : baseStopEvents,
      };
    },
  } as unknown as Feed;

  const source = await createServedSource(client, [directionA, directionB, directionC, directionD]);
  const board = await source.getStopEventBoard(STOP_ID, {
    minimumStopEventsPerDirection: 2,
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
  for (const { lineRef = "" } of board.stopEvents)
    rowsByDirection.set(lineRef, (rowsByDirection.get(lineRef) ?? 0) + 1);
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
  const base = stopEvent("a1", directionA, "2026-08-26T10:10:00.000Z");
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<FeedStopEventBoard> => {
      requests.push(options);
      return {
        stopPointId: "provider-stop",
        stopName: "Mühlburger Tor",
        serverTime,
        // On no unfiltered board, which is why it is asked for.
        stopEvents: options.lineIds
          ? [stopEvent("c1", directionC, "2026-08-26T11:00:00.000Z")]
          : [base],
      };
    },
  } as unknown as Feed;
  const source = await createServedSource(client, [directionA, directionC]);
  const read = () =>
    source.getStopEventBoard(STOP_ID, { minimumStopEventsPerDirection: 2, maxAgeMs: 0 });

  const first = await read();
  assert.ok(first.stopEvents.some(({ journeyRef }) => journeyRef === "c1"));

  // Still under-covered (hourly), but not re-asked every cycle; the row stands until old.
  t.mock.timers.tick(60_000);
  const second = await read();
  assert.equal(requests.filter(({ lineIds }) => lineIds).length, 1);
  assert.ok(second.stopEvents.some(({ journeyRef }) => journeyRef === "c1"));
});

test("a held supplement is dropped rather than aged into the rider's next few minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(serverTime) });
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<FeedStopEventBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Mühlburger Tor",
      serverTime,
      stopEvents: options.lineIds
        ? // Two minutes out: nearer than the reading's age, so the live board's to state.
          [stopEvent("c1", directionC, "2026-08-26T10:02:00.000Z")]
        : [stopEvent("a1", directionA, "2026-08-26T10:10:00.000Z")],
    }),
  } as unknown as Feed;
  const source = await createServedSource(client, [directionA, directionC]);
  const read = () =>
    source.getStopEventBoard(STOP_ID, { minimumStopEventsPerDirection: 2, maxAgeMs: 0 });

  assert.ok((await read()).stopEvents.some(({ journeyRef }) => journeyRef === "c1"));
  // Four minutes on, the held reading is older than the departure is far; it stops showing.
  t.mock.timers.tick(4 * 60_000);
  assert.deepEqual(
    (await read()).stopEvents.map(({ journeyRef }) => journeyRef),
    ["a1"],
  );
});

test("a failed coverage pass returns the current basic board, never a half-completed one", async () => {
  let failSupplement = false;
  const base = stopEvent("a1", directionA, "2026-08-26T10:10:00.000Z");
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<FeedStopEventBoard> => {
      if (options.lineIds && failSupplement) throw new Error("offline");
      return {
        stopPointId: "provider-stop",
        stopName: "Mühlburger Tor",
        serverTime,
        stopEvents: options.lineIds
          ? [stopEvent("c1", directionC, "2026-08-26T11:00:00.000Z")]
          : [base],
      };
    },
  } as unknown as Feed;
  const source = await createServedSource(client, [directionA, directionC]);

  failSupplement = true;
  const board = await source.getStopEventBoard(STOP_ID, { minimumStopEventsPerDirection: 2 });

  assert.deepEqual(
    board.stopEvents.map(({ journeyRef }) => journeyRef),
    ["a1"],
  );
});

test("a reader that will accept nothing stale is answered from the feed", async () => {
  const { source, requests } = createRecordingSource();

  await source.getStopEventBoard(STOP_ID, { includeCalls: true });
  await source.getStopEventBoard(STOP_ID, { includeCalls: true, maxAgeMs: 0 });

  assert.equal(requests.length, 2);
});

test("only a view that draws the trips pays for the calling sequences", async () => {
  const { source, requests } = createRecordingSource();

  // A plain board is read without calls.
  await source.getStopEventBoard(STOP_ID);
  assert.deepEqual(requests, [
    { providerStopId: requests[0].providerStopId, includeCalls: false, limit: STOP_ROW_LIMIT },
  ]);

  // Opening a line wants the whole trip.
  await source.getStopEventBoard(STOP_ID, { includeCalls: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].includeCalls, true);
  assert.equal(requests[1].limit, STOP_ROW_LIMIT);

  // The detailed board answers for the light one.
  await source.getStopEventBoard(STOP_ID);
  assert.equal(requests.length, 2);
});

test("a board that carries the calls answers a reader that only wanted the rows", async () => {
  const { source, requests } = createRecordingSource();

  await source.getStopEventBoard(STOP_ID, { includeCalls: true });
  await source.getStopEventBoard(STOP_ID);

  assert.deepEqual(
    requests.map(({ includeCalls, limit }) => ({ includeCalls, limit })),
    [{ includeCalls: true, limit: STOP_ROW_LIMIT }],
  );
});

test("two readers asking at once share the one request in flight", async () => {
  const { source, requests } = createRecordingSource();

  await Promise.all([
    source.getStopEventBoard(STOP_ID, { includeCalls: true, maxAgeMs: 0 }),
    source.getStopEventBoard(STOP_ID, { includeCalls: true, maxAgeMs: 0 }),
  ]);

  assert.equal(requests.length, 1);
});

test("a line-filtered board is never allowed to answer a reader asking for the whole stop", async () => {
  // Filtered and unfiltered answer different questions, so they are cached apart.
  const { source, requests } = createRecordingSource();

  await source.getStopEventBoard(STOP_ID, {
    includeCalls: true,
    lineRefs: [directionA],
  });
  await source.getStopEventBoard(STOP_ID, { includeCalls: true, maxAgeMs: 90_000 });

  assert.deepEqual(
    requests.map(({ lineIds }) => lineIds),
    [[directionA], undefined],
  );
});

test("two readers naming the same lines in any order share one filtered request", async () => {
  const { source, requests } = createRecordingSource();

  await source.getStopEventBoard(STOP_ID, {
    includeCalls: true,
    lineRefs: [directionA, directionB],
  });
  await source.getStopEventBoard(STOP_ID, {
    includeCalls: true,
    maxAgeMs: 90_000,
    lineRefs: [directionB, directionA],
  });

  assert.equal(requests.length, 1);
});

test("a filtered board does not shrink what the stop is known to serve", async () => {
  // A filtered answer must never be recorded as the stop's serving directions.
  const requests: { lineIds?: readonly string[] }[] = [];
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: {
        lineIds?: readonly string[];
      } = {},
    ): Promise<FeedStopEventBoard> => {
      requests.push(options);
      return {
        stopPointId: "provider-stop",
        stopName: "Mühlburger Tor",
        serverTime,
        stopEvents: [
          stopEvent("a1", directionA, "2026-08-26T10:10:00.000Z"),
          stopEvent("a2", directionA, "2026-08-26T10:40:00.000Z"),
          stopEvent("b1", directionB, "2026-08-26T10:20:00.000Z"),
        ],
      };
    },
  } as unknown as Feed;
  const source = await createServedSource(client, [directionA, directionB, directionC]);

  await source.getStopEventBoard(STOP_ID);
  await source.getStopEventBoard(STOP_ID, { lineRefs: [directionA] });
  await source.getStopEventBoard(STOP_ID, {
    minimumStopEventsPerDirection: 2,
    coverageHorizonMs: 2 * 60 * 60_000,
  });

  const supplemented = requests.flatMap(({ lineIds }) => lineIds ?? []);
  assert.ok(supplemented.includes(directionC), "directionC must still be supplemented");
});

/** One run under two trip ids, as the monitor and its filtered completion answer it. */
const datedJourneyReading = (
  journeyRef: string,
  timetabledDepartureTime: string,
  delayMinutes?: number,
): FeedStopEvent => ({
  ...stopEvent(journeyRef, directionA, timetabledDepartureTime),
  publishedJourneyNumber: "84991",
  status: delayMinutes === undefined ? "scheduled" : "realtime",
  ...(delayMinutes === undefined ? {} : { delayMinutes }),
});

test("one run read twice is one row, and it is the row carrying the prediction", async () => {
  // The monitor returns the same S5 twice (trip ids differing by a segment, one train number).
  const client = {
    fetchStopEventBoard: async (): Promise<FeedStopEventBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Mühlburger Tor",
      serverTime,
      stopEvents: [
        datedJourneyReading(
          "de:kvv:00S05_:.kvv-22-305-E.7.T0.1604.s26",
          "2026-08-26T10:05:00.000Z",
        ),
        datedJourneyReading(
          "de:kvv:00S05_:.kvv-22-305-E.7.T0.1586.s26",
          "2026-08-26T10:05:00.000Z",
          6,
        ),
        // A different train number is a different vehicle.
        {
          ...datedJourneyReading("other", "2026-08-26T10:05:00.000Z", 3),
          publishedJourneyNumber: "84992",
        },
      ],
    }),
  } as unknown as Feed;

  const board = await new TriasTransitSource(client).getStopEventBoard(STOP_ID);

  assert.equal(board.stopEvents.length, 2);
  assert.deepEqual(
    board.stopEvents.map(({ publishedJourneyNumber, delayMinutes }) => ({
      publishedJourneyNumber,
      delayMinutes,
    })),
    [
      { publishedJourneyNumber: "84992", delayMinutes: 3 },
      { publishedJourneyNumber: "84991", delayMinutes: 6 },
    ],
  );
});

test("a completion may not state a run the live board already carries", async () => {
  // The filtered pass's own trip id for an already stated run must not double the row.
  const baseRow = datedJourneyReading(
    "de:kvv:00S05_:.kvv-22-305-E.7.T0.1604.s26",
    "2026-08-26T10:05:00.000Z",
    6,
  );
  const client = {
    fetchStopEventBoard: async (
      _providerStopId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<FeedStopEventBoard> => ({
      stopPointId: "provider-stop",
      stopName: "Mühlburger Tor",
      serverTime,
      stopEvents: options.lineIds
        ? [
            datedJourneyReading(
              "de:kvv:00S05_:.kvv-22-305-E.7.T0.1586.s26",
              "2026-08-26T10:05:00.000Z",
            ),
          ]
        : [baseRow],
    }),
  } as unknown as Feed;

  const board = await new TriasTransitSource(client).getStopEventBoard(STOP_ID, {
    minimumStopEventsPerDirection: 2,
  });

  assert.equal(board.stopEvents.length, 1);
  assert.equal(board.stopEvents[0].delayMinutes, 6);
});
