import assert from "node:assert/strict";
import test from "node:test";
import {
  TriasError,
  parseTriasLocations,
  parseTriasSituations,
  parseTriasStopEvents,
  parseTriasTripInfo,
  toStopPointId,
} from "../src/data/trias-parsers.ts";
import type { DatedJourneyRef, RowCallRef } from "../src/data/feed.ts";
import {
  triasReply,
  triasSituation,
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
    assert.throws(() => parseTriasStopEvents(xml, "de:08212:1003"), TriasError);
  }
});

test("each endpoint requires its own payload and a valid feed clock", () => {
  const journey: DatedJourneyRef = {
    journeyRef: "kvv:22305:E:R:s26:1762",
    operatingDayRef: "2026-10-17",
  };
  for (const time of ["", "not a time", "2026-10-17T21:01:46", "2026-02-30T21:01:46Z"]) {
    assert.throws(
      () => parseTriasStopEvents(triasStopEvents(time, []), "de:08212:1003"),
      TriasError,
    );
    assert.throws(
      () => parseTriasLocations(triasReply(time, "<trias:LocationInformationResponse/>")),
      TriasError,
    );
    assert.throws(
      () => parseTriasTripInfo(triasTripInfo(time, { previous: [MARKTPLATZ] }), journey),
      TriasError,
    );
  }
  for (const payload of ["", "<trias:TripInfoResponse/>"]) {
    assert.throws(
      () => parseTriasStopEvents(triasReply(RESPONDED_AT, payload), "de:08212:1003"),
      TriasError,
    );
    assert.throws(() => parseTriasLocations(triasReply(RESPONDED_AT, payload)), TriasError);
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
  departure: { timetabled: "2026-10-17T21:01:00Z", estimated: "2026-10-17T21:05:12Z" },
};
const KRONENPLATZ: TriasCall = {
  ref: "de:08212:1002:92:2",
  name: "Karlsruhe Kronenplatz (U)",
  bay: "Gleis 2(U)",
  arrival: { timetabled: "2026-10-17T21:02:00Z", estimated: "2026-10-17T21:06:12Z" },
  departure: { timetabled: "2026-10-17T21:02:30Z", estimated: "2026-10-17T21:06:12Z" },
};
const PFORZHEIM: TriasCall = {
  ref: "de:08231:50:2:3",
  name: "Pforzheim Hauptbahnhof",
  arrival: { timetabled: "2026-10-17T21:50:00Z" },
};

test("a stop ref reads as its stop's DHID, whatever the level", () => {
  assert.equal(toStopPointId("de:08212:1003:92:2"), "de:08212:1003");
  assert.equal(toStopPointId("de:08212:37"), "de:08212:37");
  assert.equal(toStopPointId("de:08237:1050:1:1"), "de:08237:1050");
});

test("a stop event reads as a row, with the prediction to the second", () => {
  const board = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, journeyNumber: "85099" }),
    ]),
    "de:08212:1003",
  );
  const [row] = board.stopEvents;

  assert.equal(board.serverTime, RESPONDED_AT);
  assert.deepEqual(
    {
      stopPointId: row.stopPointId,
      stopPointName: row.stopPointName,
      lineId: row.lineId,
      ptMode: row.ptMode,
      lineRef: row.lineRef,
      journeyRef: row.journeyRef,
      publishedJourneyNumber: row.publishedJourneyNumber,
      bay: row.bay,
      bayKind: row.bayKind,
      status: row.status,
      vehicleAccess: row.vehicleAccess,
      timetabledDepartureTime: row.timetabledDepartureTime,
      estimatedDepartureTime: row.estimatedDepartureTime,
      delayMinutes: row.delayMinutes,
      calls: row.calls,
    },
    {
      stopPointId: "de:08212:1003",
      stopPointName: "Marktplatz (Kaiserstraße U)",
      lineId: "S5",
      ptMode: "lightRail",
      lineRef: "kvv:22305:E:R:s26",
      journeyRef: "kvv:22305:E:R:s26:1762",
      publishedJourneyNumber: "85099",
      bay: "2(U)",
      bayKind: "track",
      status: "realtime",
      vehicleAccess: "stepFree",
      timetabledDepartureTime: "2026-10-17T21:01:00.000Z",
      estimatedDepartureTime: "2026-10-17T21:05:12.000Z",
      // 4 min 12 s rounds to four.
      delayMinutes: 4,
      calls: undefined,
    },
  );
});

test("the countdown is the clock minutes between the feed's reading and the expected departure", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents("2026-10-17T21:01:59Z", [triasStopEvent({ current: MARKTPLATZ })]),
    "de:08212:1003",
  ).stopEvents;
  // 21:01 to 21:05, though only 3 min 13 s remain.
  assert.equal(row.minutesUntilDeparture, 4);
});

test("a row carries its line ref and dated journey, on the operating day", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: { ...MARKTPLATZ, departure: { timetabled: "2026-10-17T22:10:00Z" } },
        service: { operatingDay: "2026-10-17" },
      }),
    ]),
    "de:08212:1003",
  ).stopEvents;
  assert.equal(row.lineRef, "kvv:22305:E:R:s26");
  // 00:10 the next calendar day in Karlsruhe, still the 17th's operating day.
  assert.equal(row.operatingDayRef, "2026-10-17");
  assert.equal(row.datedJourneyId, "kvv:22305:E:R:s26:1762@2026-10-17");
});

test("calls keep predictions to the second and their whole-minute delays", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, onward: [KRONENPLATZ, PFORZHEIM] }),
    ]),
    "de:08212:1003",
  ).stopEvents;
  const [here, next, end] = row.calls ?? [];

  assert.equal(here.isThisCall, true);
  assert.deepEqual(
    {
      stopName: next.stopName,
      placeName: next.placeName,
      stopPointId: next.stopPointId,
      bayText: next.bayText,
      bay: next.bay,
      estimatedArrivalTime: next.estimatedArrivalTime,
      estimatedDepartureTime: next.estimatedDepartureTime,
      delayMinutes: next.delayMinutes,
      arrivalDelayMinutes: next.arrivalDelayMinutes,
    },
    {
      stopName: "Kronenplatz (U)",
      placeName: "Karlsruhe",
      stopPointId: "de:08212:1002",
      bayText: "Gleis 2(U)",
      bay: "2(U)",
      estimatedArrivalTime: "2026-10-17T21:06:12.000Z",
      estimatedDepartureTime: "2026-10-17T21:06:12.000Z",
      // The departure 3 min 42 s late, the arrival 4 min 12 s.
      delayMinutes: 4,
      arrivalDelayMinutes: undefined,
    },
  );
  assert.equal(end.stopPointId, "de:08231:50");
  assert.equal(end.stopName, "Pforzheim Hauptbahnhof");
  assert.equal(end.delayMinutes, undefined);
});

test("a departure without a prediction is scheduled, not on time", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: { ...MARKTPLATZ, departure: { timetabled: "2026-10-17T21:30:00Z" } },
      }),
    ]),
    "de:08212:1003",
  ).stopEvents;
  assert.equal(row.status, "scheduled");
  assert.equal(row.delayMinutes, undefined);
  assert.equal(row.estimatedDepartureTime, undefined);
});

test("a cancelled trip says so", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({ current: MARKTPLATZ, service: { cancelled: true } }),
    ]),
    "de:08212:1003",
  ).stopEvents;
  assert.equal(row.status, "cancelled");
});

test("a board keeps every pool's rows; demand-responsive buses are not read", () => {
  const board = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: MARKTPLATZ,
        service: {
          journeyRef: "ddb:90T01::H:j26:194",
          lineName: "RE 1",
          submode: "<trias:RailSubmode>local</trias:RailSubmode>",
        },
      }),
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
    "de:08212:1003",
  );
  assert.deepEqual(
    board.stopEvents.map(({ lineId, ptMode }) => [lineId, ptMode]),
    [
      ["RE 1", "regionalRail"],
      ["2", "tram"],
    ],
  );
});

test("rail splits by submode: S-Bahn and replacement stay light rail", () => {
  const modeOf = (submode: string) =>
    parseTriasStopEvents(
      triasStopEvents(RESPONDED_AT, [
        triasStopEvent({
          current: MARKTPLATZ,
          service: { submode: `<trias:RailSubmode>${submode}</trias:RailSubmode>` },
        }),
      ]),
      "de:08212:1003",
    ).stopEvents[0].ptMode;
  assert.equal(modeOf("suburbanRailway"), "lightRail");
  assert.equal(modeOf("replacementRailService"), "lightRail");
  assert.equal(modeOf("local"), "regionalRail");
  assert.equal(modeOf("regionalRail"), "regionalRail");
  assert.equal(modeOf("highSpeedRail"), "longDistanceRail");
  assert.equal(modeOf("interregionalRail"), "longDistanceRail");
});

test("a long-distance train is named by category and number", () => {
  const nameOf = (lineName: string, transportType: string, journeyNumber: string) =>
    parseTriasStopEvents(
      triasStopEvents(RESPONDED_AT, [
        triasStopEvent({
          current: MARKTPLATZ,
          service: {
            journeyRef: "ddb:98012::R:j26:138",
            lineName,
            submode: "<trias:RailSubmode>highSpeedRail</trias:RailSubmode>",
          },
          transportType,
          journeyNumber,
        }),
      ]),
      "de:08212:90",
    ).stopEvents[0].lineId;
  assert.equal(nameOf("12", "InterCityExpress", "377"), "ICE 377");
  assert.equal(nameOf("ICE 266 Baden-Kurier", "Baden-Kurier", "266"), "ICE 266");
  assert.equal(nameOf("TGD 9530", "TGV Duplex", "9530"), "TGV 9530");
});

test("a row states where its journey starts and ends, as stop points", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: MARKTPLATZ,
        service: {
          journeyRef: "ddb:920S3:D:R:j26:530",
          origin: "de:07334:1714:1:1",
          end: "de:08221:1160:2:2",
        },
      }),
    ]),
    "de:08212:90",
  ).stopEvents;
  assert.equal(row.originStopPointId, "de:07334:1714");
  assert.equal(row.destinationStopPointId, "de:08221:1160");
});

test("an estimate counts as a prediction only where the pool predicts", () => {
  const read = (journeyRef: string, departure: { timetabled: string; estimated: string }) =>
    parseTriasStopEvents(
      triasStopEvents(RESPONDED_AT, [
        triasStopEvent({ current: { ...MARKTPLATZ, departure }, service: { journeyRef } }),
      ]),
      "de:08212:1003",
    ).stopEvents[0];

  const soon = { timetabled: "2026-10-17T21:30:00Z", estimated: "2026-10-17T21:32:00Z" };
  const kvv = read("kvv:22305:E:R:s26:1762", soon);
  assert.equal(kvv.status, "realtime");
  assert.equal(kvv.isEstimatedToTheSecond, true);
  // Whole minutes outside the pools that state seconds.
  const ddb = read("ddb:920S3:D:R:j26:530", soon);
  assert.equal(ddb.delayMinutes, 2);
  assert.equal(ddb.isEstimatedToTheSecond, undefined);

  // `ddb:` states an estimate for tomorrow: the plan, not a prediction.
  const tomorrow = { timetabled: "2026-10-18T07:00:00Z", estimated: "2026-10-18T07:00:00Z" };
  assert.equal(read("ddb:920S3:D:R:j26:530", tomorrow).status, "scheduled");
  // `frb:` restates the timetable where it predicts nothing.
  const echo = { timetabled: "2026-10-17T21:30:00Z", estimated: "2026-10-17T21:30:00Z" };
  assert.equal(read("frb:11004:I:H:j26:1", echo).status, "scheduled");
  assert.equal(read("frb:11004:I:H:j26:1", soon).status, "realtime");
  assert.equal(read("kvv:22305:E:R:s26:1762", echo).status, "realtime");
});

test("an arrival board times its rows by the arrival", () => {
  const [row] = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [
      triasStopEvent({
        current: { ...KRONENPLATZ, departure: undefined },
        previous: [MARKTPLATZ],
      }),
    ]),
    "de:08212:1002",
    "arrival",
  ).stopEvents;
  assert.equal(row.timetabledDepartureTime, "2026-10-17T21:02:00.000Z");
  assert.equal(row.estimatedDepartureTime, "2026-10-17T21:06:12.000Z");
});

test("a stop with nothing due is an empty board; any other error is a failure", () => {
  const empty = parseTriasStopEvents(
    triasStopEvents(RESPONDED_AT, [], "STOPEVENT_LOCATIONUNSERVED"),
    "de:08212:1003",
  );
  assert.deepEqual(empty.stopEvents, []);
  assert.deepEqual(
    parseTriasStopEvents(
      triasStopEvents(RESPONDED_AT, [], "STOPEVENT_NOEVENTFOUND"),
      "de:08212:1003",
    ).stopEvents,
    [],
  );
  assert.throws(
    () =>
      parseTriasStopEvents(
        triasStopEvents(RESPONDED_AT, [], "STOPEVENT_DATEOUTOFRANGE"),
        "de:08212:1003",
      ),
    TriasError,
  );
  assert.throws(() => parseTriasStopEvents("<html>502</html>", "de:08212:1003"), TriasError);
});

const JOURNEY: DatedJourneyRef = {
  journeyRef: "kvv:22305:E:R:s26:1762",
  operatingDayRef: "2026-10-17",
};
const ROW_CALL: RowCallRef = {
  stopPointId: "de:08212:1002",
  timetabledTime: "2026-10-17T21:02:30.000Z",
};

test("a trip marks the call its row was read at", () => {
  const journey = parseTriasTripInfo(
    triasTripInfo(RESPONDED_AT, { previous: [MARKTPLATZ, KRONENPLATZ], onward: [PFORZHEIM] }),
    JOURNEY,
    ROW_CALL,
  );
  assert.deepEqual(
    journey.calls.map(({ stopPointId, isThisCall }) => [stopPointId, isThisCall]),
    [
      ["de:08212:1003", undefined],
      ["de:08212:1002", true],
      ["de:08231:50", undefined],
    ],
  );
  assert.equal(journey.serverTime, RESPONDED_AT);
  assert.equal(journey.status, undefined);
});

test("a trip answered for another journey, or with an error code, was not found", () => {
  assert.throws(
    () =>
      parseTriasTripInfo(
        triasTripInfo(RESPONDED_AT, {
          previous: [MARKTPLATZ],
          service: { journeyRef: "kvv:22305:E:R:s26:9" },
        }),
        JOURNEY,
      ),
    /nicht gefunden/,
  );
  assert.throws(
    () =>
      parseTriasTripInfo(
        triasReply(
          RESPONDED_AT,
          "<trias:TripInfoResponse><trias:ErrorMessage><trias:Code>ERROR_INVALID_JOURNEY_REF</trias:Code></trias:ErrorMessage></trias:TripInfoResponse>",
        ),
        JOURNEY,
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
      stopPointId: "de:08212:1004",
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
  assert.throws(() => parseTriasStopEvents(mixed, "de:08212:1003"), TriasError);
});

test("a board's situations read on their own, in the operator's terms", () => {
  const reply = triasStopEvents(RESPONDED_AT, [], undefined, [
    triasSituation({
      number: "100004399_KVV_ICSKVV",
      version: "7",
      summary: "Karlsruhe: Bauarbeiten im VBK-Netz",
      description: "Linien: S2, 001, SEV",
      detail: "&lt;p&gt;Gleiserneuerung&lt;br /&gt;Phase 3&lt;/p&gt;",
      start: "2026-09-21T01:30:00Z",
      end: "2026-10-24T04:45:59Z",
      lineRefs: ["kvv:21001:E:H:", "kvv:21001:E:R:", "kvv:21001:E:H:"],
    }),
    triasSituation({ summary: "Defektes Stellwerk", priority: "-1" }),
  ]);

  assert.deepEqual(parseTriasSituations(reply), [
    {
      id: "100004399_KVV_ICSKVV@7",
      title: "Karlsruhe: Bauarbeiten im VBK-Netz",
      listedLineNumbers: ["S2", "1", "SEV"],
      lineRefs: ["kvv:21001:E:H:", "kvv:21001:E:R:"],
      affectedStops: [],
      details: ["Gleiserneuerung", "Phase 3"],
      validFrom: "2026-09-21T01:30:00.000Z",
      validUntil: "2026-10-24T04:45:59.000Z",
      priority: 3,
    },
    {
      id: "trias:Defektes Stellwerk",
      title: "Defektes Stellwerk",
      listedLineNumbers: [],
      lineRefs: [],
      affectedStops: [],
      details: [],
      validFrom: undefined,
      validUntil: undefined,
      priority: -1,
    },
  ]);
  // The board itself carries none of it.
  assert.equal("notices" in parseTriasStopEvents(reply, "de:08212:1003"), false);
});
