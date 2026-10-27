import assert from "node:assert/strict";
import test from "node:test";
import {
  type Feed,
  type FeedStopEvent,
  type FeedStopEventBoard,
  type FeedTripInfo,
  type FeedCall,
  type DatedJourneyRef,
  type RowCallRef,
} from "../src/data/feed.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";
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

const operatingDayRef = "2026-08-26";
const S4_LINE_REF = "kvv:22304:E:H:s26";

/** The S4's run 888 as its trip request answers it: cancelled, Durlacher Tor then Kronenplatz. */
const journey: FeedTripInfo = {
  serverTime: "2026-08-26T05:30:45.000Z",
  status: "cancelled",
  calls: [
    {
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      placeName: "Karlsruhe",
      bayText: "Gleis 1(U)",
      providerId: "de:08212:1001",
      latitude: 49.00902,
      longitude: 8.416531,
      timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
    },
    {
      stopName: "Kronenplatz (U)",
      placeName: "Karlsruhe",
      bayText: "Gleis 1(U)",
      providerId: "de:08212:1002",
      latitude: 49.009362,
      longitude: 8.409794,
      timetabledArrivalTime: "2026-08-26T05:31:00.000Z",
      timetabledDepartureTime: "2026-08-26T05:32:00.000Z",
    },
  ],
};

/** The run as read for a row: its call there is the row's own. */
const readJourney = (rowStopPointId = "de:08212:1001"): FeedTripInfo => ({
  ...journey,
  calls: journey.calls.map((call) => ({
    ...call,
    isThisCall: call.providerId === rowStopPointId || undefined,
  })),
});

test("both levels of one place answer as that place, whichever platform the row leaves from", async () => {
  const client = {
    fetchStopEventBoard: async (): Promise<FeedStopEventBoard> => ({
      stopPointId: "de:08212:1012",
      stopName: "Ettlinger Tor/Staatstheater (U)",
      serverTime: "2026-08-26T12:00:00.000Z",
      stopEvents: [
        {
          stopPointId: "de:08212:71",
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
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

  const board = await source.getStopEventBoard("ettlinger-tor");

  // The row leaves from the street point (`de:08212:71`) on a board asked for the tunnel id; both are
  // the addressed stop.
  assert.equal(board.stopId, "ettlinger-tor");
  assert.equal(board.stopEvents[0].boardingLocalStopId, "ettlinger-tor");
});

test("a scheduled-only S4 can be placed from its call times without claiming predictions", () => {
  const stopEvent = createStopEvent({
    lineId: "S4",
    status: "scheduled",
    calls: readJourney().calls.map((call) => ({ ...call, localStopId: call.providerId })),
  });
  const placement = getDatedJourneyPlacement(
    createDatedJourneyMotions(),
    stopEvent,
    Date.parse("2026-08-26T05:30:45Z"),
  );
  assert.equal(placement?.fromStopId, "de:08212:1001");
  assert.equal(placement?.toStopId, "de:08212:1002");
});

test("TransitSource merges one trip into the latest stop row and caches its sequence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const rawStopEvent: FeedStopEvent = {
    stopPointId: "de:08212:1001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: "de:kvv:00S04_:.trip",
    lineId: "S4",
    ptMode: "lightRail",
    destinationText: "Karlsruhe Albtalbahnhof",
    minutesUntilDeparture: 1,
    bay: "1(U)",
    status: "realtime",
    timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
    operatingDayRef,
  };
  const rawJourney = readJourney();
  const requests: DatedJourneyRef[] = [];
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      stopEvents: [rawStopEvent],
    }),
    fetchTripInfo: async (requested: DatedJourneyRef): Promise<FeedTripInfo> => {
      requests.push(requested);
      return rawJourney;
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
  const board = await source.getStopEventBoard("durlacher-tor");
  const rowId = board.stopEvents[0].id;
  const rowReadAt = Date.now();

  t.mock.timers.tick(2 * 60_000);
  const first = await source.getDatedJourney(rowId);
  const second = await source.getDatedJourney(rowId);

  assert.deepEqual(requests, [{ journeyRef: "de:kvv:00S04_:.trip", operatingDayRef }]);
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
    "de:08212:1001": [createRememberedStopEvent(0, "2026-08-26T05:35:00.000Z")],
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
  const rawJourney = readJourney();
  let datedJourneyRequests = 0;
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      stopEvents: [
        {
          stopPointId: "de:08212:1001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          ptMode: "lightRail",
          destinationText: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          bay: "1(U)",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          operatingDayRef,
        },
      ],
    }),
    fetchTripInfo: async (): Promise<FeedTripInfo> => {
      datedJourneyRequests += 1;
      return rawJourney;
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
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
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      stopEvents: [
        {
          stopPointId: "de:08212:1001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          ptMode: "lightRail",
          destinationText: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          bay: "1(U)",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          operatingDayRef,
        },
      ],
    }),
    // The fixture trip is cancelled, and a cancelled run teaches nothing.
    fetchTripInfo: async (): Promise<FeedTripInfo> => ({
      ...readJourney(),
      status: undefined,
    }),
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
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

/** A row with its board's calls and no operating day: a probe (`findDatedJourney`) for whether it is remembered. */
function createRememberedStopEvent(
  index: number,
  finalCallTime: string,
): FeedStopEvent & { calls: FeedCall[] } {
  return {
    stopPointId: "de:08212:1001",
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

function createBoardSource(boardsByProviderStopId: Record<string, FeedStopEvent[]>) {
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      stopEvents: boardsByProviderStopId[providerStopId] ?? [],
    }),
    fetchTripInfo: async (): Promise<FeedTripInfo> => {
      throw new Error("no trip should be requested");
    },
  } as unknown as Feed;
  return new TriasTransitSource(client);
}

/**
 * Readings answered from memory keep their read time, so a retained ride never claims an old
 * reading is fresh.
 */
test("a reading answered from memory is dated when it was taken, not when it was asked for", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-26T05:29:45.000Z") });
  const rawJourney = readJourney();
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T05:29:45.000Z",
      stopEvents: [
        {
          stopPointId: "de:08212:1001",
          stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
          journeyRef: "de:kvv:00S04_:.trip",
          lineId: "S4",
          ptMode: "lightRail",
          destinationText: "Karlsruhe Albtalbahnhof",
          minutesUntilDeparture: 1,
          bay: "",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          operatingDayRef,
        },
      ],
    }),
    fetchTripInfo: async (): Promise<FeedTripInfo> => rawJourney,
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
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
    "de:08212:1001": filling,
    "de:08212:1002": [createRememberedStopEvent(9_000, stillRunning)],
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
    "de:08212:1001": Array.from({ length: DATED_JOURNEY_READING_STORE_CAPACITY }, (_, index) =>
      createRememberedStopEvent(index, stillRunning),
    ),
    "de:08212:1002": [createRememberedStopEvent(9_000, stillRunning)],
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
  const rawJourney: FeedTripInfo = {
    serverTime: "2026-08-26T05:30:45.000Z",
    calls: [
      {
        stopName: "Europaplatz (U)",
        placeName: "Karlsruhe",
        bayText: "Gleis 2(U)",
        providerId: "de:08212:1004",
        isThisCall: true,
        latitude: 49.010045,
        longitude: 8.394235,
        timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
      },
      {
        stopName: "Mühlburger Tor",
        placeName: "Karlsruhe",
        providerId: "de:08212:39",
        latitude: 49.0116,
        longitude: 8.3868,
        timetabledArrivalTime: "2026-08-26T05:32:00.000Z",
        timetabledDepartureTime: "2026-08-26T05:32:00.000Z",
      },
    ],
  };
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Europaplatz",
      serverTime: "2026-08-26T05:29:45.000Z",
      stopEvents: [
        {
          stopPointId: "de:08212:1004",
          stopPointName: "Europaplatz (U)",
          journeyRef: "de:kvv:00S01_:.trip",
          lineId: "S1",
          ptMode: "lightRail",
          destinationText: "Hochstetten",
          minutesUntilDeparture: 1,
          bay: "2(U)",
          status: "realtime",
          timetabledDepartureTime: "2026-08-26T05:30:00.000Z",
          operatingDayRef,
        },
      ],
    }),
    fetchTripInfo: async (): Promise<FeedTripInfo> => rawJourney,
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

  const board = await source.getStopEventBoard("europaplatz");
  const journey = await source.getDatedJourney(board.stopEvents[0].id);

  assert.equal(journey?.calls?.[0].localStopId, "europaplatz");
  assert.deepEqual(
    getCallsAfterStop(journey!, "europaplatz").map((call) => call.localStopId),
    ["muehlburger-tor"],
  );
});

test("a line's stops are read as rows, and each trip's calls are fetched once for all of them", async () => {
  // A run listed at every stop it will call at is read once, and every board's row completed from
  // it.
  const datedJourneyRequests: DatedJourneyRef[] = [];
  const boardRequests: { stopId: string; lineIds?: readonly string[] }[] = [];
  const runningJourney = (stopPointId: string, minute: number): FeedStopEvent => ({
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
    operatingDayRef,
  });
  const client = {
    fetchStopEventBoard: async (
      stopPointId: string,
      options: { lineIds?: readonly string[] } = {},
    ): Promise<FeedStopEventBoard> => {
      boardRequests.push({ stopId: stopPointId, lineIds: options.lineIds });
      return {
        stopPointId,
        stopName: stopPointId,
        serverTime: "2026-08-26T07:29:45",
        // One run, seen from three stops.
        stopEvents: [runningJourney(stopPointId, 2)],
      };
    },
    fetchTripInfo: async (
      requested: DatedJourneyRef,
      rowCall?: RowCallRef,
    ): Promise<FeedTripInfo> => {
      datedJourneyRequests.push(requested);
      return readJourney(rowCall?.stopPointId);
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

  const boards = await source.getLineStopEventBoards(["karlstor", "muehlburger-tor", "entenfang"], {
    lineRefs: ["kvv:22304:E:H:s26"],
  });

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
  const rawJourney = readJourney();
  let datedJourneyRequests = 0;
  let boardRequests = 0;
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => {
      boardRequests += 1;
      return {
        stopPointId,
        stopName: stopPointId,
        serverTime: "2026-08-26T07:29:45",
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
            operatingDayRef,
          },
        ],
      };
    },
    fetchTripInfo: async (): Promise<FeedTripInfo> => {
      datedJourneyRequests += 1;
      return rawJourney;
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
  const lineRefs = ["kvv:22304:E:H:s26"];

  await source.getLineStopEventBoards(["karlstor"], {
    lineRefs,
    maxAgeMs: 90_000,
    datedJourneyMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(datedJourneyRequests, 1);

  // A minute on, the boards are within tolerance; the runs are not.
  t.mock.timers.tick(60_000);
  await source.getLineStopEventBoards(["karlstor"], {
    lineRefs,
    maxAgeMs: 90_000,
    datedJourneyMaxAgeMs: 60_000,
  });
  assert.equal(boardRequests, 1);
  assert.equal(datedJourneyRequests, 2);

  // Unnamed, the runs' tolerance follows the boards'.
  t.mock.timers.tick(60_000);
  await source.getLineStopEventBoards(["karlstor"], { lineRefs, maxAgeMs: 90_000 });
  assert.equal(boardRequests, 2);
  assert.equal(datedJourneyRequests, 2);
});

test("a trip whose sequence cannot be read still keeps the row it was found on", async () => {
  // A failed read keeps the row; the next round asks again.
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
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
          operatingDayRef,
        } as FeedStopEvent,
      ],
    }),
    fetchTripInfo: async (): Promise<FeedTripInfo> => {
      throw new Error("Fahrt nicht lesbar");
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

  const boards = await source.getLineStopEventBoards(["karlstor"], {
    lineRefs: ["kvv:22304:E:H:s26"],
  });

  assert.equal(boards[0].stopEvents.length, 1);
  assert.equal(boards[0].stopEvents[0].calls, undefined);
});

test("a failed run refresh retains its prediction and a scheduled recovery clears the failure", async (t) => {
  const start = Date.parse("2026-08-26T05:29:45Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const client = {} as Feed;
  client.fetchStopEventBoard = async (stopPointId) => ({
    stopPointId,
    stopName: "Durlacher Tor",
    serverTime: "2026-08-26T07:29:45",
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
        operatingDayRef,
      },
    ],
  });
  const predicted: FeedTripInfo = {
    serverTime: journey.serverTime,
    calls: readJourney().calls.map((call) => ({ ...call, delayMinutes: 2 })),
  };
  client.fetchTripInfo = async () => predicted;
  const source = new TriasTransitSource(client);
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
  client.fetchTripInfo = async () => ({ ...predicted, calls: readJourney().calls });
  const recovered = await source.getDatedJourney(id, 0);
  assert.equal(recovered?.readAt?.sequenceRefreshFailedAt, undefined);
  assert.equal(recovered?.readAt?.sequenceReadAt, start + 60_000);
  assert.ok(recovered?.calls?.every((call) => call.delayMinutes === undefined));
});

test("a line's reading asks for the calls of the runs out on it, not of tomorrow's departures", async () => {
  // A run whose nearest call is hours away has not set out; its sequence is not read.
  const datedJourneyRequests: DatedJourneyRef[] = [];
  const datedJourney = (journeyRef: string, minutesUntilDeparture: number): FeedStopEvent =>
    ({
      stopPointId: "de:08212:1001",
      stopPointName: "stop",
      journeyRef,
      lineId: "S4",
      lineRef: "kvv:22304:E:H:s26",
      ptMode: "tram",
      destinationText: "Hochstetten",
      minutesUntilDeparture,
      status: "realtime",
      timetabledDepartureTime: "2026-08-26T07:30:00.000Z",
      operatingDayRef,
    }) as FeedStopEvent;
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      stopEvents: [
        datedJourney("de:kvv:00S04_:.trip", 4),
        datedJourney("de:kvv:00S04_:.tomorrow", 220),
      ],
    }),
    fetchTripInfo: async (
      requested: DatedJourneyRef,
      rowCall?: RowCallRef,
    ): Promise<FeedTripInfo> => {
      datedJourneyRequests.push(requested);
      return readJourney(rowCall?.stopPointId);
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

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
  const datedJourneyRequests: DatedJourneyRef[] = [];
  const row = (stopPointId: string, minutesUntilDeparture: number): FeedStopEvent =>
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
      operatingDayRef,
    }) as FeedStopEvent;
  let read = 0;
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId,
      stopName: stopPointId,
      serverTime: "2026-08-26T07:29:45",
      // Near at the next stop, an hour off at the far end.
      stopEvents: [row(stopPointId, read++ === 0 ? 3 : 62)],
    }),
    fetchTripInfo: async (
      requested: DatedJourneyRef,
      rowCall?: RowCallRef,
    ): Promise<FeedTripInfo> => {
      datedJourneyRequests.push(requested);
      return readJourney(rowCall?.stopPointId);
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

  const boards = await source.getLineStopEventBoards(["europaplatz", "entenfang"], {
    lineRefs: ["kvv:22304:E:H:s26"],
  });

  assert.equal(datedJourneyRequests.length, 1);
  assert.deepEqual(
    boards.map((board) => Boolean(board.stopEvents[0].calls?.length)),
    [true, true],
  );
});

test("line boards keep each journey's own record", async () => {
  const requestedCodes: string[] = [];
  const datedJourney = (journeyCode: string, timetabledDepartureTime: string): FeedStopEvent => ({
    stopPointId: "de:08212:1001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: `${S4_LINE_REF}:${journeyCode}`,
    operatingDayRef,
    lineId: "S4",
    lineRef: S4_LINE_REF,
    ptMode: "tram",
    destinationText: `Ziel ${journeyCode}`,
    minutesUntilDeparture: 2,
    bay: "1",
    status: "realtime",
    timetabledDepartureTime,
  });
  const client = {
    // The tunnel's stop point; the street's has nothing due.
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-08-26T07:29:45",
      stopEvents:
        stopPointId === "de:08212:1001"
          ? [
              datedJourney("first", "2026-08-26T07:30:00.000Z"),
              datedJourney("second", "2026-08-26T07:40:00.000Z"),
            ]
          : [],
    }),
    fetchTripInfo: async (requested: DatedJourneyRef): Promise<FeedTripInfo> => {
      const journeyCode = requested.journeyRef.split(":").at(-1)!;
      requestedCodes.push(journeyCode);
      const minute = journeyCode === "first" ? "30" : "40";
      return {
        serverTime: "2026-08-26T07:29:45",
        calls: [
          {
            stopName: "Durlacher Tor/KIT-Campus Süd (U)",
            providerId: "de:08212:1001",
            timetabledDepartureTime: `2026-08-26T07:${minute}:00.000Z`,
            delayMinutes: journeyCode === "first" ? 1 : 2,
          },
        ],
      };
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

  const [board] = await source.getLineStopEventBoards(["durlacher-tor"], {
    lineRefs: [S4_LINE_REF],
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
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => {
      // Counted at the tunnel's stop point, where the row is due.
      const isTunnel = providerStopId === "de:08212:1001";
      if (isTunnel) boardFetches += 1;
      return {
        stopPointId: providerStopId,
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        serverTime: "2026-08-26T05:29:45.000Z",
        stopEvents: isTunnel ? [createRememberedStopEvent(0, "2026-08-26T05:35:00.000Z")] : [],
      };
    },
    fetchTripInfo: async (): Promise<FeedTripInfo> => {
      throw new Error("no trip should be requested");
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);

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
    fetchStopEventBoard: async (providerStopId: string): Promise<FeedStopEventBoard> => {
      if (isFeedDown) throw new Error("offline");
      return {
        stopPointId: providerStopId,
        stopName: "Durlacher Tor/KIT-Campus Süd (U)",
        serverTime: "2026-08-26T05:29:45.000Z",
        stopEvents: [createRememberedStopEvent(0, "2026-08-26T05:35:00.000Z")],
      };
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
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
