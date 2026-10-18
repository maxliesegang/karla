import assert from "node:assert/strict";
import test from "node:test";
import {
  KvvTriasError,
  parseTriasLocations,
  parseTriasStopEvents,
  parseTriasTrip,
  toProviderStopId,
} from "../src/data/kvv-trias-parsers.ts";
import type { KvvTripLocator } from "../src/data/kvv-feed.ts";
import {
  triasReply,
  triasStopEvent,
  triasStopEvents,
  triasTripInfo,
  type TriasCall,
} from "./support/trias.ts";

const RESPONDED_AT = "2026-10-17T21:01:46Z";

test("malformed XML never becomes a successful empty board", () => {
  const valid = triasStopEvents(RESPONDED_AT, []);
  for (const xml of [
    valid.slice(0, -20),
    valid.replace("</trias:StopEventResponse>", "</trias:TripInfoResponse>"),
    `${valid}<extra/>`,
    valid.replace('version="1.2"', "version=1.2"),
    valid.replace("<trias:StopEventResponse>", "<trias:StopEventResponse>&unknown;"),
  ]) {
    assert.throws(() => parseTriasStopEvents(xml, "7001003"), KvvTriasError);
  }
});

test("each endpoint requires its own payload and a valid feed clock", () => {
  const locator: KvvTripLocator = {
    line: "kvv:22305:E:R:s26",
    tripCode: "1762",
    stopPointId: "7001003",
    date: "20261017",
    time: "2301",
  };
  for (const time of ["", "not a time", "2026-10-17T21:01:46", "2026-02-30T21:01:46Z"]) {
    assert.throws(() => parseTriasStopEvents(triasStopEvents(time, []), "7001003"), KvvTriasError);
    assert.throws(
      () => parseTriasLocations(triasReply(time, "<trias:LocationInformationResponse/>")),
      KvvTriasError,
    );
    assert.throws(
      () => parseTriasTrip(triasTripInfo(time, { previous: [MARKTPLATZ] }), locator),
      KvvTriasError,
    );
  }
  for (const payload of ["", "<trias:TripInfoResponse/>"]) {
    assert.throws(
      () => parseTriasStopEvents(triasReply(RESPONDED_AT, payload), "7001003"),
      KvvTriasError,
    );
    assert.throws(() => parseTriasLocations(triasReply(RESPONDED_AT, payload)), KvvTriasError);
  }
  assert.deepEqual(
    parseTriasLocations(triasReply(RESPONDED_AT, "<trias:LocationInformationResponse/>")),
    [],
  );
});

const MARKTPLATZ: TriasCall = {
  ref: "de:08212:1003:92:2",
  name: "KA Marktplatz (Kaiserstraße U)",
  bay: "Gleis 2(U)",
  departure: { scheduled: "2026-10-17T21:01:00Z", estimated: "2026-10-17T21:05:12Z" },
};
const KRONENPLATZ: TriasCall = {
  ref: "de:08212:1002:92:2",
  name: "Karlsruhe Kronenplatz (U)",
  bay: "Gleis 2(U)",
  arrival: { scheduled: "2026-10-17T21:02:00Z", estimated: "2026-10-17T21:06:12Z" },
  departure: { scheduled: "2026-10-17T21:02:30Z", estimated: "2026-10-17T21:06:12Z" },
};
const PFORZHEIM: TriasCall = {
  ref: "de:08231:50:2:3",
  name: "Pforzheim Hauptbahnhof",
  arrival: { scheduled: "2026-10-17T21:50:00Z" },
};

test("Karlsruhe's stop refs read as EFA ids, others as their stop's DHID", () => {
  assert.equal(toProviderStopId("de:08212:1003:92:2"), "7001003");
  assert.equal(toProviderStopId("de:08212:37"), "7000037");
  assert.equal(toProviderStopId("de:08237:1050:1:1"), "de:08237:1050");
});

test("a stop event reads as the row EFA would publish, with the prediction to the second", () => {
  const board = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, journeyNumber: "85099" }),
    ]),
    "7001003",
  );
  const [row] = board.departures;

  assert.equal(board.serverTime, RESPONDED_AT);
  assert.deepEqual(
    {
      stopPointId: row.stopPointId,
      stopPointName: row.stopPointName,
      lineId: row.lineId,
      transportMode: row.transportMode,
      routeDirectionId: row.routeDirectionId,
      tripId: row.tripId,
      trainNumber: row.trainNumber,
      platformCode: row.platformCode,
      platformKind: row.platformKind,
      status: row.status,
      vehicleAccess: row.vehicleAccess,
      scheduledDepartureTime: row.scheduledDepartureTime,
      predictedDepartureTime: row.predictedDepartureTime,
      delayMinutes: row.delayMinutes,
      tripCalls: row.tripCalls,
    },
    {
      stopPointId: "7001003",
      stopPointName: "Marktplatz (Kaiserstraße U)",
      lineId: "S5",
      transportMode: "lightRail",
      routeDirectionId: "kvv:22305:E:R:s26",
      tripId: "kvv:22305:E:R:s26:1762",
      trainNumber: "85099",
      platformCode: "2(U)",
      platformKind: "track",
      status: "realtime",
      vehicleAccess: "stepFree",
      scheduledDepartureTime: "2026-10-17T21:01:00.000Z",
      predictedDepartureTime: "2026-10-17T21:05:12.000Z",
      // 4 min 12 s rounds to four.
      delayMinutes: 4,
      tripCalls: undefined,
    },
  );
});

test("the countdown is the clock minutes between the feed's reading and the expected departure", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents("2026-10-17T21:01:59Z", [triasStopEvent({ current: MARKTPLATZ })]),
    "7001003",
  ).departures;
  // 21:01 to 21:05, though only 3 min 13 s remain.
  assert.equal(row.minutesUntilDeparture, 4);
});

test("the locator names the run as EFA does, and carries TRIAS's operating day", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: { ...MARKTPLATZ, departure: { scheduled: "2026-10-17T22:10:00Z" } },
        service: { operatingDay: "2026-10-17" },
      }),
    ]),
    "7001003",
  ).departures;
  assert.deepEqual(row.tripLocator, {
    line: "kvv:22305:E:R:s26",
    tripCode: "1762",
    stopPointId: "7001003",
    // 00:10 the next calendar day in Karlsruhe, still the 17th's operating day.
    date: "20261018",
    time: "0010",
    operatingDay: "2026-10-17",
  });
});

test("calls keep predictions to the second and their whole-minute delays", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, onward: [KRONENPLATZ, PFORZHEIM] }),
    ]),
    "7001003",
  ).departures;
  const [here, next, end] = row.tripCalls ?? [];

  assert.equal(here.isCurrentStop, true);
  assert.deepEqual(
    {
      stopName: next.stopName,
      placeName: next.placeName,
      providerId: next.providerId,
      platformLabel: next.platformLabel,
      platformCode: next.platformCode,
      predictedArrivalTime: next.predictedArrivalTime,
      predictedDepartureTime: next.predictedDepartureTime,
      delayMinutes: next.delayMinutes,
      arrivalDelayMinutes: next.arrivalDelayMinutes,
    },
    {
      stopName: "Kronenplatz (U)",
      placeName: "Karlsruhe",
      providerId: "7001002",
      platformLabel: "Gleis 2(U)",
      platformCode: "2(U)",
      predictedArrivalTime: "2026-10-17T21:06:12.000Z",
      predictedDepartureTime: "2026-10-17T21:06:12.000Z",
      // The departure 3 min 42 s late, the arrival 4 min 12 s.
      delayMinutes: 4,
      arrivalDelayMinutes: undefined,
    },
  );
  assert.equal(end.providerId, "de:08231:50");
  assert.equal(end.stopName, "Pforzheim Hauptbahnhof");
  assert.equal(end.delayMinutes, undefined);
});

test("a departure without a prediction is scheduled, not on time", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: { ...MARKTPLATZ, departure: { scheduled: "2026-10-17T21:30:00Z" } },
      }),
    ]),
    "7001003",
  ).departures;
  assert.equal(row.status, "scheduled");
  assert.equal(row.delayMinutes, undefined);
  assert.equal(row.predictedDepartureTime, undefined);
});

test("a cancelled trip says so", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, service: { cancelled: true } }),
    ]),
    "7001003",
  ).departures;
  assert.equal(row.status, "cancelled");
});

test("only the local network's lines are read", () => {
  const board = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, service: { journeyRef: "ddb:90T01::H:j26:194" } }),
      triasStopEvent({
        current: MARKTPLATZ,
        service: {
          ptMode: "bus",
          submode: "<trias:BusSubmode>demandAndResponseBus</trias:BusSubmode>",
        },
      }),
      triasStopEvent({
        current: MARKTPLATZ,
        service: {
          journeyRef: "kvv:21002:E:H:s26:5",
          lineName: "2",
          ptMode: "tram",
          submode: "<trias:TramSubmode>cityTram</trias:TramSubmode>",
        },
      }),
    ]),
    "7001003",
  );
  assert.deepEqual(
    board.departures.map(({ lineId, transportMode }) => [lineId, transportMode]),
    [["2", "tram"]],
  );
});

test("an arrival board times its rows by the arrival", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: { ...KRONENPLATZ, departure: undefined },
        previous: [MARKTPLATZ],
      }),
    ]),
    "7001002",
    "arrival",
  ).departures;
  assert.equal(row.scheduledDepartureTime, "2026-10-17T21:02:00.000Z");
  assert.equal(row.predictedDepartureTime, "2026-10-17T21:06:12.000Z");
});

test("a stop with nothing due is an empty board; any other error is a failure", () => {
  const empty = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [], "STOPEVENT_LOCATIONUNSERVED"),
    "7001003",
  );
  assert.deepEqual(empty.departures, []);
  assert.deepEqual(
    parseTriasStopEvents(triasStopEvents(RESPONDED_AT, [], "STOPEVENT_NOEVENTFOUND"), "7001003")
      .departures,
    [],
  );
  assert.throws(
    () =>
      parseTriasStopEvents(
        triasStopEvents(RESPONDED_AT, [], "STOPEVENT_DATEOUTOFRANGE"),
        "7001003",
      ),
    KvvTriasError,
  );
  assert.throws(() => parseTriasStopEvents("<html>502</html>", "7001003"), KvvTriasError);
});

const LOCATOR: KvvTripLocator = {
  line: "kvv:22305:E:R:s26",
  tripCode: "1762",
  stopPointId: "7001002",
  date: "20261017",
  time: "2302",
  operatingDay: "2026-10-17",
};

test("a trip marks the call its row was read at", () => {
  const trip = parseTriasTrip(
    triasTripInfo(RESPONDED_AT, { previous: [MARKTPLATZ, KRONENPLATZ], onward: [PFORZHEIM] }),
    LOCATOR,
  );
  assert.deepEqual(
    trip.tripCalls.map(({ providerId, isCurrentStop }) => [providerId, isCurrentStop]),
    [
      ["7001003", undefined],
      ["7001002", true],
      ["de:08231:50", undefined],
    ],
  );
  assert.equal(trip.serverTime, RESPONDED_AT);
  assert.equal(trip.status, undefined);
});

test("a trip answered for another journey, or with an error code, was not found", () => {
  assert.throws(
    () =>
      parseTriasTrip(
        triasTripInfo(RESPONDED_AT, {
          previous: [MARKTPLATZ],
          service: { journeyRef: "kvv:22305:E:R:s26:9" },
        }),
        LOCATOR,
      ),
    /nicht gefunden/,
  );
  assert.throws(
    () =>
      parseTriasTrip(
        triasReply(
          RESPONDED_AT,
          "<trias:TripInfoResponse><trias:ErrorMessage><trias:Code>ERROR_INVALID_JOURNEY_REF</trias:Code></trias:ErrorMessage></trias:TripInfoResponse>",
        ),
        LOCATOR,
      ),
    /nicht gefunden/,
  );
});

test("a stop search reads ids, names, places and positions", () => {
  const results = parseTriasLocations(
    triasReply(
      RESPONDED_AT,
      `<trias:LocationInformationResponse><trias:LocationResult><trias:Location><trias:StopPoint><trias:StopPointRef>de:08212:1004</trias:StopPointRef><trias:StopPointName><trias:Text>Europaplatz</trias:Text></trias:StopPointName></trias:StopPoint><trias:LocationName><trias:Text>Karlsruhe</trias:Text></trias:LocationName><trias:GeoPosition><trias:Longitude>8.39424</trias:Longitude><trias:Latitude>49.01005</trias:Latitude></trias:GeoPosition></trias:Location></trias:LocationResult></trias:LocationInformationResponse>`,
    ),
  );
  assert.deepEqual(results, [
    {
      providerId: "7001004",
      name: "Europaplatz",
      placeName: "Karlsruhe",
      latitude: 49.01005,
      longitude: 8.39424,
    },
  ]);
});

test("an empty-stop notice cannot hide another provider error", () => {
  const empty = triasStopEvents(RESPONDED_AT, [], "STOPEVENT_NOEVENTFOUND");
  const mixed = empty.replace(
    "</trias:StopEventResponse>",
    "<trias:ErrorMessage><trias:Code>ERROR</trias:Code><trias:Text><trias:Text>INVALID_REQUEST</trias:Text></trias:Text></trias:ErrorMessage></trias:StopEventResponse>",
  );
  assert.throws(() => parseTriasStopEvents(mixed, "7001003"), KvvTriasError);
});
