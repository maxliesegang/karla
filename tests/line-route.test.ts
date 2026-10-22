import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { KvvEfaError, parseLineRouteResponse } from "../src/data/kvv-efa-parsers.ts";
import {
  type KvvStopEvent,
  type KvvStopEventBoard,
  type KvvCall,
  type KvvJourneyLocator,
} from "../src/data/kvv-feed.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
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

const locator: KvvJourneyLocator = {
  journeyCode: "35",
  lineRef: "kvv:21003:E:R:s26",
  stopPointId: "7001001",
  date: "20260904",
  time: "0900",
};

/** The shape the route endpoint answers with, trimmed to the fields the parser reads. */
const routePayload = {
  parameters: [{ name: "serverTime", value: "2026-09-04T09:00:45" }],
  stopSeqCoords: {
    params: {
      mode: { number: "3", diva: { stateless: "kvv:21003:E:R:s26" } },
      stopSeq: [
        {
          nameWO: "Durlacher Tor/KIT-Campus Süd (U)",
          place: "Karlsruhe",
          ref: { id: "7001001", coords: "8.416531,49.009020", depDateTime: "20260904 09:00" },
        },
        {
          nameWO: "Kronenplatz (U)",
          place: "Karlsruhe",
          ref: { id: "7001002", coords: "8.409794,49.009362", depDateTime: "20260904 09:02" },
        },
      ],
    },
    coords: { path: "8.416531,49.009020 8.409794,49.009362" },
  },
};

test("a line route is read as the calling points of the whole line, not of one run", () => {
  const route = parseLineRouteResponse(routePayload, locator);

  assert.deepEqual(
    route.map(({ providerId }) => providerId),
    ["7001001", "7001002"],
  );
  // Nothing here is the run's own: no call is marked as the stop the request was addressed at.
  assert.ok(route.every((call) => !call.isThisCall));
});

test("a route answered for another line is not this line's route", () => {
  const otherLine = {
    ...routePayload,
    stopSeqCoords: {
      ...routePayload.stopSeqCoords,
      params: {
        ...routePayload.stopSeqCoords.params,
        mode: { number: "4", diva: { stateless: "kvv:21004:E:R:s26" } },
      },
    },
  };

  assert.throws(
    () => parseLineRouteResponse(otherLine, locator),
    (error) => error instanceof KvvEfaError && error.message.includes("nicht gefunden"),
  );
});

test("an empty sequence is a failed lookup, which the endpoint still answers with HTTP 200", () => {
  const empty = {
    ...routePayload,
    stopSeqCoords: { params: { ...routePayload.stopSeqCoords.params, stopSeq: [] } },
  };

  assert.throws(
    () => parseLineRouteResponse(empty, locator),
    (error) => error instanceof KvvEfaError && error.message.includes("keine Halte"),
  );
});

test("the client calls KVV's route endpoint with the trip tuple, under its own stop parameter", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    lineRouteEndpoint: "https://example.test/XML_STOPSEQCOORD_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify(routePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchLineRoute(locator);

  assert.equal(requestedUrl?.pathname, "/XML_STOPSEQCOORD_REQUEST");
  assert.deepEqual(Object.fromEntries(requestedUrl?.searchParams ?? []), {
    outputFormat: "json",
    line: "kvv:21003:E:R:s26",
    tripCode: "35",
    stop: "7001001",
    date: "20260904",
    time: "0900",
    coordOutputFormat: "WGS84[DD.ddddd]",
  });
});

function lineRow(overrides: Partial<KvvStopEvent> = {}): KvvStopEvent {
  return {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    journeyRef: "de:kvv:00003_:.trip",
    lineId: "3",
    lineRef: "kvv:21003:E:R:s26",
    ptMode: "tram",
    destinationText: "Rintheim",
    minutesUntilDeparture: 4,
    bay: "1(U)",
    status: "realtime",
    timetabledDepartureTime: "2026-09-04T07:00:00.000Z",
    journeyLocator: locator,
    ...overrides,
  };
}

test("TransitSource reads one route per line-direction and keeps it for the session", async () => {
  const rows = [
    lineRow(),
    lineRow({ journeyRef: "de:kvv:00003_:.later", journeyLocator: locator }),
  ];
  const requests: KvvJourneyLocator[] = [];
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-09-04T06:59:45.000Z",
      servingLines: [],
      stopEvents: rows,
    }),
    fetchLineRoute: async (requested: KvvJourneyLocator): Promise<KvvCall[]> => {
      requests.push(requested);
      return parseLineRouteResponse(routePayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getStopEventBoard("durlacher-tor");

  const route = await source.getLineRoute(board.stopEvents[0].id);
  // The second row of the same direction is a second way of asking the same question.
  const again = await source.getLineRoute(board.stopEvents[1].id);

  assert.deepEqual(requests, [locator]);
  // Provider ids, resolved to the local stops the app requests boards with.
  assert.deepEqual(route, ["durlacher-tor", "kronenplatz"]);
  assert.deepEqual(again, route);
});

test("a route that cannot be read leaves the reading where it stood", async () => {
  const client = {
    fetchStopEventBoard: async (providerStopId: string): Promise<KvvStopEventBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-09-04T06:59:45.000Z",
      servingLines: [],
      stopEvents: [lineRow()],
    }),
    fetchLineRoute: async (): Promise<KvvCall[]> => {
      throw new KvvEfaError("Linie kvv:21003:E:R:s26: nicht gefunden");
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
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
