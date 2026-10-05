import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { parseDepartureBoardResponse } from "../src/data/kvv-efa-parsers.ts";

function boardPayload() {
  return {
    departureList: [
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "0" },
        servingLine: { motType: "4", symbol: "3", number: "3", direction: "Rintheim" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "2" },
        servingLine: { motType: "6", symbol: "SEV", number: "SEV", direction: "Bruchsal" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "5" },
        servingLine: { motType: "0", number: "ICE 106", symbol: "", direction: "Hamburg-Altona" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "9" },
        servingLine: { motType: "7", symbol: "N1912", number: "N1912", direction: "Berlin" },
      },
    ],
    servingLines: {
      lines: [
        { mode: { type: "4", number: "3", diva: { stateless: "kvv:21003:E:H:s26" } } },
        { mode: { type: "7", number: "N1912", diva: { stateless: "kvv:flix:N1912:H:s26" } } },
      ],
    },
  };
}

test("a board keeps the local network and leaves long-distance rail and coaches out", () => {
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(
    board.departures.map((departure) => departure.lineId),
    ["3", "SEV"],
  );
});

test("long-distance serving directions are not recorded as directions to go and read", () => {
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(board.servingLines, [
    { lineId: "3", directionId: "kvv:21003:E:H:s26", transportMode: "tram" },
  ]);
});

/**
 * Hauptbahnhof rail as the feed pools it: KVV's S-Bahn under `kvv`, DB's S-Bahn Rhein-Neckar under
 * `ddb`, rail replacement under `rab` beside the city buses.
 */
function railBoardPayload() {
  return {
    departureList: [
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "9", day: "5", hour: "10", minute: "0" },
        servingLine: {
          motType: "1",
          symbol: "S4",
          number: "S4",
          direction: "Öhringen",
          stateless: "kvv:22304:E:H:s26",
        },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "9", day: "5", hour: "10", minute: "4" },
        servingLine: {
          motType: "1",
          symbol: "S6",
          number: "S6",
          direction: "Mannheim, Hauptbahnhof",
          stateless: "ddb:92V06: :H:j26",
        },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "9", day: "5", hour: "10", minute: "8" },
        servingLine: {
          motType: "6",
          symbol: "SEV RE7",
          number: "SEV RE7",
          direction: "Mannheim",
          stateless: "rab:34882: :H:26a",
        },
      },
    ],
    servingLines: {
      lines: [
        { mode: { type: "1", symbol: "S4", diva: { stateless: "kvv:22304:E:H:s26" } } },
        { mode: { type: "1", symbol: "S6", diva: { stateless: "ddb:92V06: :H:j26" } } },
        { mode: { type: "6", symbol: "SEV RE7", diva: { stateless: "rab:34882: :H:26a" } } },
      ],
    },
  };
}

test("a board keeps the operator's own S-Bahn and leaves the DB-pooled rail and its replacement out", () => {
  // The S6 shares the Stadtbahn's motType 1 and rail replacement the buses' 6; only the pool
  // decides.
  const board = parseDepartureBoardResponse(railBoardPayload(), "7000090");

  assert.deepEqual(
    board.departures.map((departure) => departure.lineId),
    ["S4"],
  );
});

test("DB-pooled serving directions are not recorded as directions to go and read", () => {
  const board = parseDepartureBoardResponse(railBoardPayload(), "7000090");

  assert.deepEqual(board.servingLines, [
    { lineId: "S4", directionId: "kvv:22304:E:H:s26", transportMode: "lightRail" },
  ]);
});

test("a rail line that states no pool is unknown, not foreign", () => {
  const board = parseDepartureBoardResponse(
    {
      departureList: [
        {
          stopID: "7000090",
          dateTime: { year: "2026", month: "9", day: "5", hour: "10", minute: "0" },
          servingLine: { motType: "1", symbol: "S2", number: "S2", direction: "Spöck" },
        },
      ],
    },
    "7000090",
  );

  assert.deepEqual(
    board.departures.map((departure) => departure.lineId),
    ["S2"],
  );
});

test("the departure monitor asks for tram, Stadtbahn and bus only", async () => {
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

  await client.fetchDepartureBoard("7000090");

  const parameters = requestedUrl?.searchParams;
  assert.equal(parameters?.get("includedMeans"), "checkbox");
  assert.equal(parameters?.get("std3_commonMacro"), "dm");
  assert.equal(parameters?.get("std3_inclMOT_1Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_4Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_5Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_0Macro"), null);
});

test("the row cap is sent under both names the endpoint knows", async () => {
  // `limit` only applies before the mode macros; `depSequence` holds either way, so both are sent.
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

  await client.fetchDepartureBoard("7000090", { limit: 6 });

  assert.equal(requestedUrl?.searchParams.get("depSequence"), "6");
  assert.equal(requestedUrl?.searchParams.get("limit"), "6");

  // A cap of one returns nothing, so it is never asked.
  await client.fetchDepartureBoard("7000090", { limit: 1 });
  assert.equal(requestedUrl?.searchParams.get("depSequence"), "2");
});

test("a board asked for named line-directions is not asked for the mode macros as well", async () => {
  // A line filter makes the mode macros redundant, and they would make the monitor ignore the cap
  // and return every row's sequence.
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

  await client.fetchDepartureBoard("7000090", { lineIds: ["kvv:21012:E:H:s26"] });

  assert.equal(requestedUrl?.searchParams.get("std3_commonMacro"), null);
  assert.equal(requestedUrl?.searchParams.get("includedMeans"), null);
  assert.deepEqual(requestedUrl?.searchParams.getAll("line"), ["kvv:21012:E:H:s26"]);
  // The cap holds on this form.
  assert.equal(requestedUrl?.searchParams.get("limit"), "20");
});

test("a stop names each line-direction it knows under the line's own name", () => {
  // Direction ids are opaque; the stop's pairing names their line.
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(board.servingLines, [
    { lineId: "3", directionId: "kvv:21003:E:H:s26", transportMode: "tram" },
  ]);
});
