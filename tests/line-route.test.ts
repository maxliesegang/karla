import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import {
  KvvEfaError,
  parseLineRouteResponse,
  type KvvDeparture,
  type KvvDepartureBoard,
  type KvvTripCall,
  type KvvTripLocator,
} from "../src/data/kvv-efa-parsers.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
import type { Departure } from "../src/data/transit-types.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import {
  EMPTY_LINE_OBSERVATION,
  extendLineObservationRoute,
  extendLineObservationRoutes,
  getLineRouteRequests,
  MAX_LINE_OBSERVATION_STOPS,
  sampleLineObservationStopIds,
} from "../src/lib/line-observation.ts";

const locator: KvvTripLocator = {
  tripCode: "35",
  line: "kvv:21003:E:R:s26",
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
  assert.ok(route.every((call) => !call.isCurrentStop));
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

function lineRow(overrides: Partial<KvvDeparture> = {}): KvvDeparture {
  return {
    stopPointId: "7001001",
    stopPointName: "Durlacher Tor/KIT-Campus Süd (U)",
    tripId: "de:kvv:00003_:.trip",
    lineId: "3",
    routeDirectionId: "kvv:21003:E:R:s26",
    transportMode: "tram",
    destination: "Rintheim",
    minutesUntilDeparture: 4,
    platformCode: "1(U)",
    status: "realtime",
    scheduledDepartureTime: "2026-09-04T07:00:00.000Z",
    tripLocator: locator,
    ...overrides,
  };
}

test("TransitSource reads one route per line-direction and keeps it for the session", async () => {
  const rows = [lineRow(), lineRow({ tripId: "de:kvv:00003_:.later", tripLocator: locator })];
  const requests: KvvTripLocator[] = [];
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-09-04T06:59:45.000Z",
      servingLines: [],
      departures: rows,
    }),
    fetchLineRoute: async (requested: KvvTripLocator): Promise<KvvTripCall[]> => {
      requests.push(requested);
      return parseLineRouteResponse(routePayload, requested);
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("durlacher-tor");

  const route = await source.getLineRoute(board.departures[0].id);
  // The second row of the same direction is a second way of asking the same question.
  const again = await source.getLineRoute(board.departures[1].id);

  assert.deepEqual(requests, [locator]);
  // Provider ids, resolved to the local stops the app requests boards with.
  assert.deepEqual(route, ["durlacher-tor", "kronenplatz"]);
  assert.deepEqual(again, route);
});

test("a route that cannot be read leaves the reading where it stood", async () => {
  const client = {
    fetchDepartureBoard: async (providerStopId: string): Promise<KvvDepartureBoard> => ({
      stopPointId: providerStopId,
      stopName: "Durlacher Tor/KIT-Campus Süd (U)",
      serverTime: "2026-09-04T06:59:45.000Z",
      servingLines: [],
      departures: [lineRow()],
    }),
    fetchLineRoute: async (): Promise<KvvTripCall[]> => {
      throw new KvvEfaError("Linie kvv:21003:E:R:s26: nicht gefunden");
    },
  } as unknown as KvvEfaClient;
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("durlacher-tor");

  assert.equal(await source.getLineRoute(board.departures[0].id), undefined);
});

function selectionDeparture(routeDirectionId: string, id: string, lineId = "3"): Departure {
  return {
    id,
    lineId,
    transportMode: "tram",
    destination: "Rintheim",
    minutesUntilDeparture: 4,
    platformCode: "1",
    status: "realtime",
    scheduledDepartureTime: "2026-09-04T07:00:00.000Z",
    routeDirectionId,
  } as Departure;
}

test("one route is asked for per direction, however many rows of it a board carries", () => {
  const selection = createLineSelection("3", []);
  const boards = [
    {
      departures: [
        selectionDeparture("kvv:21003:E:R:s26", "erste"),
        selectionDeparture("kvv:21003:E:R:s26", "zweite"),
        selectionDeparture("kvv:21003:E:H:s26", "gegenrichtung"),
        selectionDeparture("kvv:21004:E:H:s26", "andere-linie", "4"),
      ],
    },
  ];

  const requests = getLineRouteRequests(selection, boards);

  assert.deepEqual(requests, [
    { lineId: "3", directionId: "kvv:21003:E:R:s26", departureId: "erste" },
    { lineId: "3", directionId: "kvv:21003:E:H:s26", departureId: "gegenrichtung" },
  ]);
});

test("the published route leads the order, and what was only ever observed keeps its place behind", () => {
  const observed = { stopIds: ["kronenplatz", "umleitung"], directionIds: ["kvv:21003:E:R:s26"] };

  const extended = extendLineObservationRoute(observed, ["waidweg", "kronenplatz", "rintheim"]);

  assert.deepEqual(extended.stopIds, ["waidweg", "kronenplatz", "rintheim", "umleitung"]);
  assert.deepEqual(extended.directionIds, observed.directionIds);
});

test("a route already wholly known changes nothing, so the crawl settles instead of asking again", () => {
  const known = { stopIds: ["waidweg", "kronenplatz"], directionIds: [] };

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
