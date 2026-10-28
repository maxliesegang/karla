import assert from "node:assert/strict";
import test from "node:test";
import {
  type Feed,
  type FeedStopEvent,
  type FeedStopEventBoard,
  type FeedCall,
  type DatedJourneyRef,
} from "../src/data/feed.ts";
import { TriasTransitSource } from "../src/data/transit-source.ts";
import type { StopEvent } from "../src/data/transit-types.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import {
  EMPTY_LINE_OBSERVATION,
  extendLineObservationRoute,
  extendLineObservationRoutes,
  getLineRouteRequests,
  MAX_LINE_OBSERVATION_STOPS,
  sampleLineObservationStopIds,
} from "../src/lib/line-observation.ts";
import { createStopEvent } from "./support/fixtures.ts";

const operatingDayRef = "2026-09-04";

/** A line route as the feed answers it: the journey's calls, none marked as the board's own. */
const route: FeedCall[] = [
  {
    stopName: "Durlacher Tor/KIT-Campus Süd (U)",
    stopPointId: "de:08212:1001",
    timetabledDepartureTime: "2026-09-04T07:00:00.000Z",
  },
  {
    stopName: "Kronenplatz (U)",
    stopPointId: "de:08212:1002",
    timetabledDepartureTime: "2026-09-04T07:02:00.000Z",
  },
];

function lineRow(overrides: Partial<FeedStopEvent> = {}): FeedStopEvent {
  return {
    stopPointId: "de:08212:1001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: "de:kvv:00003_:.journey",
    lineId: "3",
    lineRef: "kvv:21003:E:R:s26",
    ptMode: "tram",
    destinationText: "Rintheim",
    minutesUntilDeparture: 4,
    bay: "1(U)",
    status: "realtime",
    timetabledDepartureTime: "2026-09-04T07:00:00.000Z",
    operatingDayRef,
    ...overrides,
  };
}

test("TransitSource reads one route per line-direction and keeps it for the session", async () => {
  const rows = [lineRow(), lineRow({ journeyRef: "de:kvv:00003_:.later" })];
  const requests: DatedJourneyRef[] = [];
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: stopPointId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-09-04T06:59:45.000Z",
      stopEvents: rows,
    }),
    fetchLineRoute: async (requested: DatedJourneyRef): Promise<FeedCall[]> => {
      requests.push(requested);
      return route;
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
  const board = await source.getStopEventBoard("durlacher-tor");

  const stopIds = await source.getLineRoute(board.stopEvents[0].id);
  // The second row of the same direction is a second way of asking the same question.
  const again = await source.getLineRoute(board.stopEvents[1].id);

  assert.deepEqual(requests, [{ journeyRef: "de:kvv:00003_:.journey", operatingDayRef }]);
  // Provider ids, resolved to the local stops the app requests boards with.
  assert.deepEqual(stopIds, ["durlacher-tor", "kronenplatz"]);
  assert.deepEqual(again, stopIds);
});

test("a route that cannot be read leaves the reading where it stood", async () => {
  const client = {
    fetchStopEventBoard: async (stopPointId: string): Promise<FeedStopEventBoard> => ({
      stopPointId: stopPointId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-09-04T06:59:45.000Z",
      stopEvents: [lineRow()],
    }),
    fetchLineRoute: async (): Promise<FeedCall[]> => {
      throw new Error("Linie kvv:21003:E:R:s26: nicht gefunden");
    },
  } as unknown as Feed;
  const source = new TriasTransitSource(client);
  const board = await source.getStopEventBoard("durlacher-tor");

  assert.equal(await source.getLineRoute(board.stopEvents[0].id), undefined);
});

function selectionStopEvent(lineRef: string, id: string, lineId = "3"): StopEvent {
  return createStopEvent({
    id,
    lineId,
    ptMode: "tram",
    destinationText: "Rintheim",
    minutesUntilDeparture: 4,
    bay: "1",
    status: "realtime",
    timetabledDepartureTime: "2026-09-04T07:00:00.000Z",
    lineRef,
  }) as StopEvent;
}

test("one route is asked for per direction, however many rows of it a board carries", () => {
  const selection = createLineSelection("3", []);
  const boards = [
    {
      stopEvents: [
        selectionStopEvent("kvv:21003:E:R:s26", "erste"),
        selectionStopEvent("kvv:21003:E:R:s26", "zweite"),
        selectionStopEvent("kvv:21003:E:H:s26", "gegenrichtung"),
        selectionStopEvent("kvv:21004:E:H:s26", "andere-linie", "4"),
      ],
    },
  ];

  const requests = getLineRouteRequests(selection, boards);

  assert.deepEqual(requests, [
    { lineId: "3", lineRef: "kvv:21003:E:R:s26", rowId: "erste" },
    { lineId: "3", lineRef: "kvv:21003:E:H:s26", rowId: "gegenrichtung" },
  ]);
});

test("the published route leads the order, and what was only ever observed keeps its place behind", () => {
  const observed = { stopIds: ["kronenplatz", "umleitung"], lineRefs: ["kvv:21003:E:R:s26"] };

  const extended = extendLineObservationRoute(observed, ["waidweg", "kronenplatz", "rintheim"]);

  assert.deepEqual(extended.stopIds, ["waidweg", "kronenplatz", "rintheim", "umleitung"]);
  assert.deepEqual(extended.lineRefs, observed.lineRefs);
});

test("a route already wholly known changes nothing, so the crawl settles instead of asking again", () => {
  const known = { stopIds: ["waidweg", "kronenplatz"], lineRefs: [] };

  assert.equal(extendLineObservationRoute(known, ["waidweg", "kronenplatz"]), known);
  assert.equal(extendLineObservationRoute(known, []), known);
});

test("each line of a bundle is given its own route", () => {
  const selection = createLineSelection("S1", ["S11"]);
  const routes = new Map([
    ["S1", ["hochstetten", "kronenplatz"]],
    ["S11", ["ittersbach", "kronenplatz"]],
  ]);

  const observations = extendLineObservationRoutes(
    new Map([["S1", EMPTY_LINE_OBSERVATION]]),
    selection,
    routes,
  );

  assert.deepEqual(observations.get("S1")?.stopIds, ["hochstetten", "kronenplatz"]);
  assert.deepEqual(observations.get("S11")?.stopIds, ["ittersbach", "kronenplatz"]);
});

test("a line longer than the filtered round's bound is sampled from end to end, not truncated", () => {
  const route = Array.from({ length: 70 }, (_, index) => `stop-${index}`);

  const read = sampleLineObservationStopIds(route, MAX_LINE_OBSERVATION_STOPS);

  assert.equal(read.length, MAX_LINE_OBSERVATION_STOPS);
  assert.equal(read[0], "stop-0");
  assert.equal(read[read.length - 1], "stop-69");
});

test("an ordinary line stays inside the bound and is read whole", () => {
  const route = Array.from({ length: 30 }, (_, index) => `stop-${index}`);

  assert.equal(sampleLineObservationStopIds(route, MAX_LINE_OBSERVATION_STOPS), route);
});
