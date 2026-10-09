import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { parseDepartureBoardResponse, parseTripResponse } from "../src/data/kvv-efa-parsers.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";
import type { KvvTripLocator } from "../src/data/kvv-efa-parsers.ts";

test("tomorrow's reused S7 code never replaces or refreshes today's active run", async (t) => {
  const fixture = JSON.parse(
    readFileSync(new URL("./support/s7-date-reuse.json", import.meta.url), "utf8"),
  );
  let now = Date.parse("2026-10-07T13:42:45Z");
  t.mock.method(Date, "now", () => now);
  const today = parseDepartureBoardResponse(fixture[14], "7000006");
  const tomorrow = parseDepartureBoardResponse(fixture[340], "7001011", "arrival");
  const requests: KvvTripLocator[] = [];
  const client = new KvvEfaClient();
  client.fetchDepartureBoard = async (_stop, options) => {
    if (options?.eventKind === "arrival") {
      now += 1_000;
      return tomorrow;
    }
    return today;
  };
  client.fetchTrip = async (locator) => {
    requests.push(locator);
    return locator.date === "20261008"
      ? parseTripResponse(fixture[363], locator)
      : { serverTime: new Date(now).toISOString(), tripCalls: today.departures[0].tripCalls ?? [] };
  };
  const source = new KvvTransitSource(client);
  const board = await source.getDepartureBoard("gottesauer-platz");
  const active = board.departures[0];
  const discovery = await source.getRunDiscoveryReading(
    [{ stopId: "marktplatz", eventKind: "arrival" }],
    {
      maxAgeMs: 0,
      runMaxAgeMs: 60_000,
      topologyMaxAgeMs: 0,
      horizonMs: 110_000,
    },
  );
  assert.equal(discovery.runDepartures.length, 0, "tomorrow's row does not acquire today's calls");
  const mixed = await source.getRunDiscoveryReading(
    [
      { stopId: "gottesauer-platz", eventKind: "departure" },
      { stopId: "marktplatz", eventKind: "arrival" },
    ],
    { maxAgeMs: 0, runMaxAgeMs: 60_000, topologyMaxAgeMs: 0, horizonMs: 110_000 },
  );
  assert.deepEqual(
    mixed.runDepartures.map((run) => run.id),
    [active.id],
  );
  now += 40_000;
  const refreshed = await source.getRun(active.id, 30_000);
  assert.equal(refreshed?.tripInstanceId, active.tripInstanceId);
  assert.equal(requests[0]?.date, "20261007");
  assert.ok(requests.every((request) => request.date === "20261007"));
});

const at = { year: "2026", month: "10", day: "5", hour: "14", minute: "02" };
const row = {
  stopID: "7000064",
  nameWO: "Arbeitsagentur",
  countdown: "2",
  dateTime: at,
  platform: "2",
  x: "8.431542",
  y: "49.007335",
  servingLine: {
    key: "10",
    symbol: "6",
    number: "6",
    direction: "Arbeitsagentur",
    motType: "4",
    stateless: "kvv:21006:E:H:s26",
  },
  attrs: [{ name: "RealtimeTripId", value: "six-inbound" }],
  prevStopSeq: {
    nameWO: "ZKM",
    ref: { id: "7000065", depDateTimeSec: "20261005 14:00:00", depValid: "1" },
  },
};

test("arrival parsing accepts array and singleton rows without inventing a departure at the terminus", () => {
  for (const arrivalList of [[row], row]) {
    const parsed = parseDepartureBoardResponse({ arrivalList }, "7000064", "arrival");
    assert.equal(parsed.departures.length, 1);
    const final = parsed.departures[0].tripCalls?.at(-1);
    assert.equal(final?.scheduledArrivalTime, "2026-10-05T12:02:00.000Z");
    assert.equal(final?.scheduledDepartureTime, undefined);
    assert.equal(final?.latitude, 49.007335);
    assert.equal(final?.longitude, 8.431542);
  }
  for (const arrivalList of [undefined, null, {}, [null, { servingLine: {} }]])
    assert.equal(
      parseDepartureBoardResponse({ arrivalList }, "7000064", "arrival").departures.length,
      0,
    );
  assert.equal(
    parseDepartureBoardResponse({ departureList: [row] }, "7000064", "arrival").departures.length,
    0,
  );
});

test("arrival discovery shares one trip read with departure discovery and never answers a passenger board", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T12:00:00Z") });
  let tripReads = 0;
  const requested: URL[] = [];
  const client = new KvvEfaClient({
    fetchFn: async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.pathname.endsWith("XML_TRIPSTOPTIMES_REQUEST")) {
        tripReads += 1;
        return Response.json({
          parameters: [{ name: "serverTime", value: "2026-10-05T14:00:00" }],
          vehicleCallAtStop: { tC: "10", line: "kvv:21006:E:H:s26", stopID: "7000064" },
          stopSeq: [
            row.prevStopSeq,
            {
              nameWO: "Arbeitsagentur",
              ref: {
                id: "7000064",
                arrDateTimeSec: "20261005 14:02:00",
                depDateTimeSec: "20261005 14:03:00",
                arrValid: "1",
                depValid: "1",
              },
            },
          ],
        });
      }
      const arrival = url.searchParams.get("itdDateTimeDepArr") === "arr";
      return Response.json({
        parameters: [{ name: "serverTime", value: "2026-10-05T14:00:00" }],
        [arrival ? "arrivalList" : "departureList"]: [
          arrival ? row : { ...row, dateTime: { ...at, minute: "03" }, countdown: "3" },
        ],
      });
    },
  });
  const source = new KvvTransitSource(client);
  const reading = await source.getRunDiscoveryReading(
    [
      { stopId: "arbeitsagentur", eventKind: "arrival" },
      { stopId: "arbeitsagentur", eventKind: "departure" },
    ],
    { maxAgeMs: 90_000, runMaxAgeMs: 0, topologyMaxAgeMs: 300_000, horizonMs: 110_000 },
  );
  assert.equal(reading.runDepartures.length, 1);
  assert.equal(tripReads, 1);
  assert.equal(reading.failedStopIds.length, 0);
  const departures = await source.getDepartureBoard("arbeitsagentur");
  assert.equal(departures.departures[0].scheduledDepartureTime, "2026-10-05T12:03:00.000Z");
  assert.ok(!departures.departures[0].id.startsWith("arrival:"));
  assert.ok(requested.some((url) => url.searchParams.get("itdDateTimeDepArr") === "arr"));
});

test("a crowded board discovers a rail direction named only in serving metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T12:00:00Z") });
  const sparseDirection = "kvv:22304:E:H:s26";
  const requests: URL[] = [];
  const client = new KvvEfaClient({
    fetchFn: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("XML_TRIPSTOPTIMES_REQUEST"))
        return Response.json({
          vehicleCallAtStop: {
            tC: url.searchParams.get("tripCode"),
            line: url.searchParams.get("line"),
            stopID: "7000064",
          },
          stopSeq: [
            row.prevStopSeq,
            {
              nameWO: "Arbeitsagentur",
              ref: {
                id: "7000064",
                arrDateTimeSec: "20261005 14:02:00",
                arrValid: "1",
                depValid: "0",
              },
            },
          ],
        });
      const onlySparse =
        url.searchParams.getAll("line").length === 1 &&
        url.searchParams.get("line") === sparseDirection;
      return Response.json({
        parameters: [{ name: "serverTime", value: "2026-10-05T14:00:00" }],
        servingLines: {
          lines: [
            { mode: { type: "4", number: "6", diva: { stateless: row.servingLine.stateless } } },
            { mode: { type: "1", number: "S4", diva: { stateless: sparseDirection } } },
          ],
        },
        departureList: onlySparse
          ? [
              {
                ...row,
                servingLine: {
                  ...row.servingLine,
                  key: "11",
                  symbol: "S4",
                  number: "S4",
                  motType: "1",
                  stateless: sparseDirection,
                },
                attrs: [],
              },
            ]
          : Array.from({ length: 20 }, () => row),
      });
    },
  });
  const source = new KvvTransitSource(client);
  const reading = await source.getRunDiscoveryReading(
    [{ stopId: "arbeitsagentur", eventKind: "departure" }],
    { maxAgeMs: 0, runMaxAgeMs: 0, topologyMaxAgeMs: 0, horizonMs: 110_000 },
  );
  assert.ok(
    requests.some(
      (url) =>
        url.searchParams.getAll("line").length === 1 &&
        url.searchParams.get("line") === sparseDirection,
    ),
  );
  assert.ok(reading.runDepartures.some((run) => run.lineId === "S4"));
  assert.ok(
    requests
      .filter((url) => url.pathname.endsWith("XSLT_DM_REQUEST"))
      .every((url) => url.searchParams.get("limit") === "20"),
  );
});
